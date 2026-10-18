# Flash AI

One assistant that routes every request to the best AI engine.

Type what you want. Flash decides whether it is a writing task, a research question,
an image, or speech, sends it to the right engine, and keeps the result in a project.

| Engine        | Used for                                          | Provider                         | Key                  |
| ------------- | ------------------------------------------------- | -------------------------------- | -------------------- |
| Write         | Writing, reasoning, questions about files, weather (live forecast) | Anthropic Claude + MET Norway forecast | `ANTHROPIC_API_KEY`  |
| App Builder   | Working web apps, sites, games and dashboards     | Claude                           | `ANTHROPIC_API_KEY`  |
| Slides        | Presentation decks you click or swipe through     | Claude                           | `ANTHROPIC_API_KEY`  |
| Research      | Current facts with sources; reads links you paste | Claude + web search / web fetch  | `ANTHROPIC_API_KEY`  |
| Code          | Writing, explaining and fixing code               | Claude                           | `ANTHROPIC_API_KEY`  |
| Translate     | Translation between languages                     | Claude                           | `ANTHROPIC_API_KEY`  |
| Docs & Sheets | Spreadsheets (download as CSV), letters, reports  | Claude                           | `ANTHROPIC_API_KEY`  |
| Image         | Pictures, logos, illustrations                    | OpenAI `gpt-image-2.5-sunburst`           | `OPENAI_API_KEY`     |
| Video         | 8 second clips with sound, longer clips, short films | fal.ai Veo 3.1 (`veo-3.1`), Kling 3 | `FAL_KEY`            |
| Voice         | Reading text aloud                                | ElevenLabs `eleven_v4`          | `ELEVENLABS_API_KEY` |
| Music         | 30 second songs, jingles and beats                | ElevenLabs `music_v2_5`          | `ELEVENLABS_API_KEY` |
| Transcribe    | Turning audio or video files into text            | ElevenLabs `scribe_v2`           | `ELEVENLABS_API_KEY` |

Answers can also look things up in free public data. Each source stays hidden until its
variables are set (steps in `docs/research-sources-setup.md`):

| Source    | Used for                                                     | Key                                                    |
| --------- | ------------------------------------------------------------ | ------------------------------------------------------ |
| SearXNG   | Free web search for users out of credits (your own server)   | `SEARXNG_URL`, `SEARXNG_USERNAME`, `SEARXNG_PASSWORD`  |
| SEC EDGAR | A listed company's filings and reported figures            | none (`FLASH_CONTACT_EMAIL` goes in its User-Agent)    |
| FRED      | Economic indicators: unemployment, inflation, GDP, rates     | `FRED_API_KEY`                                         |

Published apps can also be checked with Google's free PageSpeed Insights from My websites & apps ›
SEO (it isn't something answers look up; steps in the same file):

| Source             | Used for                                                    | Key                            |
| ------------------ | ----------------------------------------------------------- | ------------------------------ |
| PageSpeed Insights | Speed, accessibility and SEO scores for a published app     | `PAGESPEED_API_KEY` (optional) |

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
  code, apps and slides are charged by length: Flash holds credits for the reply, caps the
  reply's length at what those credits pay for (so no request can cost more than it
  earns), then keeps only what the reply used. Everyone gets free credits each month. Failed requests are free, and demo replies cost nothing. Provider prices live in
  `src/lib/credits.ts` and `src/lib/models.ts`, checked on 2026-10-02.
- **Plans like Lovable and Emergent**: Free (200 credits a month), Pro ($25, 3,000 credits),
  Power ($50, 6,500) and Max ($200, 28,000), 20% off when paid yearly, plus one-off
  top-ups (500 for $5, 2,200 for $20, 5,800 for $50). Credits arrive every month, yearly
  plans included, and unused credits carry over. Every plan and top-up makes a profit even
  if the buyer uses every credit, after AI cost and Stripe fees; `test/pricing.test.ts`
  checks this and the owner dashboard shows the margin per plan. Plans live in
  `src/lib/credits.ts`.
- **Account safety**: with `RESEND_API_KEY`, new accounts confirm their email before they
  get free credits or free daily messages, "Forgot password" sends a one-hour reset link
  (which signs out every other device), and Gmail-style aliases (dots, +tags) count as one
  inbox, so free credits can't be farmed. Sign-ups, sign-ins and emails are rate limited in
  the database, so the limits hold across server instances.
- **More ways to sign in**: "Email me a sign-in link" (one use, 15 minutes) works whenever
  emails do, and "Continue with Google / GitHub / Microsoft" appear once their keys are set
  (see `docs/sign-in-setup.md`). Accounts are matched by provider-confirmed email.
