import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { OPUS_120MS, hiddenPages, oggOpus, opusSpeech, playedSeconds, wav } from "./audio-files.ts";

// A stand-in for fal.ai's transcription, told what to do by a word in the recording (see rec):
// "silence" has no words, "broken" never starts, and "lost" runs (so fal bills it) but its result
// can't be fetched.
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
      if (raw.includes("kind:refused")) return json({ error: { message: "could not process file" } }, 400);
      if (raw.includes("kind:down")) return json({ error: { message: "over capacity" } }, 503);
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
      const bytes = Buffer.from(audio.split(",")[1] ?? "", "base64").toString("latin1");
      const kind = ["silence", "broken", "lost", "coughs"].find((k) => bytes.includes(`kind:${k}`)) ?? "words";
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
  ENDING_WORDS,
  UNSURE_WORDS,
  SOUND_WORDS,
  POLITE_WORDS,
  REPEAT_WORDS,
  onlySounds,
  trailsOff,
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
  for (const y of ["Oui", "D'accord !", "Yes", "go ahead"]) assert.ok(isYes(y, yes), y);
  assert.ok(isYes("vas-y, s'il te plaît", { yes, polite: "s'il te plaît, merci" }));
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
  const fr = { yes: "oui, d'accord", no: "non, annule", unsure: "attends, je ne sais pas, combien ça coûte", sounds: "euh" };
  assert.equal(confirmReply("Euh, oui", fr), "yes");
  assert.equal(confirmReply("Attends", fr), "unsure");
  assert.equal(confirmReply("Combien ça coûte ?", fr), "unsure");
  assert.equal(confirmReply("Fais une photo d'un chat", fr), null);
  // The English lists change nothing in English.
  const en = { yes: YES_WORDS, no: NO_WORDS, unsure: UNSURE_WORDS, sounds: SOUND_WORDS, polite: POLITE_WORDS };
  for (const [said, meant] of [["Mm-hmm", "yes"], ["no thanks", "no"], ["hmm", "unsure"], ["Make a cat", null]] as const) assert.equal(confirmReply(said, en), meant, said);
});

test("a yes to the price question is only consent: putting it off, changing it or a but asks again", () => {
  const en = { yes: YES_WORDS, no: NO_WORDS, unsure: UNSURE_WORDS, sounds: SOUND_WORDS, polite: POLITE_WORDS };
  // A wrong yes spends credits, so more than consent asks the price question again.
  for (const u of [
    "maybe do it later",
    "I'm not sure, do it later",
    "wait, do it with a cat instead",
    "hmm, sure but cheaper",
    "do it later",
    "Do that later.",
    "okay make it a cat instead",
    "do that as a picture instead",
    "certainly, make it 5 seconds",
    "Okay, wait.",
    "Okay, how much?",
    "Sure, after lunch.",
    "Okay, but that's too expensive.",
    "Sounds good, but that's too expensive",
    "Okay, hold on.",
    "OK, let me think",
    "Sure, maybe later",
    "Hmm, how much is it?",
    "Um, I'm not sure.",
    "Uh, how much is it?",
    "okay, um",
    "yes no wait",
    "thanks",
  ]) {
    assert.equal(confirmReply(u), "unsure", u);
    assert.equal(confirmReply(u, en), "unsure", u);
  }
  for (const y of ["Um, yes please", "Mm-hmm", "Go for it", "okay go ahead", "yes do it", "No problem, go ahead.", "Sure, why not.", "Perfect.", "great, go ahead", "Let's go!", "OK then", "Flash, yes"]) {
    assert.equal(confirmReply(y, en), "yes", y);
  }
  for (const n of ["Nope.", "Maybe later", "No, wait", "forget it", "never mind, too expensive"]) assert.equal(confirmReply(n, en), "no", n);
  // Not about the question: a new request, as are long replies.
  for (const r of ["Hmm, what's the weather?", "cool, what's the weather", "Make a picture with no background", "yes I want to change the picture to a blue sky with birds"]) {
    assert.equal(confirmReply(r, en), null, r);
  }
  // "Oui, attends": thinking in the language Flash is shown in.
  assert.equal(confirmReply("Oui, attends", { yes: "oui", unsure: "attends" }), "unsure");
});

