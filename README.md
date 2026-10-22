# Somali Voice Bridge

Somali audio transcription and translation web app. Upload or record Somali audio, get a transcript with segment timestamps, an English translation, and an AI research summary.

## Tech Stack

- **Frontend:** React, TypeScript, Vite, Tailwind CSS, shadcn/ui. Deployed on Vercel.
- **Backend:** Supabase (Auth, Postgres, Storage, Edge Functions)
- **AI (all via Groq):** Whisper `whisper-large-v3` for transcription; Llama 3.3 70B for translation, transcript cleaning and summaries

## Setup

```sh
git clone <YOUR_GIT_URL>
cd somali-voice-bridge
npm install
cp .env.example .env   # fill in your Supabase credentials
npm run dev            # http://localhost:8080
```

Other scripts: `npm run build`, `npm run lint`, `npm test`.

### Supabase

Apply the migrations in `supabase/migrations/` (`supabase db push`), then deploy the edge functions (`supabase functions deploy`).

Edge function secrets (`supabase secrets set KEY=value`):

| Secret | Purpose |
| --- | --- |
| `GROQ_API_KEY` | Transcription, translation and summaries |
| `ALLOWED_ORIGINS` | Comma-separated list of frontend origins allowed by CORS, e.g. `https://somali-voice-bridge.vercel.app,http://localhost:8080`. Exact match, with no trailing slash. If unset, all browser calls to edge functions are blocked. |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically.

### Vercel

Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in the project's environment variables. `vercel.json` rewrites all routes to `index.html` so deep links and refreshes work.

In the Supabase dashboard, under **Authentication → URL Configuration**, set the Site URL to the production domain and add it to Redirect URLs, otherwise confirmation and password-reset emails link to the wrong place.

> Free-tier Supabase projects pause after about a week of inactivity. A paused project makes login and signup fail with "Can't reach the server" until it is restored from the dashboard.

## Features

- Somali audio upload (up to 25MB) or in-browser recording, with dialect and speaker metadata
- Transcription with segment timestamps, editable transcripts, TXT/PDF export
- English translation, cleaned transcript, research-grade translation and structured summary
- Per-user minute limits that reset monthly (pg_cron job `reset-monthly-usage`)
- Plans: Free, Starter, Pro, Business (online payments not yet implemented)
- Admin dashboard for user and plan management
- Opt-in training-data pipeline: only recordings whose owner ticked the consent box **and** that an admin verified are exported (`export-training-data`)
- Password reset, email verification, light/dark theme

## Processing pipeline

Each recording moves through tracked steps stored in `processing_steps`:
upload → transcription → cleaning / translation / research translation → summary.

- Each step has a status (`pending`, `processing`, `done`, `failed`), a plain-English `error_message`, an attempt count and a timestamp.
- Everything after transcription runs on the server (`run-pipeline`), so closing the tab never leaves a recording half-done. A failure in translation or summary never hides the Somali transcript.
- A pg_cron watchdog (`fail-stuck-steps`, every minute) marks stuck steps as failed so nothing hangs silently. Each failed step has its own Retry button; the server claims a step before working, so double-clicking Retry does nothing extra and minutes are charged only once per recording.
- The dashboard, history and transcript pages all derive their status from the same step rows (`src/lib/pipeline.ts`), and update live over Supabase Realtime.

## Transcript workspace

The transcript is stored as **segments** (`transcript_segments`): timing, Whisper's confidence measures, an optional speaker, the current (possibly corrected) text, and the model's original text, which can never be changed. `transcriptions.somali_text` stays the single "current text" that translation, summaries and the training export read; a trigger keeps it in step with the segments. Older transcripts are converted by the migration, and `ensure_segments()` converts any that appear later.

- Click a timestamp to seek the audio; the segment being spoken is highlighted and followed.
- Segments with a low Whisper confidence (`avg_logprob < -1.0`, or a high compression ratio / no-speech probability) are underlined and labelled "Check this part". On a Somali test recording only `avg_logprob` tracked real errors, so the flag is Whisper's own standard rule.
- Edit in place, label speakers (rename everywhere in one action), find and replace with saved corrections, and search.
- English is shown beside the Somali it translates, in **sections** of about a minute or two (translation works in sections that remember which segments they cover). A section is flagged when a segment in it is edited afterwards, and can be re-translated on its own.
- Export TXT (Somali, English, both), SRT, Word and PDF, with timestamps and speaker names.
- Only the parts of a long transcript near the screen are drawn (`@tanstack/react-virtual`), so a two-hour interview stays fast.

## Security model

- Row-level security on every table; users can only read and write their own rows.
- Plan, usage and training-verification columns can only be changed by admins or the service role (enforced by database triggers, see `20260424000000_security_hardening.sql`).
- All edge functions validate the caller's JWT themselves (`verify_jwt = false` in `config.toml` is intentional) and check ownership or the admin role.
