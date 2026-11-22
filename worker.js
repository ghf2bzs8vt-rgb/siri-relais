const MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "qwen/qwen3.6-27b"];
const SITE = "https://ghf2bzs8vt-rgb.github.io";
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