test("languages written without spaces: an answer runs into the next word, but a letter inside another word isn't one", () => {
  const zh = { yes: "是, 是的, 好, 好的, 可以, 没问题, 开始吧, 对", no: "不, 不要, 算了", polite: "谢谢" };
  for (const y of ["好的开始吧", "是的是的", "没问题，开始吧", "可以啊", "好的，谢谢"]) assert.equal(confirmReply(y, zh), "yes", y);
  for (const n of ["算了吧", "不要"]) assert.equal(confirmReply(n, zh), "no", n);
  // 好吗 ("okay?") and 好的但是太贵了 ("okay but it's too expensive") ask again; 对不起 ("sorry") and 不错 ("not bad") hold neither 对 nor 不.
  for (const u of ["好吗", "好的，但是太贵了"]) assert.equal(confirmReply(u, zh), "unsure", u);
  for (const r of ["对不起", "不错", "好的，我想把这张图片改成蓝色的天空，再加上几只飞翔的小鸟和一道彩虹"]) assert.equal(confirmReply(r, zh), null, r);
  const th = { yes: "ใช่, ได้, ได้เลย, โอเค, เอาเลย", no: "ไม่, ยกเลิก" };
  for (const y of ["ได้เลยครับ", "โอเคครับเอาเลย"]) assert.equal(confirmReply(y, th), "yes", y);
  assert.equal(confirmReply("ไม่ครับ", th), "no");
  // ได้ยินไหม ("did you hear?") isn't ได้ ("yes"), and ใช่ไหม ("is it?") is a question.
  assert.equal(confirmReply("ได้ยินไหม", th), null);
  assert.equal(confirmReply("ใช่ไหม", th), "unsure");
  // Once "not sure" is translated, ไม่แน่ใจ is heard as that, not as ไม่ ("no").
  assert.equal(confirmReply("ไม่แน่ใจ", { ...th, unsure: "ไม่แน่ใจ" }), "unsure");
  const ja = { yes: "はい, うん, お願いします, お願い", no: "いいえ, 結構です" };
  for (const y of ["はいお願いします", "うんお願い"]) assert.equal(confirmReply(y, ja), "yes", y);
  assert.equal(confirmReply("いいえ結構です", ja), "no");
  assert.equal(confirmReply("はいですか", ja), "unsure");
  // Goodbye and "say that again" too.
  assert.ok(isGoodbye("再见了", "再见, 拜拜") && !isGoodbye("再见的意思", "再见, 拜拜"));
  assert.ok(isRepeat("もう一度言ってね", "もう一度言って") && !isRepeat("もう一度言ってみて英語で", "もう一度言って"));
});

test('"say that again" repeats, and "that\'s it?" is a question, not a goodbye', () => {
  for (const r of ["Say that again", "Sorry?", "What did you say?", "Can you repeat that please", "Pardon?"]) assert.ok(isRepeat(r), r);
  for (const r of ["Sorry, I meant blue", "Say that again in French", "what is the capital of France"]) assert.ok(!isRepeat(r), r);
  assert.ok(isRepeat("Répète !", "répète, pardon") && !isRepeat("Répète la liste en anglais", "répète, pardon"));
  assert.ok(isRepeat("What did you say", REPEAT_WORDS));
  for (const q of ["That's it?", "Okay, that's all?", "C'est tout ?", "就这些？"]) assert.ok(!isGoodbye(q, "c'est tout, 就这些"), q);
  assert.ok(isGoodbye("That's it.") && isGoodbye("C'est tout.", "c'est tout"));
  // Chrome writes no punctuation, so "that's it" alone may be a question: a goodbye only with a closer.
  for (const q of ["that's it", "that's all", "okay that's it"]) assert.ok(!isGoodbye(q, GOODBYE_WORDS, { ending: ENDING_WORDS }), q);
  for (const b of ["that's it thanks", "okay that's all bye", "that's all for now", "thank you that's it", "bye"]) assert.ok(isGoodbye(b, GOODBYE_WORDS, { ending: ENDING_WORDS }), b);
  const fr = { ending: "c'est tout, ce sera tout", polite: "merci" };
  assert.ok(!isGoodbye("c'est tout", "au revoir, c'est tout", fr) && isGoodbye("c'est tout merci", "au revoir, c'est tout", fr) && isGoodbye("au revoir", "au revoir, c'est tout", fr));
  // Sounds and courtesy around "say that again".
  assert.ok(isRepeat("Um, say that again please", REPEAT_WORDS) && isRepeat("euh, répète", "répète", { sounds: "euh" }));
});

