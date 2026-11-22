const MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.6-27b"];
const SITE = "https://ghf2bzs8vt-rgb.github.io";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

function b64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

async function groq(env, model, messages, maxTokens) {
  const payload = { model, messages, max_completion_tokens: maxTokens, temperature: 0.4 };
  if (model.startsWith("openai/gpt-oss")) payload.reasoning_effort = "low";
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + env.GROQ_KEY },
    body: JSON.stringify(payload)
  });
  const j = await r.json().catch(() => ({}));
  const a = ((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "")
    .replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  return { r, j, a };
}

async function prepPrompt(env, text, edit) {
  const sys =
    'Tu prépares une demande d\'image pour un modèle d\'IA. Réponds UNIQUEMENT par du JSON: {"ok":true,"prompt":"..."} ou {"ok":false}. ' +
    "Mets ok=false si la demande contient: nudité ou contenu sexuel; tout contenu sexuel ou suggestif impliquant un mineur ou une personne qui semble mineure; violence graphique ou gore; haine ou harcèlement; ou un montage d'une personne réelle dans un contexte humiliant ou sexuel. " +
    (edit
      ? "Sinon ok=true et prompt = l'instruction de modification d'une photo existante, traduite en anglais, courte et précise, comme un ordre d'édition."
      : "Sinon ok=true et prompt = la demande traduite en anglais et enrichie en une description d'image claire (sujet, style, lumière, détails), 80 mots maximum.");
  for (const model of ["openai/gpt-oss-20b", "openai/gpt-oss-120b"]) {
    try {
      const { a } = await groq(env, model, [{ role: "system", content: sys }, { role: "user", content: text }], 700);
      const m = a.match(/\{[\s\S]*\}/);
      if (!m) continue;
      const o = JSON.parse(m[0]);
      if (o.ok === false) return { ok: false };
      if (o.ok === true && typeof o.prompt === "string" && o.prompt.trim()) {
        return { ok: true, prompt: o.prompt.trim().slice(0, 1500) };
      }
    } catch (e) {}
  }
  return null;
}

async function handleImage(env, body, json) {
  const text = String(body.prompt || "").trim().slice(0, 600);
  if (!text) return json({ error: "Description vide" }, 400);
  const edit = typeof body.image === "string" && body.image.startsWith("data:image/");
  if (edit && body.image.length > 1500000) return json({ error: "Image trop lourde" }, 413);

  const prep = await prepPrompt(env, text, edit);
  if (!prep) return json({ error: "Vérification impossible, réessaie" }, 502);
  if (!prep.ok) return json({ refused: true });

  try {
    if (!edit) {
      const out = await env.AI.run("@cf/black-forest-labs/flux-1-schnell", { prompt: prep.prompt, steps: 4 });
      const b64 = out && out.image;
      if (!b64) return json({ error: "Pas d'image reçue: " + Object.keys(out || {}).join(",") }, 502);
      return json({ image: "data:image/jpeg;base64," + b64 });
    }
    const m = body.image.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
    if (!m) return json({ error: "Image invalide" }, 400);
    const w = clamp(parseInt(body.width) || 768, 256, 1536);
    const h = clamp(parseInt(body.height) || 768, 256, 1536);
    const form = new FormData();
    form.append("prompt", prep.prompt);
    form.append("input_image_0", b64ToBlob(m[2], m[1]), "photo");
    form.append("width", String(w));
    form.append("height", String(h));
    const fr = new Response(form);
    const out = await env.AI.run("@cf/black-forest-labs/flux-2-klein-4b", {
      multipart: { body: fr.body, contentType: fr.headers.get("content-type") }
    });
    const b64 = out && out.image;
    if (!b64) return json({ error: "Pas d'image reçue: " + Object.keys(out || {}).join(",") }, 502);
    return json({ image: "data:image/png;base64," + b64 });
  } catch (e) {
    return json({ error: String((e && e.message) || e).slice(0, 200) }, 502);
  }
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin") || "";
    const ok = origin === SITE;
    const cors = {
      "Access-Control-Allow-Origin": SITE,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    };
    const json = (o, s = 200) =>
      new Response(JSON.stringify(o), {
        status: s,
        headers: { ...cors, "Content-Type": "application/json" }
      });

    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST" || !ok) return json({ error: "Accès refusé" }, 403);

    let body;
    try { body = await req.json(); } catch { return json({ error: "Requête invalide" }, 400); }

    const path = new URL(req.url).pathname;
    if (path === "/image") return handleImage(env, body, json);

    const all = (Array.isArray(body.messages) ? body.messages : [])
      .filter(m => m && typeof m.content === "string" && ["system", "user", "assistant"].includes(m.role));
    const sys = all.filter(m => m.role === "system").slice(0, 1)
      .map(m => ({ role: "system", content: m.content.slice(0, 9000) }));
    const rest = all.filter(m => m.role !== "system").slice(-12)
      .map(m => ({
        role: m.role,
        content: m.role === "assistant" ? m.content.slice(0, 1200) : m.content.slice(0, 16000)
      }));
    const messages = [...sys, ...rest];
    if (!rest.length) return json({ error: "Message vide" }, 400);

    let last = "";
    for (const model of MODELS) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const payload = { model, messages, max_completion_tokens: 1200, temperature: 0.7 };
          if (model.startsWith("openai/gpt-oss")) payload.reasoning_effort = "low";
          const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": "Bearer " + env.GROQ_KEY
            },
            body: JSON.stringify(payload)
          });
          const j = await r.json().catch(() => ({}));
          const a = ((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "")
            .replace(/<think>[\s\S]*?<\/think>/g, "").trim();
          if (a) return json({ reply: a });
          last = model + " (" + r.status + "): " + JSON.stringify(j).slice(0, 200);
          if (r.status === 429 || r.status >= 500) {
            if (attempt === 0) {
              const ra = parseFloat(r.headers.get("retry-after")) || 2;
              await sleep(Math.min(ra, 4) * 1000);
              continue;
            }
          }
          break;
        } catch (e) {
          last = model + ": " + e.message;
          break;
        }
      }
    }
    return json({ error: last }, 502);
  }
};
