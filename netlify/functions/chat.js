// Fonction Netlify : relais entre le site et l'API Gemini (clé gardée côté serveur)
const MODELS = [
  process.env.GEMINI_MODEL,
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
  "gemini-flash-latest",
  "gemini-flash-lite-latest",
].filter(Boolean);

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return json(500, { error: "missing_api_key", detail: "GEMINI_API_KEY absente dans Netlify (Site settings > Environment variables)" });

  let payload;
  try { payload = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "bad_json" }); }
  const { messages = [], system = "" } = payload;

  const contents = messages
    .filter((m) => m && m.content)
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m.content) }],
    }));
  if (!contents.length) return json(400, { error: "no_messages" });

  const body = {
    contents,
    generationConfig: { temperature: 0.8, maxOutputTokens: 2048 },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  const errors = [];
  const started = Date.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const model of MODELS) {
    if (Date.now() - started > 8000) break; // limite Netlify ~10 s
    for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify(body),
        }
      );
      const data = await r.json().catch(() => ({}));

      if (r.status === 429) {
        const msg = JSON.stringify(data.error || {});
        // quota journalier vs trop de requêtes
        return json(429, { error: /per.?day|daily/i.test(msg) ? "daily_limit" : "rate_limited" });
      }
      if (!r.ok) {
        errors.push(`${model} ${r.status}`);
        if (r.status === 503 || r.status === 500) { await sleep(700); continue; } // surcharge : on réessaie
        break; // 404/400/403... : modèle suivant
      }

      const parts = data.candidates?.[0]?.content?.parts || [];
      const reply = parts.map((p) => p.text || "").join("").trim();
      if (!reply) {
        errors.push(`${model} vide`);
        break;
      }
      return json(200, { reply });
    } catch (e) {
      errors.push(`${model} ${e.message}`);
      break;
    }
    }
  }
  return json(502, { error: "upstream_error", detail: "Gemini surchargé ou indisponible (" + errors.join(", ") + "). Réessayez." });
};
