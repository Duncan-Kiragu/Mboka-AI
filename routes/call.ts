/**
 * P6 — Call intake via web tap-to-record (simulates inbound call).
 *
 * POST /call/record — audio in, STT, log transcript, store session for P7.
 *
 * P7 — Call: confirm and post (spoken dialogue + write) lives at the bottom.
 */
import { Router, type Request, type Response } from "express";
import { extractFromTranscript, type ExtractFields } from "../lib/extract.js";
import { CATEGORIES, store, type Category } from "../lib/store.js";

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

/* ------------------------------------------------------------------ *
 * P7 — Call: confirm and post.
 *
 * P6 above owns inbound audio. Everything below owns the spoken
 * dialogue and the write to the store. State lives in its own map keyed
 * by sessionId so P6's CallSession shape stays untouched.
 *
 *   POST /call/next    { sessionId }                   first prompt after /call/record
 *   POST /call/answer  { sessionId, audio, mimeType }  one spoken turn
 *   POST /call/confirm { sessionId, agree }            tap fallback if yes/no STT misfires
 *
 * Every reply carries `say` — the Swahili line the client plays through
 * POST /speak — plus the fields gathered so far.
 * ------------------------------------------------------------------ */

type Slot = "item" | "price" | "location";

type DialogueState = {
  conversationId: string;
  /**
   * Everything the caller has said this session, oldest first. Claude threads
   * by conversation_id, but the regex fallback only sees the text handed to
   * it — so replay the whole lot each turn, or answers to follow-up questions
   * are lost whenever ANTHROPIC_API_KEY is absent.
   */
  accumulated: string;
  fields: ExtractFields;
  awaiting: Slot | "confirm" | "change" | "done";
  /** Set while re-asking a single field, so a re-extract cannot clobber the rest. */
  correcting: Slot | null;
  listingId: string;
  updatedAt: number;
};

const dialogues = new Map<string, DialogueState>();

/** A call runs for minutes. Anything older is a caller who hung up mid-sentence. */
const DIALOGUE_TTL_MS = 30 * 60 * 1000;

function pruneDialogues(): void {
  const now = Date.now();
  for (const [id, row] of dialogues) {
    if (now - row.updatedAt > DIALOGUE_TTL_MS) dialogues.delete(id);
  }
}

const SLOT_ORDER: Slot[] = ["item", "price", "location"];

const QUESTION: Record<Slot, string> = {
  item: "Unauza nini?",
  price: "Bei ni ngapi?",
  location: "Uko wapi?",
};

const CHANGE_PROMPT = "Ungependa kubadilisha nini? Sema bei, mahali, au kitu.";
const DONE_LINE = "Asante. Bidhaa yako iko live sasa.";

function blankFields(): ExtractFields {
  return { item: "", category: "", price: "", condition: "", location: "", extra_notes: "" };
}

/** extract.ts types category loosely; the store wants the union. */
function asCategory(value: string): Category {
  return (CATEGORIES as readonly string[]).includes(value) ? (value as Category) : "other";
}

function hasPrice(value: ExtractFields["price"]): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function slotFilled(fields: ExtractFields, slot: Slot): boolean {
  return slot === "price" ? hasPrice(fields.price) : Boolean(fields[slot]);
}

function missingSlots(fields: ExtractFields): Slot[] {
  return SLOT_ORDER.filter((slot) => !slotFilled(fields, slot));
}

/**
 * Fill gaps only — an answer already captured is never rewritten.
 *
 * This has to be prev-wins, not latest-wins. We replay the whole accumulated
 * transcript each turn, so once the caller answers "bei ni elfu tatu" the
 * regex extractor reads "meza ya mbao bei ni" back as the item. First reading
 * of a slot is the clean one. Corrections go through clearSlot(), which blanks
 * the field first, so they still get through.
 *
 * extra_notes only comes from the opening line: follow-up answers are terse
 * slot replies and leak fragments like "Niko" into the listing.
 */
function mergeFields(
  prev: ExtractFields,
  next: ExtractFields,
  opening: boolean
): ExtractFields {
  return {
    item: prev.item || next.item,
    category: prev.category || next.category,
    price: hasPrice(prev.price) ? prev.price : next.price,
    condition: prev.condition || next.condition,
    location: prev.location || next.location,
    extra_notes: prev.extra_notes || (opening ? next.extra_notes : ""),
  };
}

function summaryLine(fields: ExtractFields): string {
  const price = hasPrice(fields.price) ? `bei shilingi ${fields.price}` : "bei haijulikani";
  return `Nimesikia: ${fields.item}, ${price}, ${fields.location}. Ni sawa? Sema ndio au hapana.`;
}

const YES_WORDS =
  /(\bndio\b|\bndiyo\b|\bndyo\b|\beeh\b|\behe\b|\bsawa\b|\bpoa\b|\bsafi\b|\byes\b|\byeah\b|\byep\b|\bcorrect\b)/i;
