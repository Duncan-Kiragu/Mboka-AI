/**
 * Listing extraction: Claude conversation first, regex if that fails.
 * Never throws. Missing fields are blank strings (price: "").
 */

export type ExtractFields = {
  item: string;
  category: string;
  price: number | "";
  condition: string;
  location: string;
  extra_notes: string;
};

export type ExtractResult = ExtractFields & {
  conversation_id: string;
  source: "llm" | "regex";
};

type ChatTurn = { role: "user" | "assistant"; content: string };

type StoredConversation = {
  messages: ChatTurn[];
  updatedAt: number;
};

const CATEGORIES = [
  "furniture",
  "clothing",
  "food",
  "services",
  "electronics",
  "other",
] as const;

const CONTRACT_KEYS = [
  "item",
  "category",
  "price",
  "condition",
  "location",
  "extra_notes",
] as const;

const LOCATIONS = [
  "Kawangware",
  "Kayole",
  "Eastleigh",
  "Kibra",
  "Ngong Road",
  "Westlands",
  "CBD",
  "Kasarani",
  "Umoja",
  "Dagoretti",
  "Rongai",
  "Buruburu",
  "Githurai",
  "Embakasi",
  "Langata",
];

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  furniture: ["viti", "meza", "mbao", "kabati", "kitanda", "sofa"],
  clothing: ["nguo", "shati", "sketi", "suruali", "kofia"],
  food: ["chakula", "mboga", "matunda", "nyama", "maziwa"],
  services: ["fundi", "umeme", "bomba", "ukarabati", "mshonaji"],
  electronics: ["simu", "radio", "laptop", "tv", "frige"],
};

const NUMBER_WORDS: Record<string, number> = {
  moja: 1,
  mbili: 2,
  tatu: 3,
  nne: 4,
  tano: 5,
  sita: 6,
  saba: 7,
  nane: 8,
  tisa: 9,
  kumi: 10,
};

const BLANK: ExtractFields = {
  item: "",
  category: "",
  price: "",
  condition: "",
  location: "",
  extra_notes: "",
};

const MAX_RETRY_SESSIONS = 3;
const CALLS_PER_SESSION = 3;
const MAX_CONVERSATIONS = 80;
const CONVERSATION_TTL_MS = 1000 * 60 * 30;

const conversations = new Map<string, StoredConversation>();

const SYSTEM_PROMPT = `You extract Kenyan jua kali marketplace listings from mixed Swahili, Sheng, and English speech.

Return ONLY a JSON object with exactly these keys:
item (string), category (one of: furniture, clothing, food, services, electronics, other, or ""), price (number in KES, or ""), condition (string), location (string, area name), extra_notes (string).

Rules:
- Never invent facts that are not in the transcript. Unknown fields must be "".
- "elfu tano" / "elfu 5" means 5000. "kila kimoja" is the unit price; use that, not quantity × unit.
- "viwili" is quantity two, not the price.
- viti, meza, mbao, kabati → category furniture.
- Location is the neighbourhood (e.g. Kawangware), not the country.
- item is the goods/service, not the whole sentence. extra_notes is leftover useful detail.
- Do not wrap JSON in markdown.`;

function blankFields(): ExtractFields {
  return { ...BLANK };
}

