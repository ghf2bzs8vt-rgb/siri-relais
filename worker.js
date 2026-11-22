const MODELS = ["openai/gpt-oss-120b", "qwen/qwen3.6-27b", "openai/gpt-oss-20b"];
const SITE = "https://ghf2bzs8vt-rgb.github.io";

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

    let messages = Array.isArray(body.messages) ? body.messages.slice(-40) : [];
    messages = messages
      .filter(m => m && typeof m.content === "string" && ["system", "user", "assistant"].includes(m.role))
      .map(m => ({ role: m.role, content: m.content.slice(0, 16000) }));
    if (!messages.length) return json({ error: "Message vide" }, 400);

    let last = "";
    for (const model of MODELS) {
      try {
        const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + env.GROQ_KEY
          },
          body: JSON.stringify({ model, messages, max_completion_tokens: 1500, temperature: 0.7 })
        });
        const j = await r.json();
        const a = ((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "")
          .replace(/<think>[\s\S]*?<\/think>/g, "").trim();
        if (a) return json({ reply: a });
        last = model + ": " + JSON.stringify(j).slice(0, 200);
      } catch (e) {
        last = model + ": " + e.message;
      }
    }
    return json({ error: last }, 502);
  }
};
