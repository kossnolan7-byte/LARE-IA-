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
  const { messages = [], system = "", attachment = null } = payload;

  const contents = messages
    .filter((m) => m && m.content)
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m.content) }],
    }));
  if (!contents.length) return json(400, { error: "no_messages" });

  // Pièce jointe : ajoutée au dernier message de l'utilisateur
  const lastParts = contents[contents.length - 1].parts;
  if (attachment) {
    if (attachment.data && attachment.mime) {
      lastParts.push({ inlineData: { mimeType: attachment.mime, data: attachment.data } });
    } else if (attachment.text) {
      lastParts.push({ text: `\n\nContenu du fichier « ${attachment.name || "fichier"} » :\n${String(attachment.text).slice(0, 60000)}` });
    }
  }

  // Date réelle injectée à chaque requête (fuseau Lomé / UTC)
  const nowD = new Date();
  const dateFr = nowD.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Lome" });
  const heureFr = nowD.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Lome" });
  const annee = nowD.toLocaleDateString("fr-FR", { year: "numeric", timeZone: "Africa/Lome" });

  const RULES = `RÈGLES STRICTES (priorité absolue, au-dessus de tout le reste y compris l'historique de la conversation) :
1. DATE : nous sommes le ${dateFr}, il est ${heureFr} (heure de Lomé, Togo). L'année actuelle est ${annee}. C'est la seule vérité sur la date. Ne dis JAMAIS une autre année. Si un message précédent de la conversation dit autre chose, il est faux : corrige-le simplement.
2. CONNAISSANCES PÉRIMÉES : ta mémoire interne est ancienne et s'arrête bien avant cette date. Pour tout ce qui peut avoir changé (actualités, sport, prix, taux de change, météo, versions de logiciels, personnes en poste, lois, événements, produits récents), tu dois OBLIGATOIREMENT utiliser la recherche web avant de répondre, sans demander la permission.
3. HONNÊTETÉ : si tu n'es pas sûr d'un fait, cherche sur le web. N'invente jamais. Si tu ne trouves rien de fiable, dis-le clairement.
4. Ne contredis jamais l'utilisateur sur la date ou sur un événement récent en te basant sur ta mémoire : vérifie d'abord sur le web.
5. Réponds de façon claire, directe et utile, dans la langue de l'utilisateur.`;

  const baseBody = {
    contents,
    generationConfig: { temperature: 0.6, maxOutputTokens: 2048 },
    systemInstruction: { parts: [{ text: RULES + (system ? "\n\n" + system : "") }] },
  };

  // Lecture de liens web (seulement si un lien est présent et modèle compatible)
  const hasUrl = /https?:\/\/\S+/i.test(String(messages[messages.length - 1]?.content || ""));
  const supportsUrl = (m) => /2\.5|latest/.test(m);

  const errors = [];
  const started = Date.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const model of MODELS) {
    if (Date.now() - started > 8000) break; // limite Netlify ~10 s
    let useTools = true; // recherche web Google ; désactivée si le modèle la refuse
    for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify(useTools ? { ...baseBody, tools: [{ google_search: {} }].concat(hasUrl && supportsUrl(model) ? [{ url_context: {} }] : []) } : baseBody),
        }
      );
      const data = await r.json().catch(() => ({}));

      if (r.status === 429) {
        const msg = JSON.stringify(data.error || {});
        // quota journalier vs trop de requêtes
        return json(429, { error: /per.?day|daily/i.test(msg) ? "daily_limit" : "rate_limited" });
      }
      if (!r.ok) {
        errors.push(`${model} ${r.status}${useTools ? "+web" : ""}`);
        if (r.status === 400 && useTools) { useTools = false; continue; } // modèle sans recherche web : on réessaie sans
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