test('"Um." on its own is someone thinking, not a request', () => {
  for (const s of ["Um.", "Hmm hmm", "Uhm...", "Errr", "euh"]) assert.ok(onlySounds(s, "hmm, um, uh, euh"), s);
  for (const s of ["Mm-hmm", "um what", "Um, make a cat", ""]) assert.ok(!onlySounds(s, SOUND_WORDS), s);
  // A word or two that trails off before a pause: the request is still coming.
  for (const s of ["What…", "So,", "Um, so...", "I want—"]) assert.ok(trailsOff(s), s);
  // Not a whole request, nor what Chrome writes (no punctuation), nor a question.
  for (const s of ["What?", "what", "Make a picture of a cat...", "So."]) assert.ok(!trailsOff(s), s);
});

test("a stopped request is said as stopped, and known to be", () => {
  assert.deepEqual(voiceReply({ content: "Sure. Paris", stopped: true }), { say: "Stopped.", confirm: false, stopped: true });
  assert.equal(voiceReply({ content: "Sure." }).stopped, undefined);
});

test("sounds a transcript marks aren't words", () => {
  assert.equal(heardWords("(laughs) Yes."), "Yes.");
  assert.equal(heardWords("What's on (laughs) my list?"), "What's on my list?");
  for (const noise of ["(coughs)", "[music]", " (background noise) [applause] ", "..."]) assert.equal(heardWords(noise), "", noise);
});

