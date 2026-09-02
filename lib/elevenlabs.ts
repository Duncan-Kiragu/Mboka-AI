/**
 * ElevenLabs helpers — speech-to-text and text-to-speech.
 *
 * Owned by P2. Call these from anywhere (web routes, call routes); do not
 * duplicate the fetch calls. Every failure comes back as an ElevenLabsError
 * with a `status` the route can pass straight to res.status().
 */

const STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const DEFAULT_VOICE_ID = "ijKilL5CnjXKMWDHOJH8";

function voiceId(): string {
  return process.env.ELEVENLABS_VOICE_ID?.trim() || DEFAULT_VOICE_ID;
}

function ttsUrl(): string {
  return `https://api.elevenlabs.io/v1/text-to-speech/${voiceId()}`;
}

const STT_MODEL = "scribe_v2";

/** eleven_v3 does Swahili; multilingual_v2 does not list it but is the safety net. */
const TTS_ATTEMPTS: Array<{ model_id: string; language_code?: string }> = [
  { model_id: "eleven_v3", language_code: "sw" },
  { model_id: "eleven_multilingual_v2" },
];

export class ElevenLabsError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ElevenLabsError";
    this.status = status;
  }
}

export function hasApiKey(): boolean {
  return Boolean(readApiKey());
}

/** Strip copy-paste junk Render/.env often leave on the secret. */
function readApiKey(): string {
  let key = (process.env.ELEVENLABS_API_KEY || "").replace(/^\uFEFF/, "").trim();
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1).trim();
  }
  return key.replace(/^Bearer\s+/i, "").replace(/^xi-api-key\s*[:=]\s*/i, "").trim();
}

function requireApiKey(): string {
  const key = readApiKey();
  if (!key) {
    throw new ElevenLabsError("Server is missing ELEVENLABS_API_KEY.", 500);
  }
  return key;
}

function voiceFailure(kind: "stt" | "tts", status: number): ElevenLabsError {
  if (status === 401 || status === 403) {
    return new ElevenLabsError(
      "ElevenLabs rejected the API key. In Render: Environment → ELEVENLABS_API_KEY, paste a key from elevenlabs.io (no quotes), then restart.",
      401
    );
  }
  if (kind === "stt") {
    return new ElevenLabsError("Transcription failed. Try recording again.", 502);
  }
  return new ElevenLabsError(
    "Could not generate confirmation audio. You can still confirm the listing.",
    502
  );
}

/** ElevenLabs picks the decoder off the filename, so give it a real extension. */
export function filenameForMime(mimeType: string): string {
  if (mimeType.includes("mp4") || mimeType.includes("m4a") || mimeType.includes("aac")) {
    return "recording.m4a";
  }
  if (mimeType.includes("ogg")) return "recording.ogg";
  if (mimeType.includes("wav")) return "recording.wav";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "recording.mp3";
  return "recording.webm";
}

/** Audio bytes → transcript. Throws ElevenLabsError; never returns null. */
export async function transcribe(audio: Buffer, mimeType = "audio/webm"): Promise<string> {
  const apiKey = requireApiKey();
  if (!audio.length) {
    throw new ElevenLabsError("Audio was empty. Record again and retry.", 400);
  }

  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(audio)], { type: mimeType }),
    filenameForMime(mimeType)
  );
  form.append("model_id", STT_MODEL);

  const res = await fetch(STT_URL, {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
  });

  const raw = await res.text();
  if (!res.ok) {
    console.error("ElevenLabs STT error", res.status, raw.slice(0, 500));
    throw voiceFailure("stt", res.status);
  }

  try {
    const parsed = JSON.parse(raw) as { text?: string };
    return parsed.text ?? "";
  } catch {
    throw new ElevenLabsError("Transcription failed. Try recording again.", 502);
  }
}

/** Text → mp3 bytes. Throws ElevenLabsError. */
export async function speak(text: string): Promise<Buffer> {
  const apiKey = requireApiKey();
  const clean = text.trim();
  if (!clean) {
    throw new ElevenLabsError("Nothing to speak.", 400);
  }

  for (const attempt of TTS_ATTEMPTS) {
    const res = await fetch(ttsUrl(), {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: clean,
        model_id: attempt.model_id,
        ...(attempt.language_code ? { language_code: attempt.language_code } : {}),
      }),
    });

    if (res.ok) return Buffer.from(await res.arrayBuffer());

    const body = await res.text();
    console.error("ElevenLabs TTS error", attempt.model_id, res.status, body.slice(0, 500));
    // A bad key will not get better on the fallback model.
    if (res.status === 401 || res.status === 403) {
      throw voiceFailure("tts", res.status);
    }
  }

  throw voiceFailure("tts", 502);
}

/** mp3 bytes → data URL, so a narration can ride on the listing JSON (no disk on Render). */
export function toDataUrl(audio: Buffer, mimeType = "audio/mpeg"): string {
  return `data:${mimeType};base64,${audio.toString("base64")}`;
}
