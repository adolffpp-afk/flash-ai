import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// A stand-in for fal.ai's transcription: "silence" has no words, "broken" never starts, and
// "lost" runs (so fal bills it) but its result can't be fetched.
const heard: string[] = [];
// Where each request went: a spoken turn skips the queue only when fal's synchronous endpoint is set.
const asked: string[] = [];
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    asked.push(req.url!);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const json = (v: unknown, code = 200) => res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(v));
    // Whisper on Groq: "Thank you." over the silence before the words, as Whisper does.
    if (req.url === "/groq/audio/transcriptions") {
      return json({
        text: " Thank you. Hello there",
        duration: 2.1,
        segments: [
          { text: " Thank you.", no_speech_prob: 0.9, avg_logprob: -1.4 },
          { text: " Hello there", no_speech_prob: 0.01, avg_logprob: -0.2 },
        ],
      });
    }
    if (req.method === "POST") {
      const input = JSON.parse(raw);
      const audio = String(input.audio_url ?? "");
      heard.push(audio);
      const kind = Buffer.from(audio.split(",")[1] ?? "", "base64").toString();
      if (kind === "broken") return json({ detail: "down" }, 500);
      // A spoken turn goes to fal's synchronous endpoint and asks for words only.
      if (req.url!.startsWith("/sync/")) {
        assert.equal(input.tag_audio_events, false);
        if (kind === "lost") return res.writeHead(200, { "Content-Type": "application/json" }).end("{");
        if (kind === "coughs") return json({ text: "(coughs)" });
        return json({ text: kind === "silence" ? "  " : " What's on my calendar today? (laughs)" });
      }
      return json({ status_url: `${base}/status`, response_url: `${base}/result/${kind}` });
    }
    if (req.url === "/status") return json({ status: "COMPLETED" });
    if (req.url === "/result/silence") return json({ text: "  " });
    if (req.url === "/result/lost") return json({ detail: "boom" }, 500);
    if (req.url!.startsWith("/result/")) return json({ text: " What's on my calendar today? " });
    res.writeHead(404).end();
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());

process.env.DATABASE_URL = ":memory:";
process.env.FAL_KEY = "k";
process.env.FAL_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.FAL_SYNC_URL = `${process.env.FAL_BASE_URL}/sync`;
process.env.GROQ_API_KEY = "g";
process.env.GROQ_BASE_URL = `${process.env.FAL_BASE_URL}/groq`;
delete process.env.ELEVENLABS_API_KEY;

const {
  wakeMatch,
  isYes,
  isNo,
  isGoodbye,
  isRepeat,
  confirmReply,
  heardWords,
  sayable,
  sayFirst,
  TurnEnd,
  TURN_TICK_MS,
  speechChunks,
  voiceReply,
  withVoiceStyle,
  VOICE_STYLE,
  MAX_SPOKEN_CHARS,
  YES_WORDS,
  NO_WORDS,
  GOODBYE_WORDS,
  UNSURE_WORDS,
  REPEAT_WORDS,
} = await import("../src/lib/voice-chat.ts");
const { translate } = await import("../src/lib/i18n.ts");
const { run, one } = await import("../src/lib/server/db.ts");
const { hearTurn } = await import("../src/lib/server/voice.ts");

test('"Hey Flash" wakes Flash, and what follows is the first request', () => {
  assert.deepEqual(wakeMatch("hey flash"), { rest: "" });
  assert.deepEqual(wakeMatch("Hey, Flash! What's the weather in Toronto?"), { rest: "What's the weather in Toronto?" });
  assert.deepEqual(wakeMatch("okay flash make me a logo"), { rest: "make me a logo" });
  assert.deepEqual(wakeMatch("so I said hi Flash"), { rest: "" });
  assert.equal(wakeMatch("grab the flashlight"), null);
  assert.equal(wakeMatch("hey flashy sneakers"), null);
  assert.equal(wakeMatch("they flash their lights"), null);
  assert.equal(wakeMatch("there's a flash sale today"), null);
});

