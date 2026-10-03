// Fonction Netlify (v2) : réponse de LARE en streaming (mot par mot)
export const config = { path: "/api/chat-stream" };

const MODELS = [
  process.env.GEMINI_MODEL,
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
  "gemini-flash-latest",
].filter(Boolean);

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function textOf(evt) {
  const parts = evt?.candidates?.[0]?.content?.parts || [];
  return parts.filter((p) => !p.thought).map((p) => p.text || "").join("");
}

async function* sseTexts(body) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = block.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      try { const t = textOf(JSON.parse(line.slice(5).trim())); if (t) yield t; } catch (e) {}
    }
  }
}

export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return json(500, { error: "missing_api_key", detail: "GEMINI_API_KEY absente dans Netlify" });

  let payload;
  try { payload = await req.json(); } catch (e) { return json(400, { error: "bad_json" }); }
  const { messages = [], system = "", attachment = null } = payload;

  const contents = messages.filter((m) => m && m.content).map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: String(m.content) }],
  }));
  if (!contents.length) return json(400, { error: "no_messages" });

  const lastParts = contents[contents.length - 1].parts;
  if (attachment) {
    if (attachment.data && attachment.mime) lastParts.push({ inlineData: { mimeType: attachment.mime, data: attachment.data } });
    else if (attachment.text) lastParts.push({ text: `\n\nContenu du fichier « ${attachment.name || "fichier"} » :\n${String(attachment.text).slice(0, 60000)}` });
  }

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
  const hasUrl = /https?:\/\/\S+/i.test(String(messages[messages.length - 1]?.content || ""));

  const errors = [], quota = [];
  const started = Date.now();

  for (const model of MODELS) {
    if (Date.now() - started > 8000) break;
    let useTools = true;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const tools = useTools
          ? [{ google_search: {} }].concat(hasUrl && /2\.5|latest/.test(model) ? [{ url_context: {} }] : [])
          : null;
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": key },
            body: JSON.stringify(tools ? { ...baseBody, tools } : baseBody),
          }
        );

        if (!r.ok) {
          const data = await r.json().catch(() => ({}));
          if (r.status === 429) {
            const daily = /per.?day|daily/i.test(JSON.stringify(data.error || {}));
            errors.push(`${model} 429${useTools ? "+web" : ""}${daily ? " (quota jour)" : ""}`);
            quota.push(daily);
            if (useTools) { useTools = false; continue; }
            break;
          }
          errors.push(`${model} ${r.status}${useTools ? "+web" : ""}`);
          if (r.status === 400 && useTools) { useTools = false; continue; }
          if (r.status === 503 || r.status === 500) { await sleep(700); continue; }
          break;
        }

        const it = sseTexts(r.body)[Symbol.asyncIterator]();
        const first = await it.next();
        if (first.done) { errors.push(`${model} vide`); break; }

        const enc = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            try {
              controller.enqueue(enc.encode(first.value));
              while (true) {
                const n = await it.next();
                if (n.done) break;
                controller.enqueue(enc.encode(n.value));
              }
            } catch (e) {}
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
        });
      } catch (e) {
        errors.push(`${model} ${e.message}`);
        break;
      }
    }
  }

  if (quota.length && !errors.some((e) => !/429/.test(e) && !/503|500|400/.test(e))) {
    return json(429, { error: quota.every(Boolean) ? "daily_limit" : "rate_limited", detail: errors.join(", ") });
  }
  return json(502, { error: "upstream_error", detail: "Gemini surchargé ou indisponible (" + errors.join(", ") + "). Réessayez." });
};
