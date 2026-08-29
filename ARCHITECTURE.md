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

**P1 — Split the repo + listings store**  
Files: `lib/store.ts`, `server.ts` (wiring only)  
- Move the in-memory array, seeds, get / create / patch into `lib/store.ts`.  
- `server.ts` only mounts routes and listens.  
- Unblock everyone else in the first 15 minutes.  
Then: extra seed listings that look like call + USSD (`source_channel` set).  
Done: others can import `store` without touching `server.ts`.

**P2 — Live URL + Swahili voice test**  
Files: `lib/elevenlabs.ts` (move STT/TTS out of `server.ts` with P1)  
- Deploy to Render now. Keep `ELEVENLABS_API_KEY` on the service.  
- Hit the URL every 10 minutes so it does not sleep.  
- Record the Kawangware test sentence on a **phone**. If STT is bad, tell the room and we demo clearer speech.  
- Store `audio_url` (recording) and `narration_url` (TTS bytes as data URL, or a `/speak` replay) on the listing when we have them.  
Done: HTTPS link in the chat; one spoken listing has landed on Render.

**P3 — Extraction API**  
Files: `lib/extract.ts` only  
- Move keyword/regex extract out of `index.html`.  
- `POST /extract` `{ transcript }` → `{ item, category, price, condition, location, extra_notes }`.  
- If an LLM key exists: LLM first, regex if it fails. If no key at 15 min: regex only, then help P4.  
- Never throw; blank fields are fine.  
Done: test sentence returns price 5000, location Kawangware, category furniture.

**P4 — Confirm panel talks to extract**  
Files: `public/index.html` only (record + confirm — not the feed)  
- After STT, call `POST /extract` instead of the inline function.  
- If item, price, or location is missing, show one inline prompt (do not block confirm).  
- Prefill the same fields as today; keep Confirm / Re-record.  
Depends on P3. Until `/extract` exists, leave the current function.  
Done: spoken listing fills the form from the API.

**P5 — Buyer: tap a listing**  
Files: `public/feed.js` (cut the feed out of `index.html`; P4 keeps the recorder)  
- Card tap → detail: item, price, location, category, condition, notes, `source_channel`.  
- Play `audio_url` and/or `narration_url` if present.  
- Filters, Call, WhatsApp stay as they are.  
Done: judge can open a seed and a live post.

**P6 — Call: answer the phone**  
Files: `routes/call.ts`  
- One provider (Twilio **or** Africa’s Talking — the one with a number).  
- Webhook: answer, greet, *“Niambie unauza nini?”*, capture audio, send to existing `/transcribe` (or ElevenLabs helper).  
- At 20 min with no sandbox number: stop and help P5 or P8. Record a backup of whatever you have.  
Done: you can dial in and get a transcript in the logs.

**P7 — Call: confirm and post**  
Files: `routes/call.ts` with P6 (P6 owns inbound audio; P7 owns dialogue + write)  
- Same `POST /extract` as the web.  
- Missing item / price / location → **one** spoken follow-up.  
- ElevenLabs reads the summary; on yes → `POST /listings` with `source_channel: "call"`.  
- Optional: *badilisha bei*. Skip SMS unless the key is already there.  
At 90 min if nothing in the feed: stop, help P2/P5, keep a screen recording.  
Done: a call appears in the web feed.

**P8 — USSD simulator**  
Files: `public/ussd.html` only  
- Fake feature-phone frame. Menus from the spec (Karibu → category → price → location → Ndio/Hapana).  
- Confirm → `POST /listings` with `source_channel: "ussd"` (no audio, no photo).  
- Do not wait for a live `*384*#`.  
Done: one USSD card in the same feed as web listings.

**P9 — Demo, merges, Render env**  
No feature files unless unblocking.  
- P1–P8, keys in the chat, `.env` / Render dashboard.  
- Merge referee (one person on `main`).  
- Rehearse the demo script twice on the **phone + projector**.  
- Backup video of a full web loop. Wake the Render URL 2 minutes before stage.  
Done: two rehearsals; clip on a phone; everyone has the live link.

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
