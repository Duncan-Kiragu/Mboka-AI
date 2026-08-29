/**
 * Mboka AI — one Express process serves the API and public/index.html.
 *
 * Routes:
 *   GET  /health
 *   GET  /listings
 *   GET  /listings/:id
 *   POST /listings
 *   PATCH /listings/:id     { status: "sold" } or field edits
 *   POST /extract           { transcript, conversation_id? }
 *   POST /transcribe        { audio, mimeType } → { transcript }
 *   POST /speak             { text } → audio/mpeg
 *   POST /call/record       tap-to-record audio → STT → log transcript
 *
 * Storage is an in-memory array (resets on every Render sleep/redeploy).
 * Swap `listings` for a database later without changing the JSON shape.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response } from "express";
import { callRouter } from "./routes/call.js";
import { extractFromTranscript, extractWithRegex } from "./lib/extract.js";
import { ElevenLabsError, hasApiKey, speak, transcribe } from "./lib/elevenlabs.js";
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

const app = express();
app.use(express.json({ limit: "15mb" }));
app.use(callRouter);

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    listings: store.count(),
    elevenlabs: hasApiKey(),
    claude: Boolean(
      (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || "").trim()
    ),
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

app.post("/extract", async (req: Request, res: Response) => {
  const transcript = typeof req.body?.transcript === "string" ? req.body.transcript : "";
  const conversationId =
    typeof req.body?.conversation_id === "string" ? req.body.conversation_id : "";
  try {
    const result = await extractFromTranscript(transcript, {
      conversationId,
    });
    console.log(
      JSON.stringify({
        tag: "extract",
        event: "http",
        conversation_id: result.conversation_id,
        source: result.source,
        llm_attempted: result.trace.llm_attempted,
        llm_calls: result.trace.llm_calls,
        fallback_reason: result.trace.fallback_reason,
      })
    );
    res.json(result);
  } catch (err) {
    console.error("POST /extract", err);
    res.json({
      ...extractWithRegex(transcript),
      conversation_id: conversationId,
      source: "regex",
      trace: {
        has_key: false,
        model: "",
        workspace_id: "",
        transcript_chars: transcript.length,
        llm_attempted: false,
        llm_calls: 0,
        fallback_reason: "route_threw",
        calls: [],
      },
    });
  }
});

app.post("/transcribe", async (req: Request, res: Response) => {
  try {
    const audioB64 = typeof req.body?.audio === "string" ? req.body.audio : "";
    const mimeType =
      typeof req.body?.mimeType === "string" && req.body.mimeType
        ? req.body.mimeType
        : "audio/webm";

    if (!audioB64) {
      res.status(400).json({ error: "No audio received. Record again and retry." });
      return;
    }

    const transcript = await transcribe(Buffer.from(audioB64, "base64"), mimeType);
    res.json({ transcript });
  } catch (err) {
    if (err instanceof ElevenLabsError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("POST /transcribe", err);
    res.status(502).json({ error: "Transcription failed. Try recording again." });
  }
});

app.post("/speak", async (req: Request, res: Response) => {
  try {
    const audio = await speak(typeof req.body?.text === "string" ? req.body.text : "");
    res.setHeader("Content-Type", "audio/mpeg");
    res.send(audio);
  } catch (err) {
    if (err instanceof ElevenLabsError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("POST /speak", err);
    res.status(502).json({
      error: "Could not generate confirmation audio. You can still confirm the listing.",
    });
  }
});

app.use(express.static(path.join(__dirname, "public")));

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Mboka AI listening on port ${PORT}`);
});
