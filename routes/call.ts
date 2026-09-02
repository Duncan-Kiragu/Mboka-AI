/**
 * P6 — Call intake via web tap-to-record (simulates inbound call).
 *
 * POST /call/record — audio in, STT, log transcript, store session for P7.
 *
 * P7 — Call: confirm and post (spoken dialogue + write) lives at the bottom.
 */
import { Router, type Request, type Response } from "express";
import { extractFromTranscript, type ExtractFields } from "../lib/extract.js";
import { ElevenLabsError, speak, toDataUrl, transcribe } from "../lib/elevenlabs.js";
import { CATEGORIES, store, type Category } from "../lib/store.js";

/** Hand-off shape for P7 — keyed by sessionId. */
export type CallSession = {
  sessionId: string;
  phoneNumber: string;
  transcript: string;
  recordedAt: string;
  audio_url: string;
};

const callSessions = new Map<string, CallSession>();

export function getCallSession(sessionId: string): CallSession | undefined {
  return callSessions.get(sessionId);
}

function readTypedAnswer(req: Request): string {
  return typeof req.body?.text === "string" ? req.body.text.trim() : "";
}

/**
 * Demo heuristic for spoken or typed numbers — not a numbering-plan spec.
 * Accepts 07xxxxxxxx / 01xxxxxxxx, 7xxxxxxxx / 1xxxxxxxx, and 2547/2541.
 */
function normalizePhone(text: string): string {
  const digits = text.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("254")) return "0" + digits.slice(3);
  if (digits.length === 10 && (digits.startsWith("07") || digits.startsWith("01"))) return digits;
  if (digits.length === 9 && (digits.startsWith("7") || digits.startsWith("1"))) return "0" + digits;
  return "";
}

function applyPhone(session: CallSession, req: Request): void {
  const raw = typeof req.body?.phoneNumber === "string" ? req.body.phoneNumber.trim() : "";
  if (!raw) return;
  session.phoneNumber = normalizePhone(raw) || raw;
}

