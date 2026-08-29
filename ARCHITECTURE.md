# Mboka AI

A voice-first marketplace for Kenya’s jua kali traders. You describe what you sell out loud. We transcribe it, read a summary back, and post a structured listing to a public feed.

Traders can come in through a **web app**, a **phone call**, or **USSD**. Buyers browse one feed.

How to run the repo: `README.md`.

---

**Priority order on**

1. Speak a listing on the phone → hear confirmation → see it in the feed.
2. Show a USSD-created listing in that same feed (simulated phone UI is fine).
3. A live call that posts to the same feed — or a short recording of that call.
4. The closing line in the demo script below.

Do not put more than two people in the same file. Almost everything today is in `server.ts` and `public/index.html`; split before you fan out (file list below).

### Already in the repo

- Record → ElevenLabs STT → keyword extract in the browser → ElevenLabs TTS → confirm / re-record → `POST /listings`
- Feed with category and location filters, All / Mine, Call and WhatsApp, optional photo, mark sold
- In-memory store, five seed listings, listing JSON as in the data model below (`audio_url` and `narration_url` not stored yet)

Still to build: LLM extract, listing detail + audio playback, voice call, USSD UI.

### Do not rebuild

Already done: mic, silence stop, `/transcribe`, `/speak`, confirm / re-record, photo, phone, category + location filters, All / Mine, Call / WhatsApp, mark sold, five seeds, `GET`/`POST`/`PATCH /listings`.

### People (P1–P9)

Put a name next to each. One owner per file after the split.

1. **P1 — Split the repo + listings store**
   - Files: `lib/store.ts`, `server.ts` (wiring only)
   - Move the in-memory array, seeds, get/create/patch into `lib/store.ts`.
   - `server.ts` only mounts routes and listens — no logic.
   - Add extra seed listings with `source_channel: "call"` and `source_channel: "ussd"` set, so the feed already looks multi-channel before real ones land.
   - Done when: anyone else can import `{ store }` from `lib/store` without touching `server.ts`.
   - Unblocks: everyone. Do this first, in the first 15 minutes.
2. **P2 — Live URL + Swahili voice test**
   - Files: `lib/elevenlabs.ts` (move STT/TTS out of `server.ts`, coordinate with P1 on timing)
   - ✅ Deployed to Render, `ELEVENLABS_API_KEY` set.
   - Hit the URL every ~10 minutes so the free instance doesn't sleep.
   - Record the test sentence below on an actual phone, run it through STT. If it's bad on Swahili/Sheng, say so in the room — the fallback is demoing clearer speech, not silently pressing on.
   - Store `audio_url` (original recording) and `narration_url` (TTS output) on the listing object once a listing exists to attach them to.
   - Done when: HTTPS link is in the chat; one spoken listing has round-tripped through Render. Never fully stops — keep pinging the URL through the whole event.
3. **P3 — Extraction API**
   - Files: `lib/extract.ts` only
   - Move the keyword/regex extractor out of `index.html` into its own module.
   - `POST /extract` — body `{ transcript }` → returns `{ item, category, price, condition, location, extra_notes }`.
   - If an LLM key exists: try LLM first, fall back to regex on failure. If no LLM key by minute 15: regex only, then go help P4.
   - Never throw. Missing fields come back blank, not as an error.
   - Done when: the test sentence below returns `price: 5000`, `location: "Kawangware"`, `category: "furniture"`.
4. **P4 — Confirm panel talks to extract**
   - Files: `public/index.html` only — the record/confirm UI, not the feed (that's P5's)
   - After STT returns, call `POST /extract` instead of the old inline function.
   - If item, price, or location comes back missing, show one inline prompt — don't block the Confirm button on it.
   - Keep the same prefill behavior and the Confirm / Re-record buttons as they exist today.
   - Depends on: P3. Until `/extract` exists, leave the current inline function in place — don't break the working path while waiting.
   - Done when: a spoken listing fills the form via the API, not the old inline keyword match.
5. **P5 — Buyer: tap a listing**
   - Files: `public/feed.js` — cut the feed out of `index.html` (P4 keeps the recorder half)
   - Card tap → detail view: item, price, location, category, condition, notes, source_channel.
   - Play `audio_url` and/or `narration_url` if either is present on the listing.
   - Leave filters, Call, and WhatsApp links exactly as they work today — don't refactor them.
   - Depends on: P1 (store), can start as soon as the feed is cut out of `index.html`.
   - Done when: a judge can open both a seed listing and a live-posted one and see/hear the detail view.
