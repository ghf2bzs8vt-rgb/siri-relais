const MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.6-27b"];
const SITE = "https://ghf2bzs8vt-rgb.github.io";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

function bytesToB64(u8) {
  let s = "";
  const k = 0x8000;
  for (let i = 0; i < u8.length; i += k) s += String.fromCharCode.apply(null, u8.subarray(i, i + k));
  return btoa(s);
}

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