const NO_WORDS = /(\bhapana\b|\bla\b|\bsio\b|\bsiyo\b|\bsi\b|\bno\b|\bnope\b)/i;

function readAgreement(text: string): "yes" | "no" | "unclear" {
  const yes = YES_WORDS.test(text);
  const no = NO_WORDS.test(text);
  // "si sawa" trips both patterns — the negation wins.
  if (no) return "no";
  if (yes) return "yes";
  return "unclear";
}

/** Which field the caller named — powers "badilisha bei" and the change prompt. */
function readSlotWord(text: string): Slot | null {
  if (/(\bbei\b|\bprice\b|\bpesa\b|\bgharama\b)/i.test(text)) return "price";
  if (/(\bmahali\b|\bwapi\b|\blocation\b|\bplace\b|\beneo\b)/i.test(text)) return "location";
  if (/(\bkitu\b|\bbidhaa\b|\bitem\b|\bnini\b)/i.test(text)) return "item";
  return null;
}

function readCorrection(text: string): Slot | null {
  if (!/(\bbadilisha\b|\bbadili\b|\brekebisha\b|\bchange\b|\bfix\b)/i.test(text)) return null;
  return readSlotWord(text);
}

function dialogueFor(session: CallSession): DialogueState {
  pruneDialogues();
  const existing = dialogues.get(session.sessionId);
  if (existing) {
    existing.updatedAt = Date.now();
    return existing;
  }
  const created: DialogueState = {
    conversationId: `call-${session.sessionId}`,
    accumulated: session.transcript,
    fields: blankFields(),
    awaiting: "item",
    correcting: null,
    listingId: "",
    updatedAt: Date.now(),
  };
  dialogues.set(session.sessionId, created);
  return created;
}

async function reextract(state: DialogueState, opening: boolean): Promise<void> {
  const before = state.fields;
  const result = await extractFromTranscript(state.accumulated, {
    conversationId: state.conversationId,
  });

  if (!state.correcting) {
    state.fields = mergeFields(before, result, opening);
    return;
  }

  // Mid-correction: keep only the field being fixed. The caller said "500", not
  // a whole listing, and a fresh extract over that alone would wreck the rest.
  const slot = state.correcting;
  const merged = { ...before };
  if (slot === "price") merged.price = hasPrice(result.price) ? result.price : before.price;
  else if (slot === "item") merged.item = result.item || before.item;
  else merged.location = result.location || before.location;
  state.fields = merged;
  if (slotFilled(merged, slot)) state.correcting = null;
}

/**
 * Drop one field and forget the words that produced it, so replaying the
 * accumulated transcript cannot simply refill it with the old value.
 */
function clearSlot(state: DialogueState, slot: Slot): void {
  const fields = { ...state.fields };
  if (slot === "price") fields.price = "";
  else if (slot === "item") fields.item = "";
  else fields.location = "";
  state.fields = fields;
  state.accumulated = "";
  state.conversationId = `${state.conversationId}-${slot}`;
  state.correcting = slot;
  state.awaiting = slot;
}

type Prompt = {
  sessionId: string;
  mode: "question" | "confirm" | "done";
  say: string;
  fields: ExtractFields;
  missing: Slot[];
};

/** One question at a time — the first gap only, never a list. */
function advance(sessionId: string, state: DialogueState): Prompt {
  const missing = missingSlots(state.fields);
  if (missing.length) {
    state.awaiting = missing[0];
    return {
      sessionId,
      mode: "question",
      say: QUESTION[missing[0]],
      fields: state.fields,
      missing,
    };
  }
  state.awaiting = "confirm";
  return {
    sessionId,
    mode: "confirm",
    say: summaryLine(state.fields),
    fields: state.fields,
    missing,
  };
}

function postListing(session: CallSession, state: DialogueState) {
  const listing = store.create({
    item: state.fields.item,
    category: asCategory(state.fields.category),
    price: hasPrice(state.fields.price) ? (state.fields.price as number) : null,
    condition: state.fields.condition,
    location: state.fields.location,
    contact: session.phoneNumber,
    source_channel: "call",
    extra_notes: state.fields.extra_notes,
  });
  state.awaiting = "done";
  state.correcting = null;
  state.listingId = listing.id;
  console.log("[call/posted]", { sessionId: session.sessionId, listingId: listing.id });
  return listing;
}

function doneReply(sessionId: string, state: DialogueState, say: string) {
  return {
    sessionId,
    mode: "done" as const,
    say,
    fields: state.fields,
    missing: [] as Slot[],
    listing: state.listingId ? store.get(state.listingId) : undefined,
  };
}

function resolveSession(req: Request, res: Response): CallSession | null {
  const sessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId.trim() : "";
  const session = sessionId ? getCallSession(sessionId) : undefined;
  if (!session) {
    res.status(404).json({ error: "Unknown call session. Record the opening line again." });
    return null;
  }
  return session;
}