6. **P6 — Call: answer the phone**
   - Files: `routes/call.ts` (new). Provider: Africa's Talking Voice (already decided in architecture.md — don't re-litigate Twilio vs. AT). Depends on: `lib/elevenlabs.ts` (P2). If it's not landed yet, inline a temporary STT call and swap the import in later.
   - Steps:
     1. Confirm you have an AT sandbox number and can set its Voice callback URL to your Render URL. This is the clock-starter — check it immediately.
     2. Route A (`POST /call/answer`, set as the AT callback URL): respond with XML — `<Say>` the greeting ("Niambie unauza nini?"), then `<Record>` with a callbackUrl pointing to Route B. Use `<Record>`, not `<GetDigits>` — you want speech, not keypad digits.
     3. Route B (the callbackUrl from the `<Record>` action): AT POSTs the finished recording's URL here. Pass it to the STT helper, `console.log` the transcript.
     4. Every route must respond with valid `<Response>` XML, even the last one, or AT drops the call as malformed. At 20 minutes with no working sandbox number: stop, go help P5 or P8. Screen-record whatever partial flow you have (even just the greeting playing) as a fallback demo asset.
   - Done when: you can dial in, hear the greeting, speak, and see a transcript land in the server logs. Nothing gets written to the store yet — that's P7. Coordinate with P7 before you both touch `routes/call.ts` — agree on the shape of the transcript hand-off (e.g. does Route B call P7's function directly, or write to a shared in-memory object?) before either of you starts typing.
7. **P7 — Call: confirm and post**
   - Files: `routes/call.ts`, alongside P6 (P6 owns inbound audio; P7 owns dialogue + write)
   - Take the transcript P6 produces, call the same `POST /extract` used by the web path.
   - If item, price, or location is missing, ask one spoken follow-up at a time (e.g. "Bei ni ngapi?") — not a list of questions.
   - Once all three are present, have ElevenLabs read the summary back and ask for confirmation.
   - On "yes": `POST /listings` with `source_channel: "call"`.
   - Optional stretch, only if time allows: "badilisha bei" to correct one field without restarting. Skip SMS entirely unless a key is already configured.
   - Depends on: P6 (needs a working transcript hand-off first), P3 (`/extract`). At 90 minutes with nothing in the feed: stop, go help P2 or P5. Keep a screen recording of whatever you got working as a backup.
   - Done when: a call you make yourself appears as a listing in the live web feed.
8. **P8 — USSD simulator**
   - Files: `public/ussd.html` only
   - Build a fake feature-phone frame (no real telecom involved).
   - Menu tree, exact copy from architecture.md:
     - Karibu Jua Kali Marketplace. 1. Uza kitu 2. Tafuta fundi
     - Category: 1. Vitu vya mbao 2. Nguo 3. Chakula 4. Huduma 5. Nyingine
     - Price (digit entry)
     - Location (preset list, or free text ≤20 chars)
     - Confirm: 1. Ndio 2. Hapana
   - On confirm: `POST /listings` with `source_channel: "ussd"`, no `audio_url`, no `photo_url`.
   - Do not wait on a live *384*# shortcode — this is explicitly simulated, and that's fine per architecture.md.
   - Depends on: the shared `POST /listings` endpoint (P1) existing.
   - Done when: one USSD-sourced card shows up in the same feed as web listings.
9. **P9 — Demo, merges, Render env**
   - No feature files — only touches things to unblock someone else.
   - Own `.env` / Render dashboard, keys shared in chat.
   - Sole merge referee on main — nobody else merges to avoid conflicts.
   - Rehearse the full demo script twice, on the actual phone + projector setup you'll use on stage.
   - Record a backup video of a complete web-only loop (record → confirm → feed) in case live networking fails on stage.
   - Wake the Render URL ~2 minutes before going on stage.
   - Done when: two full rehearsals are done, a backup clip exists on a phone, and everyone has the live link.

If P3 has no LLM key, P3 joins P4. If P6/P7 have no number, both join P5 and P8. P2 never stops.

### Files after the split

Stay on your files. One listing JSON (data model below). One `POST /listings`. One Express app. One Render web service.

| File | Who |
|---|---|
| `lib/store.ts`, `server.ts` | P1 |
| `lib/elevenlabs.ts`, Render | P2 |
| `lib/extract.ts` | P3 |
| `public/index.html` | P4 |
| `public/feed.js` | P5 |
| `routes/call.ts` | P6 + P7 |
| `public/ussd.html` | P8 |
| Merges, demo, env | P9 |

### Clock