function sendVoiceError(res: Response, err: unknown, fallback: string): void {
  console.error(fallback, err instanceof Error ? err.message : err);
  if (err instanceof ElevenLabsError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  res.status(502).json({ error: fallback });
}

async function hearAudio(buffer: Buffer, mimeType: string, typed: string): Promise<string> {
  try {
    return (await transcribe(buffer, mimeType)).trim() || typed;
  } catch (err) {
    if (typed) return typed;
    throw err;
  }
}

export const callRouter = Router();

/** Web recorder posts here after the user speaks (tap-to-record simulates a call). */
callRouter.post("/call/record", async (req: Request, res: Response) => {
  try {
    const typed = readTypedAnswer(req);
    const audioB64 = typeof req.body?.audio === "string" ? req.body.audio : "";
    const mimeType =
      typeof req.body?.mimeType === "string" && req.body.mimeType
        ? req.body.mimeType
        : "audio/webm";
    const phoneNumber =
      typeof req.body?.phoneNumber === "string" ? req.body.phoneNumber.trim() : "";

    if (!audioB64 && !typed) {
      res.status(400).json({ error: "No audio received. Record again and retry." });
      return;
    }

    let transcript = typed;
    let audio_url = "";
    if (audioB64) {
      const buffer = Buffer.from(audioB64, "base64");
      if (!buffer.length && !typed) {
        res.status(400).json({ error: "Audio was empty. Record again and retry." });
        return;
      }
      if (buffer.length) {
        transcript = await hearAudio(buffer, mimeType, typed);
        audio_url = "data:" + mimeType + ";base64," + audioB64;
      }
    }

    if (!transcript) {
      res.status(400).json({ error: "Heard nothing we could transcribe. Try again." });
      return;
    }

    const sessionId = `call-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const session: CallSession = {
      sessionId,
      phoneNumber: normalizePhone(phoneNumber) || phoneNumber,
      transcript,
      recordedAt: new Date().toISOString(),
      audio_url,
    };
    callSessions.set(sessionId, session);

    console.log("[call/transcript]", { sessionId, phoneNumber: session.phoneNumber, transcript });

    res.json({ sessionId, phoneNumber: session.phoneNumber, transcript });
  } catch (err) {
    sendVoiceError(res, err, "Transcription failed. Try recording again.");
  }
});

/* ------------------------------------------------------------------ *
 * P7 — Call: confirm and post.
 *
 * P6 above owns inbound audio. Everything below owns the spoken
 * dialogue and the write to the store. State lives in its own map keyed
 * by sessionId so P6's CallSession shape stays untouched.
 *
 *   POST /call/next    { sessionId, phoneNumber? }              first prompt after /call/record
 *   POST /call/answer  { sessionId, audio | text, phoneNumber? } one turn
 *   POST /call/confirm { sessionId, agree, phoneNumber? }        tap fallback if yes/no STT misfires
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
  awaiting: Slot | "contact" | "confirm" | "change" | "done";
  /** Set while re-asking a single field, so a re-extract cannot clobber the rest. */
  correcting: Slot | null;
  listingId: string;
  updatedAt: number;
  /** Last spoken line — board reads this; POST bodies stay unchanged. */
  lastSay: string;
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

const CONTACT_PROMPT = "Namba yako ni gani?";
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
    lastSay: "",
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

/** If extract missed the slot we just asked, take the reply itself. */
function fillAskedSlot(state: DialogueState, heard: string): void {
  const slot = state.awaiting;
  if (slot !== "item" && slot !== "price" && slot !== "location") return;
  if (slotFilled(state.fields, slot)) return;
  const line = heard.trim().replace(/[.,;]+$/, "");
  if (!line) return;
  const digitsOnly = line.replace(/[,\s]/g, "");
  const fields = { ...state.fields };
  if (slot === "price") {
    const digits = line.replace(/,/g, "").match(/\d{2,7}/);
    if (digits) {
      const n = Number(digits[0]);
      if (Number.isFinite(n)) fields.price = n;
    }
  } else if (slot === "item") {
    if (/^\d{2,7}$/.test(digitsOnly)) return;
    fields.item = line.replace(/^\s*(nauza|ninauza|nina|nataka kuuza)\s+/i, "").trim() || line;
  } else {
    if (/^\d{2,7}$/.test(digitsOnly) || /^\d{9,12}$/.test(digitsOnly)) return;
    fields.location = line.replace(/^\s*(iko|niko|uko|mahali)\s+/i, "").trim() || line;
  }
  state.fields = fields;
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
  ask: Slot | "contact" | "confirm" | "";
  fields: ExtractFields;
  missing: Slot[];
  needPhone: boolean;
  phoneNumber: string;
};

/** One question at a time — the first gap only, never a list. */
function advance(sessionId: string, state: DialogueState, phoneNumber: string): Prompt {
  const missing = missingSlots(state.fields);
  if (missing.length) {
    state.awaiting = missing[0];
    const say = QUESTION[missing[0]];
    state.lastSay = say;
    return {
      sessionId,
      mode: "question",
      say,
      ask: missing[0],
      fields: state.fields,
      missing,
      needPhone: !phoneNumber,
      phoneNumber,
    };
  }
  if (!phoneNumber) {
    state.awaiting = "contact";
    state.lastSay = CONTACT_PROMPT;
    return {
      sessionId,
      mode: "question",
      say: CONTACT_PROMPT,
      ask: "contact",
      fields: state.fields,
      missing,
      needPhone: true,
      phoneNumber: "",
    };
  }
  state.awaiting = "confirm";
  const say = summaryLine(state.fields);
  state.lastSay = say;
  return {
    sessionId,
    mode: "confirm",
    say,
    ask: "confirm",
    fields: state.fields,
    missing,
    needPhone: false,
    phoneNumber,
  };
}

async function postListing(session: CallSession, state: DialogueState) {
  let narration_url = "";
  try {
    const line = `${state.fields.item}, bei shilingi ${state.fields.price}, ${state.fields.location}.`;
    const audio = await speak(line);
    narration_url = toDataUrl(audio);
  } catch (err) {
    console.error("[call/narration]", err);
  }
  const listing = store.create({
    item: state.fields.item,
    category: asCategory(state.fields.category),
    price: hasPrice(state.fields.price) ? (state.fields.price as number) : null,
    condition: state.fields.condition,
    location: state.fields.location,
    contact: session.phoneNumber,
    source_channel: "call",
    extra_notes: state.fields.extra_notes,
    audio_url: session.audio_url || "",
    narration_url,
  });
  state.awaiting = "done";
  state.correcting = null;
  state.listingId = listing.id;
  console.log("[call/posted]", { sessionId: session.sessionId, listingId: listing.id });
  return listing;
}

function doneReply(sessionId: string, state: DialogueState, say: string, phoneNumber = "") {
  state.lastSay = say;
  return {
    sessionId,
    mode: "done" as const,
    say,
    ask: "" as const,
    fields: state.fields,
    missing: [] as Slot[],
    needPhone: false,
    phoneNumber,
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

async function hearCaller(req: Request, res: Response): Promise<string | null> {
  const typed = readTypedAnswer(req);
  const audioB64 = typeof req.body?.audio === "string" ? req.body.audio : "";
  const mimeType =
    typeof req.body?.mimeType === "string" && req.body.mimeType
      ? req.body.mimeType
      : "audio/webm";

  if (audioB64) {
    try {
      const buffer = Buffer.from(audioB64, "base64");
      if (!buffer.length && !typed) {
        res.status(400).json({ error: "Audio was empty. Record again and retry." });
        return null;
      }
      if (buffer.length) {
        const heard = await transcribe(buffer, mimeType);
        if (heard.trim()) return heard.trim();
      }
    } catch (err) {
      if (typed) return typed;
      sendVoiceError(res, err, "Transcription failed. Try answering again.");
      return null;
    }
  }

  if (typed) return typed;
  res.status(400).json({ error: "No audio received. Record again and retry." });
  return null;
}

function questionReply(
  session: CallSession,
  state: DialogueState,
  say: string,
  ask: Slot | "contact",
  extra?: Record<string, unknown>
) {
  state.lastSay = say;
  return {
    sessionId: session.sessionId,
    mode: "question" as const,
    say,
    ask,
    fields: state.fields,
    missing: missingSlots(state.fields),
    needPhone: !session.phoneNumber,
    phoneNumber: session.phoneNumber,
    ...extra,
  };
}

/** First prompt after P6's /call/record — mines whatever the opening line already gave us. */
callRouter.post("/call/next", async (req: Request, res: Response) => {
  const session = resolveSession(req, res);
  if (!session) return;
  applyPhone(session, req);

  const state = dialogueFor(session);
  if (state.awaiting === "done") {
    res.json(doneReply(session.sessionId, state, DONE_LINE, session.phoneNumber));
    return;
  }

  await reextract(state, true);
  const prompt = advance(session.sessionId, state, session.phoneNumber);
  console.log("[call/next]", {
    sessionId: session.sessionId,
    missing: prompt.missing,
    ask: prompt.ask,
  });
  res.json(prompt);
});

/** One turn: spoken or typed answer to a follow-up, or yes/no on the summary. */
callRouter.post("/call/answer", async (req: Request, res: Response) => {
  const session = resolveSession(req, res);
  if (!session) return;
  applyPhone(session, req);

  const state = dialogueFor(session);
  if (state.awaiting === "done") {
    res.json(doneReply(session.sessionId, state, DONE_LINE, session.phoneNumber));
    return;
  }

  const heard = await hearCaller(req, res);
  if (heard === null) return;

  console.log("[call/answer]", { sessionId: session.sessionId, awaiting: state.awaiting, heard });

  if (state.awaiting === "contact") {
    const phone = normalizePhone(heard);
    if (phone) {
      session.phoneNumber = phone;
      res.json({ ...advance(session.sessionId, state, session.phoneNumber), transcript: heard });
      return;
    }
    res.json(
      questionReply(session, state, `Sikuelewa. ${CONTACT_PROMPT}`, "contact", { transcript: heard })
    );
    return;
  }

  if (state.awaiting === "change") {
    const slot = readSlotWord(heard);
    if (slot) {
      clearSlot(state, slot);
      res.json(questionReply(session, state, QUESTION[slot], slot, { transcript: heard }));
      return;
    }
    state.fields = blankFields();
    state.accumulated = "";
    state.correcting = null;
    state.conversationId = `${state.conversationId}-again`;
    res.json({ ...advance(session.sessionId, state, session.phoneNumber), transcript: heard });
    return;
  }

  if (state.awaiting === "confirm") {
    const correction = readCorrection(heard);
    if (correction) {
      clearSlot(state, correction);
      res.json(questionReply(session, state, QUESTION[correction], correction, { transcript: heard }));
      return;
    }

    const agreement = readAgreement(heard);
    if (agreement === "yes") {
      if (!session.phoneNumber) {
        res.json({
          ...advance(session.sessionId, state, session.phoneNumber),
          transcript: heard,
        });
        return;
      }
      const listing = await postListing(session, state);
      res.json({ ...doneReply(session.sessionId, state, DONE_LINE, session.phoneNumber), listing, transcript: heard });
      return;
    }
    if (agreement === "no") {
      state.awaiting = "change";
      state.lastSay = CHANGE_PROMPT;
      res.json({
        sessionId: session.sessionId,
        mode: "question",
        say: CHANGE_PROMPT,
        ask: "confirm",
        fields: state.fields,
        missing: [] as Slot[],
        needPhone: !session.phoneNumber,
        phoneNumber: session.phoneNumber,
        transcript: heard,
      });
      return;
    }
    const unclear = `Sikuelewa. ${summaryLine(state.fields)}`;
    state.lastSay = unclear;
    res.json({
      sessionId: session.sessionId,
      mode: "confirm",
      say: unclear,
      ask: "confirm",
      fields: state.fields,
      missing: [] as Slot[],
      needPhone: !session.phoneNumber,
      phoneNumber: session.phoneNumber,
      transcript: heard,
    });
    return;
  }

  const asked = state.awaiting;
  state.accumulated = `${state.accumulated} ${heard}`.trim();
  await reextract(state, false);
  fillAskedSlot(state, heard);
  const prompt = advance(session.sessionId, state, session.phoneNumber);
  if (prompt.mode === "question" && asked === prompt.ask) {
    prompt.say = `Sikuelewa. ${prompt.say}`;
    state.lastSay = prompt.say;
  }
  res.json({ ...prompt, transcript: heard });
});

/** Tap fallback — keeps the demo alive when yes/no STT misfires. */
callRouter.post("/call/confirm", async (req: Request, res: Response) => {
  const session = resolveSession(req, res);
  if (!session) return;
  applyPhone(session, req);

  const state = dialogues.get(session.sessionId);
  if (!state) {
    res.status(409).json({ error: "No dialogue in progress for this session." });
    return;
  }
  state.updatedAt = Date.now();
  if (state.awaiting === "done") {
    res.json(doneReply(session.sessionId, state, DONE_LINE, session.phoneNumber));
    return;
  }
  if (state.awaiting === "change") {
    res.json({
      sessionId: session.sessionId,
      mode: "question",
      say: CHANGE_PROMPT,
      ask: "confirm",
      fields: state.fields,
      missing: [] as Slot[],
      needPhone: !session.phoneNumber,
      phoneNumber: session.phoneNumber,
    });
    return;
  }
  if (missingSlots(state.fields).length || !session.phoneNumber) {
    res.json(advance(session.sessionId, state, session.phoneNumber));
    return;
  }
  if (req.body?.agree === false) {
    state.awaiting = "change";
    state.lastSay = CHANGE_PROMPT;
    res.json({
      sessionId: session.sessionId,
      mode: "question",
      say: CHANGE_PROMPT,
      ask: "confirm",
      fields: state.fields,
      missing: [] as Slot[],
      needPhone: false,
      phoneNumber: session.phoneNumber,
    });
    return;
  }

  const listing = await postListing(session, state);
  res.json({ ...doneReply(session.sessionId, state, DONE_LINE, session.phoneNumber), listing });
});

/* ------------------------------------------------------------------ *
 * Board / Jukwaa — read-only snapshot for the projector.
 * Does not create sessions or advance dialogue.
 * ------------------------------------------------------------------ */

type LiveMode = "question" | "confirm" | "done" | "idle";

function liveMode(awaiting: DialogueState["awaiting"] | undefined): LiveMode {
  if (!awaiting) return "idle";
  if (awaiting === "done") return "done";
  if (awaiting === "confirm" || awaiting === "change") return "confirm";
  return "question";
}

function liveFields(fields: ExtractFields | undefined) {
  return {
    item: fields?.item ?? "",
    price: fields?.price ?? "",
    location: fields?.location ?? "",
    category: fields?.category ?? "",
    extra_notes: fields?.extra_notes ?? "",
  };
}

function sessionRecency(session: CallSession, state: DialogueState | undefined): number {
  const recorded = Date.parse(session.recordedAt) || 0;
  return Math.max(recorded, state?.updatedAt ?? 0);
}

function latestSession(): CallSession | undefined {
  let best: CallSession | undefined;
  let bestAt = -1;
  for (const session of callSessions.values()) {
    const at = sessionRecency(session, dialogues.get(session.sessionId));
    if (at >= bestAt) {
      bestAt = at;
      best = session;
    }
  }
  return best;
}

function derivedSay(state: DialogueState | undefined): string {
  if (!state) return "";
  if (state.lastSay) return state.lastSay;
  if (state.awaiting === "done") return DONE_LINE;
  if (state.awaiting === "change") return CHANGE_PROMPT;
  if (state.awaiting === "confirm") return summaryLine(state.fields);
  if (state.awaiting === "contact") return CONTACT_PROMPT;
  if (state.awaiting === "item" || state.awaiting === "price" || state.awaiting === "location") {
    return QUESTION[state.awaiting];
  }
  return "";
}

function liveSnapshot(session: CallSession) {
  const state = dialogues.get(session.sessionId);
  const listing = state?.listingId ? store.get(state.listingId) : undefined;
  const awaiting = state?.awaiting ?? "";
  const ask =
    awaiting === "item" ||
    awaiting === "price" ||
    awaiting === "location" ||
    awaiting === "contact" ||
    awaiting === "confirm"
      ? awaiting
      : awaiting === "change"
        ? "confirm"
        : "";
  return {
    active: true as const,
    sessionId: session.sessionId,
    phoneNumber: session.phoneNumber,
    recordedAt: session.recordedAt,
    mode: liveMode(state?.awaiting),
    awaiting,
    ask,
    say: derivedSay(state),
    transcript: state?.accumulated || session.transcript,
    fields: liveFields(state?.fields),
    missing: state ? missingSlots(state.fields) : SLOT_ORDER.slice(),
    needPhone: !session.phoneNumber,
    listingId: state?.listingId ?? "",
    ...(listing ? { listing } : {}),
  };
}

/** Projector board polls this. Optional ?sessionId= pins one handset. */
callRouter.get("/call/live", (req: Request, res: Response) => {
  pruneDialogues();
  const pinned = typeof req.query.sessionId === "string" ? req.query.sessionId.trim() : "";
  const session = pinned ? callSessions.get(pinned) : latestSession();
  if (pinned && !session) {
    res.json({ active: false });
    return;
  }
  if (!session) {
    res.json({ active: false });
    return;
  }
  res.json(liveSnapshot(session));
});