test("short answers: yes, no and goodbye", () => {
  for (const y of ["Yes", "yeah go ahead", "OK.", "Sure, do it", "go ahead please"]) assert.ok(isYes(y), y);
  for (const n of ["no", "yes no wait", "maybe later", "yes I want to change the picture to a blue sky with birds"]) assert.ok(!isYes(n), n);
  for (const n of ["No thanks", "cancel", "never mind", "Don't."]) assert.ok(isNo(n), n);
  for (const b of ["Bye", "goodbye Flash", "OK thanks, that's all", "stop listening", "bye bye", "end the conversation"]) assert.ok(isGoodbye(b), b);
  for (const b of ["say bye to my customers in an email", "what's all this", "stop the video"]) assert.ok(!isGoodbye(b), b);
});

test("yes, no and goodbye in the language Flash is shown in, as well as in English", () => {
  const yes = "oui, ouais, d'accord, vas-y, fais-le";
  const no = "non, annule, pas maintenant, laisse tomber";
  const bye = "au revoir, salut, c'est tout, arrête d'écouter";
  for (const y of ["Oui", "D'accord !", "vas-y, s'il te plaît", "Yes", "go ahead"]) assert.ok(isYes(y, yes), y);
  for (const n of ["ouille", "oui je veux changer la photo avec un ciel bleu et des oiseaux", "non", "maybe later"]) assert.ok(!isYes(n, yes), n);
  for (const n of ["Non merci", "Annule.", "pas maintenant", "cancel"]) assert.ok(isNo(n, no), n);
  for (const n of ["nonante", "pas tout de suite"]) assert.ok(!isNo(n, no), n);
  for (const b of ["Au revoir !", "au revoir Flash", "C'est tout.", "Bye"]) assert.ok(isGoodbye(b, bye), b);
  for (const b of ["dis au revoir à mes clients", "salut tout le monde"]) assert.ok(!isGoodbye(b, bye), b);
  // Other scripts: their own commas, marks on letters, and no spaces between words.
  assert.ok(isYes("はい、お願いします", "はい、うん、お願いします"));
  assert.ok(isYes("हाँ", "हाँ, ठीक है") && !isYes("है", "हाँ, ठीक है"));
  assert.ok(!isYes("好的，我想把这张图片改成蓝色的天空，再加上几只飞翔的小鸟和一道彩虹", "好的，是的"));
  // The English lists change nothing in English.
  for (const y of ["Yes", "yeah go ahead", "OK.", "Sure, do it"]) assert.ok(isYes(y, YES_WORDS), y);
  for (const n of ["no", "yes no wait", "maybe later", "yes I want to change the picture to a blue sky with birds"]) assert.ok(!isYes(n, YES_WORDS), n);
  assert.ok(isNo("never mind", NO_WORDS) && !isNo("not bad", NO_WORDS));
  assert.ok(isGoodbye("goodbye Flash", GOODBYE_WORDS) && !isGoodbye("stop the video", GOODBYE_WORDS));
});

test("a reply to the price question: yes, no, or thinking out loud, which keeps the request waiting", () => {
  for (const y of ["Mm-hmm", "Uh-huh", "Go for it", "Sounds good", "Hmm, okay.", "Um, yes please", "please"]) assert.equal(confirmReply(y), "yes", y);
  for (const n of ["Um, no.", "Oh no", "Not now", "cancel it"]) assert.equal(confirmReply(n), "no", n);
  for (const u of ["Hmm.", "Wait", "How much is it?", "I'm not sure", "I don't know", "maybe", "Let me think"]) assert.equal(confirmReply(u), "unsure", u);
  // Anything else is a new request.
  for (const r of ["Make a picture of a cat", "Let's go to the beach", "please make it blue", "what's the weather"]) assert.equal(confirmReply(r), null, r);
  // In the language Flash is shown in, as well as in English.
  const fr = { yes: "oui, d'accord", no: "non, annule", unsure: "euh, attends, je ne sais pas, combien ça coûte" };
  assert.equal(confirmReply("Euh, oui", fr), "yes");
  assert.equal(confirmReply("Attends", fr), "unsure");
  assert.equal(confirmReply("Combien ça coûte ?", fr), "unsure");
  assert.equal(confirmReply("Fais une photo d'un chat", fr), null);
  // The English lists change nothing in English.
  const en = { yes: YES_WORDS, no: NO_WORDS, unsure: UNSURE_WORDS };
  for (const [said, meant] of [["Mm-hmm", "yes"], ["no thanks", "no"], ["hmm", "unsure"], ["Make a cat", null]] as const) assert.equal(confirmReply(said, en), meant, said);
});