If Swahili STT is poor in the first half hour, demo a clearer Swahili/English mix and treat mixed Sheng as follow-up, not a blocker.

---

## Problem

Millions of informal (“jua kali”) traders in Kenya — carpenters, welders, tailors, mechanics, mama mbogas, electricians — have real inventory and real skills to sell, but almost no digital storefront. The barrier is not lack of a phone. It is the friction of *typing* a listing: forms, categories, descriptions in a second language, photos. These traders already talk about what they sell all day, in Swahili, Sheng, and English, often in the same sentence.

Remove the typing. Let someone create a listing the way they would describe it to a customer standing in front of them. Meet them on the device they have: feature phone (USSD), any phone (voice call), or smartphone (web).

## Product

A listing enters as speech (or as USSD menu input) and comes back as speech for confirmation and as structured data for buyers.

```
                    ┌─────────────────────┐
   USSD  ─────┐     │                     │
   Call  ─────┼────▶│  Unified listings   │────▶  Public feed (web)
   Web   ─────┘     │                     │
                    └─────────────────────┘
```

USSD is numbers and short text, not voice. It still writes the same listing record.

## People we are building for

| Who | Situation | Channel |
|---|---|---|
| Amina | Furniture, tailoring, or food; feature phone; Swahili/Sheng; does not want to type long text | USSD or call |
| Amina’s cousin | WhatsApp and a basic smartphone | Web |
| Brian | Looking for a local fundi or item; browses on a phone | Web feed |
| Us, on stage | Need the full loop to work live | Web first; call if it is ready |

## Channel A — Web app with voice

This is the path we can always demo. No telephony.

1. Mobile-first page. One large mic button.
2. Tap to record. Example: *“Nauza viti vya mbao, viwili elfu tano kila kimoja, iko Kawangware, tunatengeneza pia meza.”*
3. Stop on tap, or after about 2 seconds of silence.
4. Audio → speech-to-text.
5. Transcript → extraction → JSON: `{item, category, price, condition, location, extra_notes}`.
6. ElevenLabs reads back: *“Umeongeza: Viti vya mbao, KSh 5,000, Kawangware. Sawa?”*
7. **Confirm** or **Re-record**. Optional one photo. Then the listing is live.
8. **My listings** by phone number only (no accounts). Edit or mark sold.

Buyers, same app:

- Feed, newest first, filter by category and location.
- Open a listing for details; play the original recording or the ElevenLabs summary if we stored it.
- `tel:` and `wa.me` — no in-app chat.
- Stretch: speak a search query, transcribe, match listing fields.

Repo today covers record, TTS confirm, confirm/re-record, feed filters, Mine, Call/WhatsApp, photo, mark sold. Extraction is still keywords. Detail page and stored audio are still open.

## Channel B — Voice call

Highest wow if it works. Highest risk.

1. Trader dials the Twilio or Africa’s Talking number.
2. Agent answers in 1–2 rings. Swahili or English; a short language prompt if needed.
3. Open question: *“Niambie unauza nini?”*
4. Trader speaks freely. No rigid script.
5. Near-real-time transcript → same extraction as the web.
6. If item, price, or location is missing, ask **one** follow-up at a time (*“Bei ni ngapi?”*), not a list.
7. When those three are present, ElevenLabs reads the listing back and asks for confirmation.
8. *“Badilisha bei”* (or similar) corrects one field without restarting.
9. On confirm: listing is live; SMS or WhatsApp link if we have SMS keys.
10. Same feed as web and USSD (`source_channel: "call"`).

If transcription is clearly bad (market noise), ask them to repeat. Do not guess a wrong listing. Barge-in is nice-to-have, not required.

Use the same extract and ElevenLabs helpers as the web. Pick **one** telephony provider — the one with a sandbox number at minute 15.

## Channel C — USSD

Numeric menus. Demo a **simulated feature phone** unless a live short code is already working.

1. Dial e.g. `*384*XX#` (live) or tap through the fake phone UI (demo).
2. Screens:
   - *Karibu Jua Kali Marketplace. 1. Uza kitu 2. Tafuta fundi*
   - Selling: 1. Vitu vya mbao 2. Nguo 3. Chakula 4. Huduma 5. Nyingine
   - Price (digits)
   - Location (preset list, or ≤20 characters)
   - Confirm: 1. Ndio 2. Hapana
3. Write the listing with `source_channel: "ussd"` (no voice or photo). SMS confirm if Africa’s Talking SMS is set up.
4. If the session drops, keep a partial draft for about 5 minutes so they can resume.