- **Free lane when credits run out**: with the optional free keys (Groq, Gemini, OpenRouter,
  Cloudflare Workers AI, Mistral), users who are out of credits keep chatting, writing, coding
  and translating on free models (GPT-OSS 120B, Gemini Flash-Lite, Llama 3.3 70B, Mistral
  Small), and get a few free FLUX.1 schnell images a day. Each user gets a daily allowance,
  and Flash stops below each provider's free limit, so the free lane costs nothing. The first
  model asked depends on the request (`src/lib/free-order.ts`): Groq for short questions,
  sums and code, as it's the fastest; Gemini for long inputs and messages not in English,
  where its free tier may answer; the others stay backups in the usual order. Weather
  questions get the live forecast through the models' own function calling (Groq, Gemini and
  Mistral, asked first for them). With SearXNG set, research questions get a free web search
  (up to 2 a reply, `FLASH_FREE_DAILY_SEARCHES` a day per user, and a daily total for Flash),
  with numbered sources; without it, or when the search fails, they are answered without the
  web, and the reply says so. Apps, video, music, voice and paid web research stay on
  credits. See `src/lib/engines/free.ts`.
- **Live weather and the date**: every written answer knows the user's date, local time and rough
  place (from the connection), and weather questions are answered from MET Norway's free
  forecast (Locationforecast 2.0, no key or account). Flash's server asks MET with the place
  rounded to about 1 km, honours MET's `Expires`, and keeps forecasts in the database for up
  to 2 days, shared by everyone in the same place; `FLASH_CONTACT_EMAIL` goes in the
  User-Agent MET asks for. Answers that use it show "Based on data from MET Norway"
  (linking to met.no) and "CC BY 4.0": MET's data is CC BY 4.0 and NLOD 2.0, and its terms
  allow commercial use with that credit. See `src/lib/weather.ts` and
  `src/lib/server/weather.ts`.
- **Public data (web search, SEC EDGAR, FRED)**: questions about current events, a listed
  company's filings or figures, or the economy get tools the AI calls like the forecast's.
  Free web search runs through the owner's own SearXNG (HTTP Basic auth, https only) on the
  free lane; paid Research keeps its own web search. SEC EDGAR (no key) gives a company's
  recent filings and reported figures from its XBRL data, about 5 requests a second across
  Flash, with the User-Agent the SEC asks for. FRED gives economic series with a free key;
  answers that use it end with FRED's notice and a link to its API terms, and copyrighted
  series are refused. On paid replies each round of these tools is priced and checked like
  the forecast's, within the credits held; on the free lane they cost nothing. Every request
  has a timeout and size cap, results are cached briefly in the database, and a failed source
  is reported as failed, never guessed. See `src/lib/research.ts` and `src/lib/server/`
  (`searxng.ts`, `sec.ts`, `fred.ts`, `source-fetch.ts`).
- **Model mix**: Claude Opus 5.5 builds apps, slides and code; Claude Sonnet 5.5 handles
  everyday chat, writing, research and translation; Claude Haiku 5.5 picks the engine
  (or the forecast) for requests the keyword rules can't place. Override with
  `FLASH_BUILD_MODEL`, `FLASH_CHAT_MODEL`, or `FLASH_TEXT_MODEL` for both.
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
  video file to transcribe (up to 3 MB on Vercel Hobby).
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

**Deploying on Vercel:** import the GitHub repo in Vercel (it detects Next.js), then add the
environment variables from `.env.example` under Settings → Environment Variables. On the
Hobby plan a request may run for 300 seconds and send at most 4.5 MB, so files are capped at
3 MB; long video jobs may need Vercel Pro (raise `maxDuration` in `src/app/api/chat/route.ts`
to 800).

Serverless hosts like Vercel can't keep a local database file, so set `DATABASE_URL`
and `DATABASE_AUTH_TOKEN` to a hosted libSQL database (Turso has a free tier). To take
payments, add `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` and point a Stripe webhook
at `/api/billing/webhook` for the `checkout.session.completed`, `invoice.paid`,
`customer.subscription.updated` and `customer.subscription.deleted` events. The billing
portal (card, invoices, cancel at period end) is set up automatically on first use, with
plan changes switched off; switching plans goes through a new checkout and starts a new
month, so a switch can never refund credits already used.

Apps that sell through their owners' own Stripe accounts (Stripe Connect) need a second
webhook that listens to **events on connected accounts**, at `/api/stripe/connect`, for
`checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`
and `charge.dispute.created`, with its signing secret in `STRIPE_CONNECT_WEBHOOK_SECRET`. It
saves an order when it is paid even if the buyer closes the tab, and keeps refunds and disputes
with it. Test-mode events never become orders under a live key. Optionally, set
`STRIPE_CONNECT_CLIENT_ID` to Flash's own Connect client ID (`ca_...`, for the key's mode) so the
webhook only waits for refunds and disputes of payments Flash's own platform made.

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
uses a published app), custom domains, a mobile app, team workspaces, real .xlsx
and .docx files, video longer than 8 seconds, and an LLM-based router.