test('"say that again" repeats, and "that\'s it?" is a question, not a goodbye', () => {
  for (const r of ["Say that again", "Sorry?", "What did you say?", "Can you repeat that please", "Pardon?"]) assert.ok(isRepeat(r), r);
  for (const r of ["Sorry, I meant blue", "Say that again in French", "what is the capital of France"]) assert.ok(!isRepeat(r), r);
  assert.ok(isRepeat("Répète !", "répète, pardon") && !isRepeat("Répète la liste en anglais", "répète, pardon"));
  assert.ok(isRepeat("What did you say", REPEAT_WORDS));
  for (const q of ["That's it?", "Okay, that's all?", "C'est tout ?", "就这些？"]) assert.ok(!isGoodbye(q, "c'est tout, 就这些"), q);
  assert.ok(isGoodbye("That's it.") && isGoodbye("C'est tout.", "c'est tout"));
});

test("sounds a transcript marks aren't words", () => {
  assert.equal(heardWords("(laughs) Yes."), "Yes.");
  assert.equal(heardWords("What's on (laughs) my list?"), "What's on my list?");
  for (const noise of ["(coughs)", "[music]", " (background noise) [applause] ", "..."]) assert.equal(heardWords(noise), "", noise);
});

test("where a recorded turn ends, from the microphone's loudness", () => {
  // Ticks through a turn with the level the microphone hears at each moment (ms after listening began).
  const listen = (level: (ms: number) => number, floor = 0) => {
    const turn = new TurnEnd(0, floor);
    for (let ms = TURN_TICK_MS; ms <= 40_000; ms += TURN_TICK_MS) {
      const heard = turn.tick(level(ms), ms);
      if (heard) return { heard, at: ms, floor: turn.floor };
    }
    return { heard: null, at: 40_000, floor: turn.floor };
  };
  const room = 0.005;
  const loud = (spans: [number, number][], level = 0.08) => (ms: number) => (spans.some(([a, b]) => ms >= a && ms < b) ? level : room);
  // A one-word "yes" ends the turn soon after it's said (it used to wait for the 30-second cap).
  const yes = listen(loud([[500, 800]], 0.1));
  assert.deepEqual([yes.heard, yes.at <= 2100], ["spoke", true], JSON.stringify(yes));
  // Words said straight away aren't taken for the room's noise.
  assert.equal(listen(loud([[0, 1500]])).heard, "spoke");
  // A click or a knock isn't a turn: Flash keeps listening, then gives up when nobody speaks.
  for (const knock of [loud([[1000, 1040]], 0.3), loud([[1000, 1080]], 0.3)]) assert.deepEqual(listen(knock).heard, "silent");
  assert.ok(listen(loud([[1000, 1040]], 0.3)).at >= 12_000);
  // "Um…", a pause of a second, then the request: one turn, ended after the request.
  const leadIn = listen(loud([[500, 800], [1800, 3800]]));
  assert.deepEqual([leadIn.heard, leadIn.at > 3800 && leadIn.at <= 5100], ["spoke", true], JSON.stringify(leadIn));
  // A soft voice is heard; a television in the background isn't.
  assert.equal(listen((ms) => (ms >= 500 && ms < 2500 ? (Math.floor(ms / 200) % 2 ? 0.03 : 0.012) : room)).heard, "spoke");
  const tv = listen(() => 0.015);
  assert.equal(tv.heard, "silent");
  // The room's level is kept for the next turn, and a voice still counts in that room.
  assert.ok(tv.floor > 0.01);
  assert.equal(listen((ms) => (ms >= 500 && ms < 1500 ? 0.1 : 0.015), tv.floor).heard, "spoke");
  // Someone who never stops is cut off at the cap.
  const endless = listen((ms) => (Math.floor(ms / 120) % 3 ? 0.12 : 0.006));
  assert.deepEqual([endless.heard, endless.at > 29_000 && endless.at <= 30_000 + 5 * TURN_TICK_MS], ["spoke", true], JSON.stringify(endless));
});