A live USSD code in three hours is unlikely. The sim should use the real menu copy and the real `POST /listings`. That is enough to show “same backend, works on a cheap phone with no internet.”

## Data model

Every channel writes this shape:

```json
{
  "id": "uuid",
  "item": "string",
  "category": "furniture | clothing | food | services | electronics | other",
  "price": "number (KES)",
  "condition": "string, optional",
  "location": "string (area name)",
  "contact": "phone number",
  "source_channel": "web | call | ussd",
  "audio_url": "string, optional — original recording",
  "narration_url": "string, optional — ElevenLabs summary",
  "photo_url": "string, optional",
  "extra_notes": "string, optional",
  "status": "active | sold | flagged | removed",
  "created_at": "timestamp"
}
```

The starter already uses this. `id` is a generated string. Store `audio_url` / `narration_url` as data URLs if needed. Do not write files to Render’s disk (the free filesystem is wiped on restart).

Default store: in-memory array, seeds in code. Add Render Postgres only if it is created in the first 20 minutes and the JSON does not change. Do not use SQLite on disk.

## Pipeline (web and call)

```
Audio
  → ElevenLabs speech-to-text (Swahili / Sheng / English, including mixed)
  → LLM extract → JSON (regex if the LLM call fails)
  → item, price, location present?
        no  → one follow-up (call) or re-record (web)
        yes → ElevenLabs reads the summary
  → confirm / edit one field / re-record
  → write listing → public feed
```

USSD skips audio and TTS; it still validates and writes.

Stay on ElevenLabs Scribe (`scribe_v2`) unless the first test fails on Swahili. For TTS, prefer `eleven_v3` with `language_code: sw`. `eleven_multilingual_v2` does not list Swahili; the server already falls back if v3 is rejected.

## Stack 

| Layer | Choice |
|---|---|
| Web UI | Plain HTML/JS, mobile-first. No React |
| STT / TTS | ElevenLabs |
| Extract | `POST /extract` (LLM) + regex fallback |
| Call | Africa’s Talking Voice |
| USSD | Simulated UI; live AT USSD only if it already works |
| API | Node, Express, TypeScript (`tsx`), `npm start` |
| Host | One Render Web Service (API + static) |
| Photos | One image, data URL on the listing. No S3 |

Sponsors we must show: Cursor, ElevenLabs, Render.

## Quality bar

- Mixed Swahili / Sheng / English in one utterance. Test in the first 20 minutes.
- Speak → confirm audio in about 10 seconds per turn if we can.
- Light pages, no bundler.
- Phone number is identity. No passwords.
- Bad STT → ask to repeat, do not post garbage.
- Render free instances sleep and lose memory. Hit the URL two minutes before stage. Do not depend on listings posted hours earlier.

## Demo

1. Open the web app on a phone, mirrored.
2. Speak a real listing in Swahili/Sheng.
3. ElevenLabs confirms the extracted listing.
4. Confirm. It appears in the feed next to the seeds.
5. If the call track is live: dial in and repeat.
6. USSD sim: same backend, framed as working on a KSh 2,000 phone with no data.
7. Close: *“Millions of informal traders in Kenya have inventory and skills but no digital storefront, because typing a listing is friction they don't have time or comfort for. This removes that friction completely — you just talk, on whatever phone you already own.”*

The demo person runs this twice before we go on.

## Out of scope

- Payments
- In-app messaging (`tel:` and WhatsApp only)
- Accounts and passwords
- Moderation beyond flag / remove
- More than one photo
- Production retries and scale
- A second framework, host, or listings store

Voice search is stretch for the feed pair, and only after the detail view works.

## Risks

| Risk | What we do |
|---|---|
| STT struggles with Sheng | Test early; demo clearer speech if needed |
| Call setup eats the night | 90-minute cutoff; web + USSD sim still tell the story |
| Network / Render cold start | Backup video; wake the URL before we present |
| No live USSD code | Simulated phone, real API |
| Merge conflicts | One person on demo/glue owns merges |
| Memory wipe on sleep | Seeds in code |

## Test sentence

> Nauza viti vya mbao, viwili elfu tano kila kimoja, iko Kawangware, tunatengeneza pia meza.

Expect wooden chairs (and tables), about KSh 5,000, Kawangware, furniture.

## Env

| Name | Required |
|---|---|
| `ELEVENLABS_API_KEY` | Yes, for voice |
| `PORT` | No. Render sets it |
| LLM key | Only if extract is using an LLM |
| Telephony keys | Only if the call track is live |

Do not add unused env vars.