function newConversationId(): string {
  return `ext-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function pruneConversations(): void {
  const now = Date.now();
  for (const [id, row] of conversations) {
    if (now - row.updatedAt > CONVERSATION_TTL_MS) conversations.delete(id);
  }
  if (conversations.size <= MAX_CONVERSATIONS) return;
  const oldest = [...conversations.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  for (let i = 0; i < oldest.length - MAX_CONVERSATIONS; i++) {
    conversations.delete(oldest[i][0]);
  }
}

function loadConversation(id: string): ChatTurn[] {
  pruneConversations();
  const row = conversations.get(id);
  return row ? row.messages.map((m) => ({ ...m })) : [];
}

function saveConversation(id: string, messages: ChatTurn[]): void {
  conversations.set(id, { messages: messages.map((m) => ({ ...m })), updatedAt: Date.now() });
  pruneConversations();
}

function asString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function asPrice(value: unknown): number | "" {
  if (value === "" || value === null || value === undefined) return "";
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    const n = Number(trimmed.replace(/[,\s]/g, ""));
    return Number.isFinite(n) ? n : "";
  }
  return "";
}

function asCategory(value: unknown): string {
  const raw = asString(value).toLowerCase();
  if (!raw) return "";
  return (CATEGORIES as readonly string[]).includes(raw) ? raw : "";
}

function looksLikeContract(raw: unknown): raw is Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const obj = raw as Record<string, unknown>;
  return CONTRACT_KEYS.every((key) => Object.prototype.hasOwnProperty.call(obj, key));
}

function coerceContract(raw: Record<string, unknown>): ExtractFields {
  return {
    item: asString(raw.item),
    category: asCategory(raw.category),
    price: asPrice(raw.price),
    condition: asString(raw.condition),
    location: asString(raw.location),
    extra_notes: asString(raw.extra_notes),
  };
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) {
      try {
        return JSON.parse(fenced[1].trim());
      } catch {
        /* continue */
      }
    }
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function parseAssistantContract(text: string): ExtractFields | null {
  const parsed = parseJsonObject(text);
  if (!looksLikeContract(parsed)) return null;
  return coerceContract(parsed);
}

function anthropicKey(): string {
  return (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || "").trim();
}

function claudeModel(): string {
  return (process.env.CLAUDE_MODEL || "claude-sonnet-4-5").trim();
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const row = block as { type?: string; text?: string; input?: unknown };
    if (row.type === "text" && typeof row.text === "string") parts.push(row.text);
    if (row.type === "tool_use" && row.input && typeof row.input === "object") {
      try {
        parts.push(JSON.stringify(row.input));
      } catch {
        /* skip */
      }
    }
  }
  return parts.join("\n");
}

async function callClaude(messages: ChatTurn[]): Promise<string | null> {
  const key = anthropicKey();
  if (!key) return null;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: claudeModel(),
        max_tokens: 512,
        system: SYSTEM_PROMPT,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
      }),
      signal: AbortSignal.timeout(25000),
    });

    const raw = await res.text();
    if (!res.ok) {
      console.error("Claude extract error", res.status, raw.slice(0, 400));
      return null;
    }

    let body: { content?: unknown };
    try {
      body = JSON.parse(raw) as { content?: unknown };
    } catch {
      return null;
    }
    const text = contentToText(body.content);
    return text || null;
  } catch (err) {
    console.error("Claude extract call failed", err);
    return null;
  }
}

function firstUserMessage(transcript: string): string {
  return `Extract a listing from this transcript. Reply with the JSON contract only.\n\nTranscript:\n${transcript}`;
}

function repairUserMessage(attempt: number, session: number): string {
  return `That reply did not match the JSON contract (session ${session}, attempt ${attempt}).
Reply again with a single JSON object that includes ALL keys:
item, category, price, condition, location, extra_notes.
Use "" for anything unknown. No markdown, no commentary.`;
}

function verifyUserMessage(call: number, session: number): string {
  return `This is verification turn ${call} of ${CALLS_PER_SESSION} in session ${session}.
Check the JSON against the transcript using this conversation's context.
Return the JSON contract again with all keys present. Fix any misses. No commentary.`;
}

function sessionResetMessage(session: number, transcript: string): string {
  return `Retry session ${session} of ${MAX_RETRY_SESSIONS}. Forget malformed JSON from earlier in this conversation. Extract again from the original transcript. JSON contract only.

Transcript:
${transcript}`;
}

function appendUser(messages: ChatTurn[], content: string): void {
  const last = messages[messages.length - 1];
  if (last?.role === "user") {
    last.content = `${last.content}\n\n${content}`;
    return;
  }
  messages.push({ role: "user", content });
}

async function extractWithClaude(
  transcript: string,
  conversationId: string
): Promise<ExtractFields | null> {
  if (!anthropicKey()) return null;

  const messages = loadConversation(conversationId);
  if (messages.length === 0) {
    appendUser(messages, firstUserMessage(transcript));
  } else {
    appendUser(
      messages,
      `New utterance in this same listing conversation. Merge it with prior context, then return the JSON contract only.\n\nTranscript:\n${transcript}`
    );
  }

  for (let session = 1; session <= MAX_RETRY_SESSIONS; session++) {
    if (session > 1) {
      appendUser(messages, sessionResetMessage(session, transcript));
    }

    let sessionMatch: ExtractFields | null = null;

    for (let call = 1; call <= CALLS_PER_SESSION; call++) {
      const reply = await callClaude(messages);
      if (reply) {
        messages.push({ role: "assistant", content: reply });
        const parsed = parseAssistantContract(reply);
        if (parsed) sessionMatch = parsed;
      }

      if (call < CALLS_PER_SESSION) {
        appendUser(
          messages,
          sessionMatch
            ? verifyUserMessage(call + 1, session)
            : repairUserMessage(call, session)
        );
      }
    }

    if (sessionMatch) {
      saveConversation(conversationId, messages);
      return sessionMatch;
    }
  }

  saveConversation(conversationId, messages);
  return null;
}

function extractPrice(text: string): number | "" {
  try {
    const lower = text.toLowerCase();
    const elfuWord = lower.match(/\belfu\s+(moja|mbili|tatu|nne|tano|sita|saba|nane|tisa|kumi)\b/);
    if (elfuWord) return NUMBER_WORDS[elfuWord[1]] * 1000;
    const elfuDigit = lower.match(/\belfu\s+(\d+)\b/);
    if (elfuDigit) return Number(elfuDigit[1]) * 1000;
    const nearCurrency =
      text.match(/(?:kshs?|kes|bob|shilingi|shillings?)\s*[.:]?\s*(\d{1,3}(?:[,\s]\d{3})+|\d+)/i) ||
      text.match(/(\d{1,3}(?:[,\s]\d{3})+|\d+)\s*(?:kshs?|kes|bob|shilingi|shillings?)/i);
    if (nearCurrency) {
      const n = Number(nearCurrency[1].replace(/[,\s]/g, ""));
      return Number.isFinite(n) ? n : "";
    }
    const grouped = text.match(/\b\d{1,3}(?:[,\s]\d{3})+\b/);
    if (grouped) {
      const n = Number(grouped[0].replace(/[,\s]/g, ""));
      return Number.isFinite(n) ? n : "";
    }
    const digits = text.match(/\b\d{2,7}\b/g);
    if (!digits || !digits.length) return "";
    return Math.max(...digits.map(Number));
  } catch {
    return "";
  }
}

function extractLocation(text: string): string {
  try {
    const lower = text.toLowerCase();
    for (const name of LOCATIONS) {
      if (lower.includes(name.toLowerCase())) return name;
    }
    const iko = lower.match(/\biko\s+([a-z][a-z\s]{2,24})/i);
    if (iko) return iko[1].trim().replace(/[.,;]+$/, "");
    return "";
  } catch {
    return "";
  }
}

function extractCategory(text: string): string {
  try {
    const lower = text.toLowerCase();
    for (const [category, words] of Object.entries(CATEGORY_KEYWORDS)) {
      if (words.some((word) => lower.includes(word))) return category;
    }
    return "";
  } catch {
    return "";
  }
}

function extractCondition(text: string): string {
  try {
    const lower = text.toLowerCase();
    if (/\b(mpya|brand new|new)\b/.test(lower)) return "new";
    if (/\b(used|imetumika|old)\b/.test(lower)) return "used";
    return "";
  } catch {
    return "";
  }
}

function extractItem(text: string): string {
  try {
    let rest = text.trim();
    rest = rest.replace(/^\s*(nauza|ninauza|nina|nataka kuuza|na-uza)\s+/i, "");
    const cut = rest.split(/,|\biko\b|\belfu\b|\bksh\b/i)[0] || rest;
    return cut.trim().replace(/[.,;]+$/, "") || text.trim();
  } catch {
    return text.trim();
  }
}

function extractNotes(text: string, item: string, location: string): string {
  try {
    let rest = text;
    if (item) rest = rest.replace(item, "");
    if (location) rest = rest.replace(new RegExp(location, "ig"), "");
    rest = rest
      .replace(/\b(nauza|ninauza|iko|viwili|kila kimoja|elfu\s+\w+)\b/gi, "")
      .replace(/[,.]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return rest;
  } catch {
    return "";
  }
}

export function extractWithRegex(transcript: string): ExtractFields {
  const text = (transcript || "").trim();
  if (!text) return blankFields();
  const item = extractItem(text);
  const location = extractLocation(text);
  return {
    item,
    category: extractCategory(text),
    price: extractPrice(text),
    condition: extractCondition(text),
    location,
    extra_notes: extractNotes(text, item, location),
  };
}

export async function extractFromTranscript(
  transcript: string,
  options?: { conversationId?: string }
): Promise<ExtractResult> {
  try {
    const conversation_id =
      (options?.conversationId || "").trim() || newConversationId();
    const text = typeof transcript === "string" ? transcript : "";

    const llm = await extractWithClaude(text, conversation_id);
    if (llm) {
      return { ...llm, conversation_id, source: "llm" };
    }
    return { ...extractWithRegex(text), conversation_id, source: "regex" };
  } catch (err) {
    console.error("extractFromTranscript", err);
    return {
      ...extractWithRegex(typeof transcript === "string" ? transcript : ""),
      conversation_id: (options?.conversationId || "").trim() || newConversationId(),
      source: "regex",
    };
  }
}
