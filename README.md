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
| Image         | Pictures, logos, illustrations                    | OpenAI `gpt-image-1`             | `OPENAI_API_KEY`     |
| Video         | 8 second video clips                              | OpenAI Sora (`sora-2`)           | `OPENAI_API_KEY`     |
| Voice         | Reading text aloud                                | ElevenLabs text to speech        | `ELEVENLABS_API_KEY` |
| Music         | 30 second songs, jingles and beats                | ElevenLabs Music                 | `ELEVENLABS_API_KEY` |
| Transcribe    | Turning audio or video files into text            | ElevenLabs Scribe                | `ELEVENLABS_API_KEY` |

Three keys switch on all twelve engines. Claude also sharpens image, video and music
requests into detailed prompts before they are sent.

Features:

- **App Builder** (like Lovable, Bolt, Base44 or Replit Agent): describe an app and get a
  working one with a live preview. Keep chatting to change it ("add a dark mode"), switch
  to the code view, open it full screen, or download it as a single HTML file you can
  host anywhere (Netlify Drop, GitHub Pages, Vercel).
- **Auto routing** with a manual override for every engine.
- **Projects**: separate chat histories, saved in the browser.
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

Open http://localhost:3000.

## Deploy it

The easiest host is [Vercel](https://vercel.com): import the repository, add the same
keys under **Settings → Environment Variables**, and deploy. Any Node.js host works
(`npm run build && npm start`).

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
  app/api/video/[id]/route.ts  streams finished videos without exposing the key
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
npm test        # routing rules
npm run lint
npm run build
```

## Not in this version yet

One-click publishing of built apps, apps with their own database, sign-in or backend
(today they are front-end only and keep data in the browser), multi-file projects,
user accounts and paid credits, a mobile app, team workspaces, real .xlsx and .docx
files, video longer than 8 seconds, and an LLM-based router. Generated videos expire
about an hour after they are made, so download the ones you want to keep. See the product plan for the roadmap.
