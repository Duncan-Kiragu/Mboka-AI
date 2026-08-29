/**
 * Mboka AI — one Express process serves the API and public/index.html.
 *
 * Routes:
 *   GET  /health
 *   GET  /listings
 *   GET  /listings/:id
 *   POST /listings
 *   PATCH /listings/:id     { status: "sold" } or field edits
 *   POST /transcribe        { audio, mimeType } → { transcript }
 *   POST /speak             { text } → audio/mpeg
 *
 * Storage is an in-memory array (resets on every Render sleep/redeploy).
 * Swap `listings` for a database later without changing the JSON shape.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response } from "express";
import { store } from "./lib/store";

if (existsSync(".env")) {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ELEVENLABS_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const ELEVENLABS_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";
const ELEVENLABS_TTS_URL = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`;

function requireApiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY?.trim();
  if (!key) {
    throw new Error("ELEVENLABS_API_KEY is not set");
  }
  return key;
}

function filenameForMime(mimeType: string): string {
  if (mimeType.includes("mp4") || mimeType.includes("m4a") || mimeType.includes("aac")) {
    return "recording.m4a";
  }
  if (mimeType.includes("ogg")) return "recording.ogg";
  if (mimeType.includes("wav")) return "recording.wav";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "recording.mp3";
  return "recording.webm";
}

const app = express();
app.use(express.json({ limit: "15mb" }));

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    listings: store.count(),
    elevenlabs: Boolean(process.env.ELEVENLABS_API_KEY?.trim()),
  });
});

app.get("/listings", (_req: Request, res: Response) => {
  res.json(store.list());
});

app.get("/listings/:id", (req: Request, res: Response) => {
  const row = store.get(req.params.id);
  if (!row) {
    res.status(404).json({ error: "Listing not found." });
    return;
  }
  res.json(row);
});

app.post("/listings", (req: Request, res: Response) => {
  res.status(201).json(store.create(req.body ?? {}));
});

app.patch("/listings/:id", (req: Request, res: Response) => {
  const row = store.patch(req.params.id, req.body ?? {});
  if (!row) {
    res.status(404).json({ error: "Listing not found." });
    return;
  }
  res.json(row);
});

app.post("/transcribe", async (req: Request, res: Response) => {
  try {
    const apiKey = requireApiKey();
    const audioB64 = typeof req.body?.audio === "string" ? req.body.audio : "";
    const mimeType =
      typeof req.body?.mimeType === "string" && req.body.mimeType
        ? req.body.mimeType
        : "audio/webm";

    if (!audioB64) {
      res.status(400).json({ error: "No audio received. Record again and retry." });
      return;
    }

    const buffer = Buffer.from(audioB64, "base64");
    if (!buffer.length) {
      res.status(400).json({ error: "Audio was empty. Record again and retry." });
      return;
    }

    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(buffer)], { type: mimeType }),
      filenameForMime(mimeType)
    );
    form.append("model_id", "scribe_v2");

    const elRes = await fetch(ELEVENLABS_STT_URL, {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: form,
    });

    const raw = await elRes.text();
    if (!elRes.ok) {
      console.error("ElevenLabs STT error", elRes.status, raw.slice(0, 500));
      res.status(502).json({ error: "Transcription failed. Try recording again." });
      return;
    }

    let parsed: { text?: string };
    try {
      parsed = JSON.parse(raw) as { text?: string };
    } catch {
      res.status(502).json({ error: "Transcription failed. Try recording again." });
      return;
    }

    res.json({ transcript: parsed.text ?? "" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Transcription failed.";
    console.error("POST /transcribe", err);
    const missingKey = message.includes("ELEVENLABS_API_KEY");
    res.status(missingKey ? 500 : 502).json({
      error: missingKey
        ? "Server is missing ELEVENLABS_API_KEY."
        : "Transcription failed. Try recording again.",
    });
  }
});

app.post("/speak", async (req: Request, res: Response) => {
  try {
    const apiKey = requireApiKey();
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) {
      res.status(400).json({ error: "Nothing to speak." });
      return;
    }

    const attempts: Array<{ model_id: string; language_code?: string }> = [
      { model_id: "eleven_v3", language_code: "sw" },
      { model_id: "eleven_multilingual_v2" },
    ];

    for (const attempt of attempts) {
      const elRes = await fetch(ELEVENLABS_TTS_URL, {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: attempt.model_id,
          ...(attempt.language_code ? { language_code: attempt.language_code } : {}),
        }),
      });

      if (elRes.ok) {
        const audio = Buffer.from(await elRes.arrayBuffer());
        res.setHeader("Content-Type", "audio/mpeg");
        res.send(audio);
        return;
      }

      const lastBody = await elRes.text();
      console.error("ElevenLabs TTS error", attempt.model_id, elRes.status, lastBody.slice(0, 500));
      if (elRes.status === 401 || elRes.status === 403) break;
    }

    res.status(502).json({
      error: "Could not generate confirmation audio. You can still confirm the listing.",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "TTS failed.";
    console.error("POST /speak", err);
    const missingKey = message.includes("ELEVENLABS_API_KEY");
    res.status(missingKey ? 500 : 502).json({
      error: missingKey
        ? "Server is missing ELEVENLABS_API_KEY."
        : "Could not generate confirmation audio. You can still confirm the listing.",
    });
  }
});

app.use(express.static(path.join(__dirname, "public")));

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Mboka AI listening on port ${PORT}`);
});