test("replies are said as a voice would: a pause per line, links and emoji left on screen", () => {
  assert.equal(
    sayable("Steps:\n- Mix the flour\n- Bake for 20 minutes\nThe recipe is at https://x.com/bread 🍞\n<https://y.org>"),
    "Steps: Mix the flour. Bake for 20 minutes. The recipe is at the link on your screen. the link on your screen.",
  );
  const fr = (text: string) => (text === "the link on your screen" ? "le lien sur ton écran" : text);
  assert.equal(sayable("Voir www.example.com", fr), "Voir le lien sur ton écran.");
  assert.equal(voiceReply({ content: "Two:\n1. Eggs\n2. Milk" }).say, "Two: Eggs. Milk.");
});

test("the first sentences are said while the rest is still being written", () => {
  const first = sayFirst({ content: "Sure. Paris is the capital of France. It has" });
  assert.equal(first, "Sure. Paris is the capital of France.");
  // What's said first is the start of the whole answer, so the rest follows without repeating it.
  assert.ok(voiceReply({ content: "Sure. Paris is the capital of France. It has a river." }).say.startsWith(first));
  assert.equal(sayFirst({ content: "Half a sente" }), "");
  // Code, tables and things Flash makes are described when they're done, not read out.
  for (const m of [{ content: "Here:\n```js\nx()\n```\nMore. Text." }, { content: "| a | b |\nMore. Text." }, { content: "Building it. Now.", app: { html: "", title: "x" } }]) {
    assert.equal(sayFirst(m as Parameters<typeof sayFirst>[0]), "", m.content);
  }
  // Long sentences wait for the end of the reply.
  assert.equal(sayFirst({ content: `${"word ".repeat(60)}end. Next one.` }), "");
});

test("long answers are spoken in short pieces, without losing a word", () => {
  const text = "One. Two is a longer sentence, with a pause. Three! " + "word ".repeat(80).trim() + ".";
  const pieces = speechChunks(text, 60);
  assert.ok(pieces.every((p) => p.length <= 60), JSON.stringify(pieces));
  assert.equal(pieces.join(" ").replace(/\s+/g, " "), text.replace(/\s+/g, " "));
  assert.deepEqual(speechChunks("Hi there. How are you?"), ["Hi there. How are you?"]);
  assert.deepEqual(speechChunks(""), []);
});

