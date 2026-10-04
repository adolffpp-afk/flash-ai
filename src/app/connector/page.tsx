import type { Metadata } from "next";
import Link from "next/link";
import { LogoMark } from "@/app/brand";
import { SITE_URL } from "@/app/site";

export const metadata: Metadata = {
  title: "Flash connector",
  description: "Use Flash AI's images, videos, music and voice from Claude, ChatGPT and other AI apps.",
};

const URL = `${SITE_URL}/mcp`;

const TOOLS = [
  ["Create an image", "Photos, art, posters and product shots with FLUX.2 Pro."],
  ["Create a video", "Clips with sound from Veo 3.1, or up to 15 seconds with Kling 3."],
  ["Create music", "Instrumentals or full songs with sung lyrics."],
  ["Read text aloud", "Natural voice-overs as MP3."],
  ["Remove a background", "Cuts out the subject on a transparent background."],
  ["Upscale a photo", "Sharper and up to 4 times bigger."],
  ["Check credits", "How many Flash credits you have left."],
];

const APPS = [
  {
    name: "Claude",
    steps: [
      "Open Settings, then Connectors.",
      "Choose Add custom connector.",
      `Name it Flash, paste ${URL} as the address, and add it.`,
      "Choose Connect, sign in to Flash, and press Allow.",
    ],
  },
  {
    name: "ChatGPT",
    steps: [
      "Open Settings, then Apps & Connectors, and turn on Developer mode under Advanced.",
      "Choose Create, name it Flash, and paste the address.",
      "Pick OAuth for sign-in, create it, then sign in to Flash and press Allow.",
    ],
  },
  {
    name: "Other apps (Cursor, VS Code, and more)",
    steps: ["Add a remote MCP server with the address above. The app opens Flash's sign-in page the first time."],
  },
];

/** How to add Flash as a connector in other AI apps. */
export default function ConnectorGuide() {
  return (
    <div className="h-full overflow-y-auto bg-zinc-950 text-zinc-100">
      <div className="mx-auto max-w-2xl px-4 py-10">
        <Link href="/" className="flex items-center gap-2 text-sm font-semibold">
          <LogoMark size={28} />
          Flash AI
        </Link>
        <h1 className="mt-8 text-3xl font-semibold tracking-tight text-balance">
          Bring Flash into <span className="text-holo">every AI app</span>
        </h1>
        <p className="mt-3 leading-relaxed text-zinc-400">
          Add Flash as a connector and Claude, ChatGPT and other AI apps can make images, videos, music and voice-overs
          for you with Flash. It uses your Flash credits at the same prices as in Flash, and the app can&apos;t see your
          chats or projects.
        </p>

        <div className="mt-6 rounded-xl border border-primary/25 bg-primary/[0.05] p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-zinc-400">Connector address</p>
          <p className="mt-1 select-all break-all font-mono text-lg text-emerald-200">{URL}</p>
        </div>

        <h2 className="mt-10 text-xl font-medium">What it can do</h2>
        <ul className="mt-3 grid gap-2">
          {TOOLS.map(([name, what]) => (
            <li key={name} className="flex gap-3 text-sm">
              <span className="text-primary" aria-hidden>
                ✦
              </span>
              <span>
                <span className="font-medium text-zinc-100">{name}.</span> <span className="text-zinc-400">{what}</span>
              </span>
            </li>
          ))}
        </ul>

        <h2 className="mt-10 text-xl font-medium">How to connect</h2>
        <div className="mt-3 grid gap-6">
          {APPS.map((app) => (
            <section key={app.name}>
              <h3 className="font-medium text-zinc-100">{app.name}</h3>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-zinc-400">
                {app.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            </section>
          ))}
        </div>

        <p className="mt-10 text-sm text-zinc-500">
          To disconnect an app, open your credits in Flash and choose Disconnect under Connected apps. Files an app makes
          get a private link that anyone you share it with can open. See the{" "}
          <Link href="/privacy" className="text-primary-soft hover:underline">
            Privacy Policy
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