/** First prompt after P6's /call/record — mines whatever the opening line already gave us. */
callRouter.post("/call/next", async (req: Request, res: Response) => {
  const session = resolveSession(req, res);
  if (!session) return;

  const state = dialogueFor(session);
  if (state.awaiting === "done") {
    res.json(doneReply(session.sessionId, state, DONE_LINE));
    return;
  }

  await reextract(state, true);
  const prompt = advance(session.sessionId, state);
  console.log("[call/next]", { sessionId: session.sessionId, missing: prompt.missing });
  res.json(prompt);
});

/** One spoken turn: an answer to a follow-up, or the yes/no on the summary. */
callRouter.post("/call/answer", async (req: Request, res: Response) => {
  const session = resolveSession(req, res);
  if (!session) return;

  const state = dialogueFor(session);
  if (state.awaiting === "done") {
    res.json(doneReply(session.sessionId, state, DONE_LINE));
    return;
  }

  let heard = "";
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
    const buffer = Buffer.from(audioB64, "base64");
    if (!buffer.length) {
      res.status(400).json({ error: "Audio was empty. Record again and retry." });
      return;
    }
    heard = (await transcribeAudioBuffer(buffer, mimeType)).trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Transcription failed.";
    console.error("POST /call/answer", err);
    const missingKey = message.includes("ELEVENLABS_API_KEY");
    res.status(missingKey ? 500 : 502).json({
      error: missingKey
        ? "Server is missing ELEVENLABS_API_KEY."
        : "Transcription failed. Try answering again.",
    });
    return;
  }

  if (!heard) {
    res.status(400).json({ error: "Heard nothing we could transcribe. Answer again." });
    return;
  }

  console.log("[call/answer]", { sessionId: session.sessionId, awaiting: state.awaiting, heard });

  if (state.awaiting === "change") {
    const slot = readSlotWord(heard);
    if (slot) {
      clearSlot(state, slot);
      res.json({
        sessionId: session.sessionId,
        mode: "question",
        say: QUESTION[slot],
        fields: state.fields,
        missing: missingSlots(state.fields),
        transcript: heard,
      });
      return;
    }
    // Could not tell which field — take the whole listing from the top.
    state.fields = blankFields();
    state.accumulated = "";
    state.correcting = null;
    state.conversationId = `${state.conversationId}-again`;
    res.json({ ...advance(session.sessionId, state), transcript: heard });
    return;
  }

  if (state.awaiting === "confirm") {
    const correction = readCorrection(heard);
    if (correction) {
      clearSlot(state, correction);
      res.json({
        sessionId: session.sessionId,
        mode: "question",
        say: QUESTION[correction],
        fields: state.fields,
        missing: missingSlots(state.fields),
        transcript: heard,
      });
      return;
    }

    const agreement = readAgreement(heard);
    if (agreement === "yes") {
      const listing = postListing(session, state);
      res.json({ ...doneReply(session.sessionId, state, DONE_LINE), listing, transcript: heard });
      return;
    }
    if (agreement === "no") {
      state.awaiting = "change";
      res.json({
        sessionId: session.sessionId,
        mode: "confirm",
        say: CHANGE_PROMPT,
        fields: state.fields,
        missing: [] as Slot[],
        transcript: heard,
      });
      return;
    }
    res.json({
      sessionId: session.sessionId,
      mode: "confirm",
      say: `Sikuelewa. ${summaryLine(state.fields)}`,
      fields: state.fields,
      missing: [] as Slot[],
      transcript: heard,
    });
    return;
  }

  // Still collecting: fold the answer into the running transcript and re-read it.
  state.accumulated = `${state.accumulated} ${heard}`.trim();
  await reextract(state, false);
  res.json({ ...advance(session.sessionId, state), transcript: heard });
});

/** Tap fallback — keeps the demo alive when yes/no STT misfires. */
callRouter.post("/call/confirm", (req: Request, res: Response) => {
  const session = resolveSession(req, res);
  if (!session) return;

  const state = dialogues.get(session.sessionId);
  if (!state) {
    res.status(409).json({ error: "No dialogue in progress for this session." });
    return;
  }
  state.updatedAt = Date.now();
  if (state.awaiting === "done") {
    res.json(doneReply(session.sessionId, state, DONE_LINE));
    return;
  }
  if (missingSlots(state.fields).length) {
    res.json(advance(session.sessionId, state));
    return;
  }
  if (req.body?.agree === false) {
    state.awaiting = "change";
    res.json({
      sessionId: session.sessionId,
      mode: "confirm",
      say: CHANGE_PROMPT,
      fields: state.fields,
      missing: [] as Slot[],
    });
    return;
  }

  const listing = postListing(session, state);
  res.json({ ...doneReply(session.sessionId, state, DONE_LINE), listing });
});
