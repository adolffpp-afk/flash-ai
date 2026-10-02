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

Three keys switch on all twelve engines. An optional fourth key, `FAL_KEY` from
[fal.ai](https://fal.ai), adds more models, and Flash picks the best one for each request:

| Model             | Engine | Picked for                               | Credits |
| ----------------- | ------ | ---------------------------------------- | ------- |
| FLUX.2 Pro        | Image  | Lifelike photos, portraits, product shots | 5       |
| Veo 3.1           | Video  | Video with sound, speech and music        | 50      |
| Kling 3 Turbo Pro | Video  | Longer clips, up to 15 seconds            | 45      |
| MiniMax Music 2.6 | Music  | Full songs with sung lyrics               | 15      |

Everything else stays on the defaults above. Users can also choose a model themselves
from the Model menu under the engine buttons. With only a fal key, fal covers image,
video and music on its own. To add another fal model, add an entry to
`src/lib/models.ts` and its input shape to `falInput` in `app/api/chat/route.ts`. Claude also sharpens image, video and music
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
- **Credits that follow real costs**: one credit is worth one cent at the Starter price,
  and each request costs what Flash pays the AI provider times a markup (2.5 by default,
  `FLASH_MARKUP`). Image, video and music have a fixed price per model. Writing, research,
  code, apps and slides are charged by length: Flash holds up to a limit, then keeps only
  what the reply used. Everyone gets free credits each month and can buy packs through
  Stripe. Failed requests are free, and demo replies cost nothing. Provider prices live in
  `src/lib/credits.ts` and `src/lib/models.ts`, checked on 2026-10-02.
- **Model mix**: Claude Opus 5.5 builds apps, slides and code; Claude Sonnet 5.5 handles
  everyday chat, writing, research and translation; Claude Haiku 4.5 picks the engine
  for requests the keyword rules can't place. Override with `FLASH_BUILD_MODEL`,
  `FLASH_CHAT_MODEL`, `FLASH_ROUTER_MODEL`, or `FLASH_TEXT_MODEL` for both.
- **Landing page** for signed-out visitors, with features, pricing and FAQ, plus draft
  **terms of service** (`/terms`) and **privacy policy** (`/privacy`). Have a lawyer
  review both before taking payments, and set `FLASH_CONTACT_EMAIL`.
- **Owner dashboard** at `/admin` for the emails in `FLASH_ADMIN_EMAILS`: revenue, AI
  provider cost, gross profit, users, requests, cost per day, and breakdowns by tool,
  provider, model and user.
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
  lib/credits.ts            provider prices, markup, length limits, free credits, packs
  components/Landing.tsx    public landing page
  app/terms, app/privacy    draft legal pages
  app/admin, api/admin      owner dashboard
  lib/flashdb-shim.ts       the window.flashDB script injected into apps
  lib/models.ts             image, video and music models and how Flash picks one
  lib/engines/fal.ts        fal.ai queue client
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
npm test        # routing, model picking, pricing, webhook signatures, flashDB
npm run lint
npm run build
```

## Not in this version yet

Multi-file projects, sign-in inside built apps (flashDB data is shared by everyone who
uses a published app), custom domains, password reset and email verification, monthly
subscriptions (credits are bought in packs), a mobile app, team workspaces, real .xlsx
and .docx files, video longer than 8 seconds, and an LLM-based router.
