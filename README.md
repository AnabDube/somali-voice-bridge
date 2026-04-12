# Somali Voice Bridge

Somali audio transcription and translation web app. Upload Somali audio, get transcriptions via OpenAI Whisper, and translate to English.

## Tech Stack

- **Frontend:** React, TypeScript, Vite, Tailwind CSS, shadcn/ui
- **Backend:** Supabase (Auth, Database, Storage, Edge Functions)
- **AI:** OpenAI Whisper (transcription), Gemini via Lovable AI (translation)

## Setup

```sh
git clone <YOUR_GIT_URL>
cd somali-voice-bridge
npm install
cp .env.example .env   # fill in your Supabase credentials
npm run dev
```

### Supabase Edge Function Secrets

Set these via `supabase secrets set`:

- `OPENAI_API_KEY` — for audio transcription
- `LOVABLE_API_KEY` — for Somali-to-English translation
- `ALLOWED_ORIGIN` — your frontend domain (e.g. `https://yourdomain.com`)

## Features

- Somali audio upload and transcription with segment timestamps
- Somali-to-English translation
- Per-user usage tracking and minute limits
- Subscription plans (Free, Starter, Professional, Business)
- Admin dashboard for user and plan management
- Password reset and email verification
- Light/dark theme
