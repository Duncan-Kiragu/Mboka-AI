# Mboka AI

Voice-first listing starter for Kenya's jua kali traders. Speak a listing, hear it read back, confirm, and it lands on a public feed.

**Product spec, three channels:** see [`ARCHITECTURE.md`](ARCHITECTURE.md). 


## Starter Files

| File | What it is |
|---|---|
| `server.ts` | Express API + in-memory listings + ElevenLabs STT/TTS |
| `public/index.html` | Whole frontend (UI, recorder, keyword extraction, feed) |
| `.env.example` | Copy to `.env` and paste your ElevenLabs key |
| `package.json` | `npm start` / `npm run dev` |

No React, no bundler, no database. Extraction is keyword/regex in the browser so it works without an LLM key. Swap `extractListing()` later if you add one.

## Run locally

```bash
cp .env.example .env
# paste ELEVENLABS_API_KEY into .env

npm install
npm run dev
```

Open http://localhost:3000

`npm start` is the same server without file watching.

Microphone recording needs **localhost or HTTPS**. It will not work on a raw `http://192.168.x.x` LAN URL in most browsers.

## Env vars

| Name | Required | Who sets it |
|---|---|---|
| `ELEVENLABS_API_KEY` | Yes for voice | You, in `.env` locally and in the Render dashboard |
| `PORT` | No | Render sets this. Do not hardcode it |

The feed still loads without the key. Record/confirm-audio will show an error until the key is set.

## Deploy on Render

1. Push this repo to GitHub.
2. New **Web Service** from that repo.
3. Build command: `npm install`
4. Start command: `npm start`
5. Add env var `ELEVENLABS_API_KEY`
6. Leave `PORT` alone

One service serves both the API and the page. Do not add a second Static Site.

Free Render web services **sleep after idle** and wipe in-memory listings. Seeded demo cards come back; live posts from before the sleep do not. That is expected until someone adds Postgres.

## API

- `GET /health` — process is up; whether the ElevenLabs key is present
- `GET /listings` — newest first
- `GET /listings/:id`
- `POST /listings` — body: `item`, `price`, `location`, `category`, `condition`, `contact`, `photo_url`, `source_channel`
- `PATCH /listings/:id` — e.g. `{ "status": "sold" }`
- `POST /transcribe` — `{ "audio": "<base64>", "mimeType": "audio/webm" }` → `{ "transcript": "..." }`
- `POST /speak` — `{ "text": "Umeongeza: ..." }` → `audio/mpeg`

Listing JSON matches the build-spec shape (`created_at`, `source_channel`, `photo_url`, …). `audio_url` / `narration_url` are not stored yet.

## How to extend

- **Better extraction:** replace `extractListing()` in `public/index.html`, or add `POST /extract` in `server.ts` and call it from there.
- **Call / USSD:** write into the same `POST /listings` with `source_channel: "call"` or `"ussd"`. Do not start that until this web loop is deployed.
- **Postgres:** replace the `listings` array in `server.ts`. Do not put SQLite on disk — Render's free filesystem is wiped on restart.

## Out of scope

See `ARCHITECTURE.md` §12. This starter still has no LLM extract, no live call, and no USSD UI — those are the 3-hour parallel tracks, not extra hosts or frameworks.