test("what Flash says back: the answer, made things, prices and errors", () => {
  assert.deepEqual(voiceReply({ content: "**Two plus two** is four." }), { say: "Two plus two is four.", confirm: false });
  assert.deepEqual(voiceReply({ content: "", images: [{ url: "/f/a", prompt: "cat" }] }), {
    say: "Your picture is ready. It's on your screen.",
    confirm: false,
  });
  assert.equal(voiceReply({ content: "", videos: [{ url: "/f/v", prompt: "waves" }] }).say, "Your video is ready. It's on your screen.");
  assert.equal(voiceReply({ content: "" }).say, "Done. It's on your screen.");
  assert.deepEqual(voiceReply({ content: "", error: "This Kling 3 video uses 140 credits. You have 200.", errorCode: "confirm_cost" }), {
    say: "This Kling 3 video uses 140 credits. You have 200. Say yes to go ahead, or no to skip it.",
    confirm: true,
  });
  assert.deepEqual(voiceReply({ content: "", error: "You're out of credits." }), { say: "You're out of credits.", confirm: false });
  assert.equal(voiceReply({ content: "Half", stopped: true }).say, "Stopped.");
  // Code and tables stay on screen.
  assert.equal(voiceReply({ content: "Here it is:\n\n```py\nprint(1)\n```" }).say, "Here it is: The details are on your screen.");
  assert.equal(voiceReply({ content: "Prices:\n\n| Item | Price |\n|---|---|\n| Bread | 8 |" }).say, "Prices: The details are on your screen.");
  // A long answer is cut at a sentence, and the rest stays on screen.
  const long = voiceReply({ content: "This is a sentence that goes on for a while. ".repeat(30) }).say;
  assert.ok(long.length <= MAX_SPOKEN_CHARS + 40);
  assert.ok(long.endsWith("a while. The rest is on your screen."), long);
});

test("what Flash says back is in the language Flash is shown in", () => {
  const table = {
    "Done. It's on your screen.": "Terminé. C'est sur ton écran.",
    "{cost} Say yes to go ahead, or no to skip it.": "{cost} Dis oui pour continuer, ou non pour passer.",
    "{answer} The details are on your screen.": "{answer} Les détails sont sur ton écran.",
  };
  const fr = (text: string, blanks?: Record<string, string | number>) => translate(table, text, blanks);
  assert.equal(voiceReply({ content: "" }, fr).say, "Terminé. C'est sur ton écran.");
  assert.equal(
    voiceReply({ content: "", error: "Cette vidéo coûte 140 crédits.", errorCode: "confirm_cost" }, fr).say,
    "Cette vidéo coûte 140 crédits. Dis oui pour continuer, ou non pour passer.",
  );
  assert.equal(voiceReply({ content: "Voici :\n\n```py\nprint(1)\n```" }, fr).say, "Voici : Les détails sont sur ton écran.");
  // A phrase the table lacks is said in English.
  assert.equal(voiceReply({ content: "", stopped: true }, fr).say, "Stopped.");
});

test("voice requests get spoken answers from the writing engines only", () => {
  assert.equal(withVoiceStyle("I run a bakery.", "text", true), `I run a bakery.\n\n${VOICE_STYLE}`);
  assert.equal(withVoiceStyle("", "search", true), VOICE_STYLE);
  assert.equal(withVoiceStyle("I run a bakery.", "text", undefined), "I run a bakery.");
  assert.equal(withVoiceStyle("I run a bakery.", "text", "yes"), "I run a bakery.", "only a real true");
  // Apps, code and documents keep their own instructions.
  for (const engine of ["app", "code", "docs", "slides", "image"] as const) assert.equal(withVoiceStyle("x", engine, true), "x");
});

// A user with some credits hears turns (added in the first test: top-level awaits here would end the file's tests early).
const balance = async () => Number((await one<{ c: number }>("SELECT COALESCE(SUM(amount), 0) AS c FROM credit_ledger WHERE user_id = 'v1'"))?.c);
const turn = async (body: Buffer, type = "audio/ogg") => {
  const r = await hearTurn("v1", type, body);
  return { status: r.status, json: async () => r.body };
};

test("Firefox turns: a recording comes back as words and costs a few credits", async () => {
  await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('v1', 'v1@x.io', '', 0, 0)");
  const res = await turn(Buffer.from("hello"));
  assert.equal(res.status, 200);
  const data = (await res.json()) as { text: string; credits: number };
  assert.equal(data.text, "What's on my calendar today?");
  assert.equal(data.credits, 3);
  assert.equal(await balance(), 197, "the free monthly 200, less 3");
  assert.ok(heard.at(-1)!.startsWith("data:audio/ogg;base64,"));
  const usage = await one<{ engine: string; credits: number; ok: number }>("SELECT engine, credits, ok FROM usage WHERE user_id = 'v1' ORDER BY rowid DESC LIMIT 1");
  assert.deepEqual({ ...usage }, { engine: "transcribe", credits: 3, ok: 1 });
});

