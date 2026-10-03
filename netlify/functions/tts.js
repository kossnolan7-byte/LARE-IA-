// Fonction Netlify : synthèse vocale réaliste via Gemini TTS (même clé que le chat)
const MODELS = [
  process.env.GEMINI_TTS_MODEL,
  "gemini-2.5-flash-preview-tts",
  "gemini-2.5-pro-preview-tts",
].filter(Boolean);

// Consigne de style (non prononcée). Modifiable dans Netlify : variable TTS_STYLE
const STYLE = process.env.TTS_STYLE ||
  "Parle en français avec un accent ouest-africain (Togo), de façon naturelle, posée et chaleureuse, comme au téléphone";

const VOICES = ["Charon", "Orus", "Algieba", "Puck", "Fenrir", "Iapetus", "Kore", "Aoede", "Leda", "Zephyr"];

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// Enveloppe PCM 16 bits mono dans un fichier WAV lisible par le navigateur
function pcmToWav(pcm, rate) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return json(405, { error: "method_not_allowed" });
  const key = process.env.GEMINI_API_KEY;
  if (!key) return json(500, { error: "missing_api_key" });

  let p;
  try { p = JSON.parse(event.body || "{}"); } catch (e) { return json(400, { error: "bad_json" }); }
  const text = String(p.text || "").trim().slice(0, 700);
  const voice = VOICES.includes(p.voice) ? p.voice : "Charon";
  if (!text) return json(400, { error: "no_text" });

  const body = {
    contents: [{ parts: [{ text: `${STYLE} : ${text}` }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  };

  const errors = [];
  for (const model of MODELS) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { errors.push(`${model} ${r.status}`); continue; }
      const part = (data.candidates?.[0]?.content?.parts || []).find((x) => x.inlineData);
      if (!part) { errors.push(`${model} vide`); continue; }
      const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType || "")?.[1]) || 24000;
      const wav = pcmToWav(Buffer.from(part.inlineData.data, "base64"), rate);
      return json(200, { audio: wav.toString("base64") });
    } catch (e) {
      errors.push(`${model} ${e.message}`);
    }
  }
  return json(502, { error: "tts_failed", detail: errors.join(", ") });
};
