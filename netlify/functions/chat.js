// Fonction Netlify : relaie les messages de LARE vers Gemini (offre gratuite).
// Variables d'environnement Netlify :
//   GEMINI_API_KEY  (obligatoire)
//   GEMINI_MODEL    (optionnel, défaut ci-dessous)
//   DAILY_LIMIT     (optionnel, messages par personne et par jour, défaut 30)

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || "30", 10);
const hits = new Map(); // limite "au mieux" : la mémoire se réinitialise quand la fonction redémarre

const json = (statusCode, obj) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(obj),
});

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });
  if (!process.env.GEMINI_API_KEY) return json(500, { error: "missing_key" });

  const ip =
    event.headers["x-nf-client-connection-ip"] ||
    (event.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    "inconnu";
  const day = new Date().toISOString().slice(0, 10);
  const rec = hits.get(ip);
  if (!rec || rec.day !== day) hits.set(ip, { day, count: 1 });
  else if (++rec.count > DAILY_LIMIT) return json(429, { error: "daily_limit" });
  if (hits.size > 5000) hits.clear();

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "bad_json" }); }

  const system = String(body.system || "").slice(0, 8000);
  const messages = (Array.isArray(body.messages) ? body.messages : []).slice(-20);
  const contents = messages
    .filter((m) => m && typeof m.content === "string" && m.content.trim())
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content.slice(0, 4000) }],
    }));
  if (!contents.length || contents[contents.length - 1].role !== "user")
    return json(400, { error: "no_user_message" });

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents,
          generationConfig: { maxOutputTokens: 1000, temperature: 0.7 },
        }),
      }
    );
    if (r.status === 429) return json(429, { error: "rate_limited" });
    if (!r.ok) {
      console.error("Gemini error", r.status, (await r.text()).slice(0, 500));
      return json(502, { error: "upstream" });
    }
    const data = await r.json();
    const reply = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("").trim();
    return json(200, { reply });
  } catch (e) {
    console.error(e);
    return json(502, { error: "upstream" });
  }
};
