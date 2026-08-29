/**
 * P6 — Call intake via web tap-to-record (simulates inbound call).
 *
 * POST /call/record — audio in, STT, log transcript, store session for P7.
 */
import { Router, type Request, type Response } from "express";

const ELEVENLABS_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";

/** Hand-off shape for P7 — keyed by sessionId. */
export type CallSession = {
  sessionId: string;
  phoneNumber: string;
  transcript: string;
  recordedAt: string;
};

const callSessions = new Map<string, CallSession>();

export function getCallSession(sessionId: string): CallSession | undefined {
  return callSessions.get(sessionId);
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

/** Temporary inline STT — swap for lib/elevenlabs.ts once P2 lands. */
async function transcribeAudioBuffer(buffer: Buffer, mimeType: string): Promise<string> {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("ELEVENLABS_API_KEY is not set");
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
    throw new Error("Transcription failed");
  }

  const parsed = JSON.parse(raw) as { text?: string };
  return parsed.text ?? "";
}

export const callRouter = Router();

/** Web recorder posts here after the user speaks (tap-to-record simulates a call). */
callRouter.post("/call/record", async (req: Request, res: Response) => {
  try {
    const audioB64 = typeof req.body?.audio === "string" ? req.body.audio : "";
    const mimeType =
      typeof req.body?.mimeType === "string" && req.body.mimeType
        ? req.body.mimeType
        : "audio/webm";
    const phoneNumber =
      typeof req.body?.phoneNumber === "string" ? req.body.phoneNumber.trim() : "";

    if (!audioB64) {
      res.status(400).json({ error: "No audio received. Record again and retry." });
      return;
    }

    const buffer = Buffer.from(audioB64, "base64");
    if (!buffer.length) {
      res.status(400).json({ error: "Audio was empty. Record again and retry." });
      return;
    }

    const transcript = (await transcribeAudioBuffer(buffer, mimeType)).trim();
    if (!transcript) {
      res.status(400).json({ error: "Heard nothing we could transcribe. Try again." });
      return;
    }

    const sessionId = `call-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const session: CallSession = {
      sessionId,
      phoneNumber,
      transcript,
      recordedAt: new Date().toISOString(),
    };
    callSessions.set(sessionId, session);

    console.log("[call/transcript]", { sessionId, phoneNumber, transcript });

    res.json({ sessionId, phoneNumber, transcript });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Transcription failed.";
    console.error("POST /call/record", err);
    const missingKey = message.includes("ELEVENLABS_API_KEY");
    res.status(missingKey ? 500 : 502).json({
      error: missingKey
        ? "Server is missing ELEVENLABS_API_KEY."
        : "Transcription failed. Try recording again.",
    });
  }
});
