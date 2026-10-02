import type { Engine, StreamEvent } from "../types.ts";

export const KEY_FOR: Record<Engine, string> = {
  text: "ANTHROPIC_API_KEY",
  search: "ANTHROPIC_API_KEY",
  code: "ANTHROPIC_API_KEY",
  translate: "ANTHROPIC_API_KEY",
  docs: "ANTHROPIC_API_KEY",
  image: "OPENAI_API_KEY",
  video: "OPENAI_API_KEY",
  voice: "ELEVENLABS_API_KEY",
  music: "ELEVENLABS_API_KEY",
  transcribe: "ELEVENLABS_API_KEY",
  app: "ANTHROPIC_API_KEY",
  slides: "ANTHROPIC_API_KEY",
};

const DEMO_APP = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Demo to-do app</title>
<style>
body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;justify-content:center;padding:40px 16px;margin:0}
.card{background:#1e293b;border-radius:16px;padding:24px;width:100%;max-width:420px;box-shadow:0 10px 30px #0006}
h1{margin:0 0 4px;font-size:22px}p{margin:0 0 16px;color:#94a3b8;font-size:14px}
form{display:flex;gap:8px}input{flex:1;padding:10px;border-radius:10px;border:1px solid #334155;background:#0f172a;color:inherit}
button{padding:10px 14px;border:0;border-radius:10px;background:#6366f1;color:white;font-weight:600;cursor:pointer}
ul{list-style:none;padding:0;margin:16px 0 0}li{display:flex;align-items:center;gap:10px;padding:10px;border-bottom:1px solid #334155}
li.done span{text-decoration:line-through;color:#64748b}li button{margin-left:auto;background:none;color:#94a3b8;padding:4px}
</style></head><body><div class="card"><h1>Today</h1><p>Demo app built by Flash. Add a key for real builds.</p>
<form id="f"><input id="t" placeholder="Add a task"><button>Add</button></form><ul id="l"></ul></div>
<script>
let tasks=[{t:"Buy flour",d:true},{t:"Call the supplier",d:false},{t:"Post on Instagram",d:false}];
const l=document.getElementById("l");
function draw(){l.innerHTML="";tasks.forEach((x,i)=>{const li=document.createElement("li");li.className=x.d?"done":"";
li.innerHTML='<input type="checkbox" '+(x.d?"checked":"")+'><span></span><button aria-label="Delete">✕</button>';
li.querySelector("span").textContent=x.t;li.querySelector("input").onchange=()=>{x.d=!x.d;draw()};
li.querySelector("button").onclick=()=>{tasks.splice(i,1);draw()};l.appendChild(li)})}
document.getElementById("f").onsubmit=e=>{e.preventDefault();const v=document.getElementById("t").value.trim();if(v){tasks.push({t:v,d:false});document.getElementById("t").value="";draw()}};
draw();
</script></body></html>`;

const SAMPLES: Partial<Record<Engine, string>> = {
  code: "\n\n```python\ndef is_prime(n: int) -> bool:\n    if n < 2:\n        return False\n    return all(n % d for d in range(2, int(n ** 0.5) + 1))\n```",
  docs: "\n\n```csv\nCategory,Monthly budget,Spent\nRent,1200,1200\nFood,500,430\nTransport,150,120\n```",
  translate: "\n\n**Spanish:** Buenos días",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function placeholderImage(prompt: string, label: string): string {
  const safe = prompt.replace(/[<>&"]/g, "").slice(0, 60);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#ec4899"/></linearGradient></defs><rect width="512" height="512" fill="url(#g)"/><text x="256" y="236" font-family="sans-serif" font-size="28" fill="white" text-anchor="middle">${label}</text><text x="256" y="280" font-family="sans-serif" font-size="16" fill="white" text-anchor="middle">${safe}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

/** Stand-in replies so the whole app can be tried before any API key is added. */
export async function* demoReply(engine: Engine, message: string): AsyncGenerator<StreamEvent> {
  const note =
    `Demo mode: add ${KEY_FOR[engine]} to .env.local to get real results from this engine. ` +
    `Flash routed your request to the ${engine} engine.`;
  for (const word of note.split(/(?<= )/)) {
    yield { type: "text", delta: word };
    await sleep(10);
  }
  if (SAMPLES[engine]) yield { type: "text", delta: SAMPLES[engine] };
  if (engine === "image") yield { type: "image", url: placeholderImage(message, "Demo image"), prompt: message };
  if (engine === "video") yield { type: "image", url: placeholderImage(message, "Demo video frame"), prompt: message };
  if (engine === "app") {
    yield { type: "app", app: { title: "Demo to-do app", html: DEMO_APP, kind: "app" } };
  }
  if (engine === "search") {
    yield { type: "sources", items: [{ title: "Example source", url: "https://example.com" }] };
  }
}