test("silence is no words; a turn that never started is free, one fal ran is paid", async () => {
  const quiet = await turn(Buffer.from("silence"));
  assert.deepEqual(await quiet.json(), { text: "", credits: 3 });
  assert.equal(await balance(), 194);
  // A cough is heard as no words, so nothing is asked.
  assert.deepEqual(await (await turn(Buffer.from("coughs"))).json(), { text: "", credits: 3 });
  assert.equal(await balance(), 191);
  const failed = await turn(Buffer.from("broken"));
  assert.equal(failed.status, 502);
  assert.equal(await balance(), 191, "refunded");
  const lost = await turn(Buffer.from("lost"));
  assert.equal(lost.status, 502);
  assert.equal(await balance(), 188, "fal charged for the work");
});

test("hearing refuses non-audio, huge files and empty wallets", async () => {
  assert.equal((await turn(Buffer.from("hello"), "text/plain")).status, 415);
  assert.equal((await turn(Buffer.from("hello"), "audio/webm;codecs=opus")).status, 200, "codec details are fine");
  assert.equal((await turn(Buffer.alloc(1_000_001))).status, 413);
  assert.deepEqual(await (await turn(Buffer.alloc(0))).json(), { text: "" });
  // Spent everything (the month's free credits were already given, so none come back).
  await run("UPDATE credit_ledger SET amount = 0 WHERE user_id = 'v1'");
  const broke = await turn(Buffer.from("hello"));
  assert.equal(broke.status, 402);
  assert.match(((await broke.json()) as { error: string }).error, /Chrome, Edge or Safari/);
});

test("out of credits, a confirmed user is heard for free, without what Whisper makes up over silence", async () => {
  await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('v2', 'v2@x.io', '', 0, 1)");
  await hearTurn("v2", "audio/ogg", Buffer.from("hello"), { verified: true });
  await run("UPDATE credit_ledger SET amount = 0 WHERE user_id = 'v2'");
  const free = await hearTurn("v2", "audio/ogg", Buffer.from("hello"), { verified: true });
  assert.equal(free.status, 200);
  assert.deepEqual(free.body, { text: "Hello there", credits: 0, free: true });
  // Not confirmed: no free turns.
  assert.equal((await hearTurn("v2", "audio/ogg", Buffer.from("hello"))).status, 402);
  // A recording longer than the voice panel makes isn't heard for free, so nobody can spend the
  // free audio every user shares in one go.
  const seconds = async () => Number((await one<{ s: number }>("SELECT tokens AS s FROM free_quota WHERE provider = 'groq-audio'"))?.s ?? 0);
  const before = await seconds();
  assert.equal((await hearTurn("v2", "audio/ogg", Buffer.alloc(200_000, 1), { verified: true })).status, 402);
  assert.equal(await seconds(), before);
});

test("with a fal stand-in and no synchronous endpoint set, a turn goes through the stand-in's queue, not to fal.run", async () => {
  const sync = process.env.FAL_SYNC_URL;
  delete process.env.FAL_SYNC_URL;
  try {
    await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('v3', 'v3@x.io', '', 0, 0)");
    asked.length = 0;
    const r = await hearTurn("v3", "audio/ogg", Buffer.from("hello"));
    assert.deepEqual(r.body, { text: "What's on my calendar today?", credits: 3 });
    assert.ok(asked.length && asked.every((url) => !url.startsWith("/sync/")), asked.join(" "));
  } finally {
    process.env.FAL_SYNC_URL = sync;
  }
});
