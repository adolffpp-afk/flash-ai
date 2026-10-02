# Flash AI

One assistant that routes every request to the best AI engine.

Type what you want. Flash decides whether it is a writing task, a research question,
an image, or speech, sends it to the right engine, and keeps the result in a project.

| Engine        | Used for                                          | Provider                         | Key                  |
| ------------- | ------------------------------------------------- | -------------------------------- | -------------------- |
| Write         | Writing, reasoning, questions about files         | Anthropic Claude                 | `ANTHROPIC_API_KEY`  |
| App Builder   | Working web apps, sites, games and dashboards     | Claude                           | `ANTHROPIC_API_KEY`  |
| Slides        | Presentation decks you click or swipe through     | Claude                           | `ANTHROPIC_API_KEY`  |
| Research      | Current facts with sources; reads links you paste | Claude + web search / web fetch  | `ANTHROPIC_API_KEY`  |
| Code          | Writing, explaining and fixing code               | Claude                           | `ANTHROPIC_API_KEY`  |
| Translate     | Translation between languages                     | Claude                           | `ANTHROPIC_API_KEY`  |
| Docs & Sheets | Spreadsheets (download as CSV), letters, reports  | Claude                           | `ANTHROPIC_API_KEY`  |
| Image         | Pictures, logos, illustrations                    | OpenAI `gpt-image-2.5-sunburst`           | `OPENAI_API_KEY`     |
| Video         | 8 second video clips                              | OpenAI Sora (`sora-2-pro`)         | `OPENAI_API_KEY`     |
| Voice         | Reading text aloud                                | ElevenLabs `eleven_v4`          | `ELEVENLABS_API_KEY` |
| Music         | 30 second songs, jingles and beats                | ElevenLabs `music_v2_5`          | `ELEVENLABS_API_KEY` |
| Transcribe    | Turning audio or video files into text            | ElevenLabs `scribe_v2`           | `ELEVENLABS_API_KEY` |

Three keys switch on all twelve engines. Claude also sharpens image, video and music
requests into detailed prompts before they are sent.

Features:

- **App Builder** (like Lovable, Bolt, Base44 or Replit Agent): describe an app and get a
  working one with a live preview. Keep chatting to change it ("add a dark mode"), switch
  to the code view, open it full screen, or download it as a single HTML file.
- **One-click publishing**: Publish puts an app online at `/p/your-app` with a link to
  share. Publish again after changes to update the same link.
- **App databases**: every built app can save data with `window.flashDB` (`list`, `add`,
  `update`, `remove`). Published apps keep their data on the Flash server, shared by
  everyone who uses them; the preview inside Flash uses a throwaway in-memory copy.
- **Accounts**: sign up with email and password. Projects, memory and files are saved
  to your account, so they follow you to any device.
- **Credits**: each request costs credits (text 1, app 10, video 40, music 15, and so on;
  see `src/lib/credits.ts`). Everyone gets free credits each month and can buy packs
  through Stripe. When a request needs more credits than you have, Flash says so and
  offers a top-up. Failed requests are refunded, and demo replies are free.
- **Auto routing** with a manual override for every engine.
- **Projects**: separate chat histories, saved to your account.
- **Memory**: a short note about you that Flash uses in every answer.
- **Files**: attach a PDF, image, CSV or text file to ask about it, or an audio or
  video file to transcribe (up to 25 MB).
- **Downloads**: spreadsheets, documents, code, images, video and audio all download
  with one click.
- **Demo mode**: every engine works without keys, so you can try the app first.

## Run it

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
cp .env.example .env.local   # then paste your API keys into .env.local
npm run dev
```

Open http://localhost:3000 and create an account. Data is stored in `flash.db`
in the project folder.

## Deploy it

The easiest host is [Vercel](https://vercel.com): import the repository, add the same
keys under **Settings → Environment Variables**, and deploy. Any Node.js host works
(`npm run build && npm start`).

Serverless hosts like Vercel can't keep a local database file, so set `DATABASE_URL`
and `DATABASE_AUTH_TOKEN` to a hosted libSQL database (Turso has a free tier). To take
payments, add `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` and point a Stripe webhook
at `/api/billing/webhook` for the `checkout.session.completed` event.

Published apps run under a sandbox header that blocks them from reading Flash's cookies,
but they are served from the same domain. For a public launch, serve `/p/*` from a
separate domain.

On Vercel, uploads are capped at about 4.5 MB per request, and video generation needs
long-running functions (the Pro plan), because a clip can take a few minutes.

## How it works

```
src/
  app/page.tsx              the page
  components/Flash.tsx      sidebar, chat, composer
  components/Message.tsx    renders text, images, audio, sources
  app/api/chat/route.ts     picks the engine and streams the reply (NDJSON)
  app/api/status/route.ts   which engines have keys
  lib/router.ts             the routing rules
  app/api/auth/*            sign up, sign in, sign out
  app/api/me, projects      account, memory and saved projects
  app/api/billing/*         Stripe Checkout and webhook
  app/api/files/[id]        generated images, video and audio
  app/api/sites/*, app/p/   publishing and flashDB for published apps
  lib/server/               database, auth, credits, Stripe
  lib/credits.ts            what each engine costs, free credits, packs
  lib/flashdb-shim.ts       the window.flashDB script injected into apps
  components/AppPreview.tsx sandboxed live preview for built apps and decks
  lib/engines/builder.ts    App Builder and Slides
  lib/engines/claude.ts     writing, code, translation, docs, research
  lib/engines/media.ts      images, video, voice, music, transcription
  lib/engines/demo.ts       demo replies when a key is missing
```

Adding an engine means one function in `lib/engines/`, one rule in `lib/router.ts`,
and one case in `app/api/chat/route.ts`.

## Checks

```bash
npm test        # routing, webhook signatures, flashDB
npm run lint
npm run build
```

## Not in this version yet

Multi-file projects, sign-in inside built apps (flashDB data is shared by everyone who
uses a published app), custom domains, password reset and email verification, monthly
subscriptions (credits are bought in packs), a mobile app, team workspaces, real .xlsx
and .docx files, video longer than 8 seconds, and an LLM-based router.
