# Flash AI

One assistant that routes every request to the best AI engine.

Type what you want. Flash decides whether it is a writing task, a research question,
an image, or speech, sends it to the right engine, and keeps the result in a project.

| Engine   | Used for                                   | Provider                          |
| -------- | ------------------------------------------ | --------------------------------- |
| Write    | Writing, reasoning, questions about files  | Anthropic Claude                  |
| Research | Current facts with cited sources           | Anthropic Claude + web search     |
| Image    | Pictures, logos, illustrations             | OpenAI image model                |
| Voice    | Reading text aloud                         | ElevenLabs                        |

Features in this first version:

- **Auto routing** with a manual override (Auto / Write / Research / Image / Voice).
- **Projects**: separate chat histories, saved in the browser.
- **Memory**: a short note about you that Flash uses in every answer.
- **Files**: attach a PDF, image, or text file and ask about it (up to 10 MB).
- **Demo mode**: every engine works without keys, so you can try the app first.

## Run it

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
cp .env.example .env.local   # then paste your API keys into .env.local
npm run dev
```

Open http://localhost:3000.

## Deploy it

The easiest host is [Vercel](https://vercel.com): import the repository, add the same
keys under **Settings → Environment Variables**, and deploy. Any Node.js host works
(`npm run build && npm start`).

## How it works

```
src/
  app/page.tsx              the page
  components/Flash.tsx      sidebar, chat, composer
  components/Message.tsx    renders text, images, audio, sources
  app/api/chat/route.ts     picks the engine and streams the reply (NDJSON)
  app/api/status/route.ts   which engines have keys
  lib/router.ts             the routing rules
  lib/engines/claude.ts     writing and research
  lib/engines/media.ts      images and voice
  lib/engines/demo.ts       demo replies when a key is missing
```

Adding an engine means one function in `lib/engines/`, one rule in `lib/router.ts`,
and one case in `app/api/chat/route.ts`.

## Checks

```bash
npm test        # routing rules
npm run lint
npm run build
```

## Not in this version yet

User accounts and paid credits, video generation, mobile app, team workspaces,
and an LLM-based router. See the product plan for the roadmap.