test("where a recorded turn ends, from the microphone's loudness", () => {
  // Ticks through a turn with the level the microphone hears at each moment (ms after listening began).
  const listen = (level: (ms: number) => number, floor = 0, more: { room?: number; patient?: boolean } = {}) => {
    const turn = new TurnEnd(0, floor, more);
    for (let ms = TURN_TICK_MS; ms <= 40_000; ms += TURN_TICK_MS) {
      const heard = turn.tick(level(ms), ms);
      if (heard) return { heard, at: ms, floor: turn.floor, room: turn.room };
    }
    return { heard: null, at: 40_000, floor: turn.floor, room: turn.room };
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

test("a television talking in the room isn't a turn, and doesn't keep the user's turn going", () => {
  const listen = (level: (ms: number) => number, more: { floor?: number; room?: number; patient?: boolean } = {}) => {
    const turn = new TurnEnd(0, more.floor ?? 0, more);
    for (let ms = TURN_TICK_MS; ms <= 40_000; ms += TURN_TICK_MS) {
      const heard = turn.tick(level(ms), ms);
      if (heard) return { heard, at: ms, floor: turn.floor, room: turn.room };
    }
    return { heard: null, at: 40_000, floor: turn.floor, room: turn.room };
  };
  // Speech-like sound at 0.03 for 300 ms, 0.006 between words, on and on.
  const tv = (ms: number) => (ms % 500 < 300 ? 0.03 : 0.006);
  const alone = listen(tv);
  assert.equal(alone.heard, "silent");
  assert.ok(alone.room >= 0.025, String(alone.room));
  // The next turn starts knowing the television, and so does a user talking over it.
  assert.equal(listen(tv, alone).heard, "silent");
  const over = (start: number, end: number) => (ms: number) => (ms >= start && ms < end ? 0.085 : tv(ms));
  const spoke = listen(over(1000, 3000));
  assert.deepEqual([spoke.heard, spoke.at > 3000 && spoke.at <= 3000 + 1300], ["spoke", true], JSON.stringify(spoke));
  // Even when the user talks straight away, before the television was heard.
  const straightAway = listen(over(0, 2000));
  assert.deepEqual([straightAway.heard, straightAway.at <= 2000 + 1300], ["spoke", true], JSON.stringify(straightAway));
  // A louder television taken for a turn runs to the cap once; after that it's known, and isn't a turn.
  const louder = (ms: number) => (ms % 500 < 300 ? 0.04 : 0.006);
  const first = listen(louder);
  assert.equal(first.heard, "spoke");
  assert.equal(listen(louder, first).heard, "silent");
  // And a voice is still heard over it.
  assert.equal(listen((ms) => (ms >= 1000 && ms < 2500 ? 0.09 : louder(ms)), first).heard, "spoke");
  // When the television goes off, a soft voice is heard again.
  assert.equal(listen((ms) => (ms >= 1500 && ms < 3000 ? 0.03 : 0.004), first).heard, "spoke");
});

test('"um…" and a long pause stay one turn, unless Flash is waiting for a yes or no', () => {
  const listen = (level: (ms: number) => number, patient: boolean) => {
    const turn = new TurnEnd(0, 0, { patient });
    for (let ms = TURN_TICK_MS; ms <= 40_000; ms += TURN_TICK_MS) {
      const heard = turn.tick(level(ms), ms);
      if (heard) return { heard, at: ms };
    }
    return { heard: null, at: 40_000 };
  };
  const loud = (spans: [number, number][]) => (ms: number) => (spans.some(([a, b]) => ms >= a && ms < b) ? 0.08 : 0.005);
  // "Um" (300 ms), 1.4 seconds of thinking, then the request.
  const um = loud([[500, 800], [2200, 4200]]);
  const patient = listen(um, true);
  assert.deepEqual([patient.heard, patient.at > 4200], ["spoke", true], JSON.stringify(patient));
  assert.ok(listen(um, false).at < 2200, "waiting for a yes or no, a short answer ends the turn quickly");
  // A "yes" to the price question still ends the turn soon after.
  assert.ok(listen(loud([[500, 800]]), false).at <= 2100);
  // A request said in one go isn't kept waiting.
  assert.ok(listen(loud([[500, 2500]]), true).at <= 2500 + 1300);
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
// A recorded turn as Firefox makes it: Opus in Ogg, with a word for the stand-ins in its tags.
const rec = (kind = "words", seconds = 8) => oggOpus(opusSpeech(seconds), { vendor: `kind:${kind}` });
const turn = async (body: Buffer, type = "audio/ogg") => {
  const r = await hearTurn("v1", type, body);
  return { status: r.status, json: async () => r.body };
};

test("Firefox turns: a recording comes back as words and costs a few credits", async () => {
  await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('v1', 'v1@x.io', '', 0, 0)");
  const res = await turn(rec());
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
  const quiet = await turn(rec("silence"));
  assert.deepEqual(await quiet.json(), { text: "", credits: 3 });
  assert.equal(await balance(), 194);
  // A cough is heard as no words, so nothing is asked.
  assert.deepEqual(await (await turn(rec("coughs"))).json(), { text: "", credits: 3 });
  assert.equal(await balance(), 191);
  const failed = await turn(rec("broken"));
  assert.equal(failed.status, 502);
  assert.equal(await balance(), 191, "refunded");
  const lost = await turn(rec("lost"));
  assert.equal(lost.status, 502);
  assert.equal(await balance(), 188, "fal charged for the work");
});

test("a turn is priced and limited by how long it plays, not by its size", async () => {
  const before = await balance();
  const sent = heard.length;
  // An hour of sound packed into about 60 KB, whose pages claim no time at all: never heard, never charged.
  const hour = oggOpus(Array.from({ length: 30_000 }, () => Uint8Array.of(OPUS_120MS)), { granule: () => 0 });
  assert.ok(hour.length < 70_000);
  assert.equal((await turn(hour)).status, 413);
  // Two seconds that say they last an hour are priced as an hour, so they're refused too.
  assert.equal((await turn(oggOpus(opusSpeech(2), { granule: () => 48000 * 3600 }))).status, 413);
  // Files Flash can't measure: an Ogg header over noise, MP4, MP3.
  for (const [body, type] of [
    [Buffer.concat([Buffer.from("OggS"), Buffer.alloc(5000, 7)]), "audio/ogg"],
    [Buffer.from("\0\0\0\x20ftypM4A \0\0\0\0"), "audio/mp4"],
    [Buffer.from("ID3\x04\0\0\0\0\0\0"), "audio/mpeg"],
  ] as const) {
    const r = await turn(body, type);
    assert.equal(r.status, 415, type);
    assert.match(((await r.json()) as { error: string }).error, /Chrome, Edge or Safari/);
  }
  assert.equal(await balance(), before, "nothing charged");
  assert.equal(heard.length, sent, "nothing sent to be transcribed");
  // The longest turn the panel records, and a WAV, cost what any other turn does.
  assert.deepEqual(await (await turn(rec("words", 45))).json(), { text: "What's on my calendar today?", credits: 3 });
  assert.equal((await turn(wav({ data: Buffer.alloc(32_000) }), "audio/wav")).status, 200);
  assert.equal(await balance(), before - 6);
  // Twenty minutes hidden inside pages with broken checksums: what's sent to be heard is the clean
  // copy of the moment of sound Flash measured and priced, so the hidden minutes are never heard.
  const hidden = hiddenPages(20);
  assert.ok(playedSeconds(hidden) >= 1200);
  assert.equal((await turn(hidden)).status, 200);
  const sentAudio = Buffer.from(heard.at(-1)!.split(",")[1], "base64");
  assert.match(heard.at(-1)!, /^data:audio\/ogg;base64,/);
  assert.ok(playedSeconds(sentAudio) < 1, String(playedSeconds(sentAudio)));
  assert.equal(await balance(), before - 9);
});

test("hearing refuses non-audio, huge files and empty wallets", async () => {
  assert.equal((await turn(rec(), "text/plain")).status, 415);
  assert.equal((await turn(rec(), "audio/webm;codecs=opus")).status, 200, "codec details are fine");
  assert.equal((await turn(Buffer.alloc(1_000_001))).status, 413);
  assert.deepEqual(await (await turn(Buffer.alloc(0))).json(), { text: "" });
  // Spent everything (the month's free credits were already given, so none come back).
  await run("UPDATE credit_ledger SET amount = 0 WHERE user_id = 'v1'");
  const broke = await turn(rec());
  assert.equal(broke.status, 402);
  assert.match(((await broke.json()) as { error: string }).error, /Chrome, Edge or Safari/);
});

test("out of credits, a confirmed user is heard for free, without what Whisper makes up over silence", async () => {
  await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('v2', 'v2@x.io', '', 0, 1)");
  await hearTurn("v2", "audio/ogg", rec(), { verified: true });
  await run("UPDATE credit_ledger SET amount = 0 WHERE user_id = 'v2'");
  const quota = async () => ({ ...(await one<{ requests: number; tokens: number }>("SELECT requests, tokens FROM free_quota WHERE provider = 'groq-audio'")) });
  const used = async () => Number((await one<{ n: number }>("SELECT used AS n FROM free_user_quota WHERE user_id = 'v2' AND kind = 'voice'"))?.n ?? 0);
  const free = await hearTurn("v2", "audio/ogg", rec(), { verified: true });
  assert.equal(free.status, 200);
  assert.deepEqual(free.body, { text: "Hello there", credits: 0, free: true });
  // Groq counted the turn as 10 seconds, at least what it counts for any file.
  assert.deepEqual(await quota(), { requests: 1, tokens: 10 });
  // Not confirmed: no free turns.
  assert.equal((await hearTurn("v2", "audio/ogg", rec())).status, 402);
  // A recording longer than the voice panel makes isn't heard at all, so nobody can spend the free
  // audio every user shares in one go.
  assert.equal((await hearTurn("v2", "audio/ogg", rec("words", 51), { verified: true })).status, 413);
  assert.deepEqual(await quota(), { requests: 1, tokens: 10 });
  // Groq refused the file: the shared allowance gets its request and seconds back, but the user's
  // free turn stays used, so bad files can't be sent over and over.
  const turns = await used();
  assert.equal((await hearTurn("v2", "audio/ogg", rec("refused", 30), { verified: true })).status, 502);
  assert.deepEqual(await quota(), { requests: 1, tokens: 10 });
  assert.equal(await used(), turns + 1);
  // Groq itself failed: the user gets the turn back too.
  assert.equal((await hearTurn("v2", "audio/ogg", rec("down", 30), { verified: true })).status, 502);
  assert.deepEqual(await quota(), { requests: 1, tokens: 10 });
  assert.equal(await used(), turns + 1);
});

test("with a fal stand-in and no synchronous endpoint set, a turn goes through the stand-in's queue, not to fal.run", async () => {
  const sync = process.env.FAL_SYNC_URL;
  delete process.env.FAL_SYNC_URL;
  try {
    await run("INSERT INTO users (id, email, password_hash, created_at, verified_at) VALUES ('v3', 'v3@x.io', '', 0, 0)");
    asked.length = 0;
    const r = await hearTurn("v3", "audio/ogg", rec());
    assert.deepEqual(r.body, { text: "What's on my calendar today?", credits: 3 });
    assert.ok(asked.length && asked.every((url) => !url.startsWith("/sync/")), asked.join(" "));
  } finally {
    process.env.FAL_SYNC_URL = sync;
  }
});
