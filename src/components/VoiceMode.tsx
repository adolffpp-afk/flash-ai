"use client";

import { useEffect, useRef, useState } from "react";
import { hasBuiltInRecognition, micBlocked, newRecognition, releaseMic, takeMic } from "@/lib/listen";
import {
  ENDING_WORDS,
  GOODBYE_WORDS,
  NO_WORDS,
  POLITE_WORDS,
  REPEAT_WORDS,
  SOUND_WORDS,
  TURN_TICK_MS,
  TurnEnd,
  UNSURE_WORDS,
  YES_WORDS,
  confirmReply,
  isGoodbye,
  isRepeat,
  onlySounds,
  sayFirst,
  speechChunks,
  trailsOff,
  type VoiceMessage,
} from "@/lib/voice-chat";
import { readAloudVoice } from "@/lib/device-settings";
import { speechLang } from "@/lib/languages";
import { msg } from "@/lib/i18n";
import { tNow, useT } from "@/lib/use-t";

/** What Flash says after a request, whether it asked to go ahead with a costly one, and whether the request was stopped. */
export type VoiceAnswer = { say: string; confirm: boolean; stopped?: boolean };

type Phase = "starting" | "listening" | "thinking" | "speaking" | "paused";

const LABELS: Record<Phase, string> = {
  starting: msg("Starting…"),
  listening: msg("Listening…"),
  thinking: msg("Thinking…"),
  speaking: msg("Speaking…"),
  paused: msg("Paused"),
};

// After this long with nothing said, Flash stops listening until the user taps the circle.
const QUIET_MS = 60_000;
const MIC_BLOCKED = msg("Allow the microphone for Flash in your browser, then tap the circle.");

type VoiceProps = {
  name: string;
  // The language picked in Settings > General; Flash listens and speaks in it. "" or missing: the browser's.
  language?: string;
  // Words said right after "Hey Flash", asked at once.
  first?: string;
  // Opened by "Hey Flash" (Flash answers "Yes?") rather than the Talk button.
  woke: boolean;
  busy: boolean;
  // early is called as the reply is written, so its first sentences are said before it's done.
  ask: (text: string, early?: (partial: VoiceMessage) => void) => Promise<VoiceAnswer>;
  confirm: () => Promise<VoiceAnswer>;
  onStop: () => void;
  onClose: () => void;
};

// What the conversation shows on screen.
type Screen = {
  phase: (p: Phase) => void;
  you: (text: string) => void;
  flash: (text: string) => void;
  problem: (text: string) => void;
  // The browser wouldn't speak until the page is tapped; this is what Flash wanted to say.
  silent: (text: string) => void;
  props: () => VoiceProps;
};

/** What the conversation listens and speaks in: the language picked in Settings, or "" for the browser's. */
const talkingIn = (language = "") => speechLang(language, navigator.language);

/** Reads text aloud with the voice picked in Settings (or one for lang), a piece at a time. */
function speakPieces(text: string, lang: string): SpeechSynthesisUtterance[] {
  const { voice, rate } = readAloudVoice(lang);
  return speechChunks(text).map((piece) => {
    const u = new SpeechSynthesisUtterance(piece);
    if (voice) u.voice = voice;
    u.rate = rate;
    u.lang = voice?.lang || lang || navigator.language || "en-US";
    return u;
  });
}

/**
 * One voice conversation: listen, send what was heard to the chat, say the answer, listen again,
 * until it is stopped. Lives outside React so its timers and callbacks aren't tied to renders; what
 * it says and shows is in the language Flash is shown in at that moment (tNow).
 */
class Conversation {
  private alive = true;
  private paused = false;
  private phase: Phase = "starting";
  private resume: (() => void) | null = null;
  private cancelHearing: (() => void) | null = null;
  private cutSpeech: (() => void) | null = null;
  private audio: { stream: MediaStream; context: AudioContext } | null = null;
  private heardAt = 0;
  // Set when the user taps the circle to interrupt, or presses Stop, so the rest of that answer isn't said.
  private hushed = false;
  // Set when the browser wouldn't speak until the page is tapped, so the whole answer can be heard after.
  private blocked = false;
  // "Tap to hear Flash" saying it, while listening waits.
  private replaying: Promise<void> | null = null;
  // How loud the room is (RMS), and other talking in it, kept from one turn to the next (see TurnEnd).
  private floor = 0;
  private room = 0;

  constructor(
    private screen: Screen,
    private builtIn: boolean,
  ) {}

  private show(phase: Phase) {
    this.phase = phase;
    this.screen.phase(phase);
  }

  async run() {
    const p = this.screen.props;
    let pending = p().first?.trim() ?? "";
    let confirming = false;
    let lastAnswer = "";
    // "Um…" or "What…" said before a pause, kept to go with the words that follow it.
    let held = "";
    this.heardAt = Date.now();
    // "there" means Flash has no name for them: the greeting goes without one, which reads naturally in every language.
    const named = p().name !== "there";
    if (!pending) {
      // Kept as the last answer, so "Sorry?" right after it says it again.
      lastAnswer = p().woke
        ? named ? tNow("Yes, {name}?", { name: p().name }) : tNow("Yes?")
        : named ? tNow("Hi {name}. What can I do for you?", { name: p().name }) : tNow("Hi. What can I do for you?");
      await this.sayAll(lastAnswer);
    }
    while (this.alive) {
      if (this.paused) {
        this.show("paused");
        await new Promise<void>((r) => (this.resume = r));
        this.resume = null;
        this.heardAt = Date.now();
        continue;
      }
      if (this.replaying) {
        await this.replaying;
        continue;
      }
      let heard: string | null = pending || null;
      pending = "";
      if (heard === null) {
        this.show("listening");
        heard = await (this.builtIn ? this.hearBuiltIn() : this.hearRecorded(!confirming));
      }
      if (!this.alive) return;
      if (heard === null) continue;
      if (!heard) {
        if (Date.now() - this.heardAt > QUIET_MS) this.paused = true;
        continue;
      }
      this.heardAt = Date.now();
      // "Um." on its own is someone still thinking, not a request (nor an answer to the price question):
      // Flash listens on, and it goes with what's said next.
      const sounds = tNow(SOUND_WORDS);
      if (onlySounds(heard, sounds)) {
        held = `${held} ${heard}`.trim();
        continue;
      }
      if (held) heard = `${held} ${heard}`;
      held = "";
      const polite = tNow(POLITE_WORDS);
      this.hushed = false;
      this.screen.you(heard);
      if (isGoodbye(heard, tNow(GOODBYE_WORDS), { ending: tNow(ENDING_WORDS), polite, sounds })) {
        await this.sayAll(named ? tNow("Bye, {name}.", { name: p().name }) : tNow("Bye."));
        if (this.alive) p().onClose();
        return;
      }
      // "Say that again" repeats the last answer, as a person would, instead of making a voice-over.
      if (lastAnswer && isRepeat(heard, tNow(REPEAT_WORDS), { sounds, polite })) {
        await this.sayAll(lastAnswer);
        this.heardAt = Date.now();
        continue;
      }
      // "What…" or "So, um," before a long pause: the request is still coming.
      if (!confirming && trailsOff(heard)) {
        held = heard;
        continue;
      }
      this.show("thinking");
      this.screen.flash("");
      this.blocked = false;
      // The first sentences are said while the rest is still being written.
      let said = "";
      let saying = Promise.resolve();
      let answered = false;
      const early = (partial: VoiceMessage) => {
        const first = sayFirst(partial, tNow);
        if (first.length <= said.length || !first.startsWith(said)) return;
        const piece = first.slice(said.length).trim();
        said = first;
        const shown = first;
        // Back to Thinking (with its Stop button) while the rest is still being written.
        saying = saying
          .then(() => this.say(piece, shown))
          .then(() => {
            if (!answered && this.alive) this.show("thinking");
          });
      };
      const reply = confirming ? confirmReply(heard, { yes: tNow(YES_WORDS), no: tNow(NO_WORDS), unsure: tNow(UNSURE_WORDS), sounds, polite }) : null;
      let answer: VoiceAnswer;
      if (reply === "yes") answer = await p().confirm();
      else if (reply === "no") answer = { say: tNow("Okay, I won't make it."), confirm: false };
      // Thinking out loud ("hmm", "how much?"): the costly request is still waiting, so Flash asks again instead of dropping it.
      else if (reply === "unsure") answer = { say: lastAnswer, confirm: true };
      else if (p().busy) answer = { say: tNow("I'm still working on your last request. Ask me again when it's done."), confirm: false };
      else answer = await p().ask(heard, early);
      answered = true;
      confirming = answer.confirm;
      // A request stopped part way: "say that again" says what was said of it, not "Stopped.".
      lastAnswer = answer.stopped ? said || lastAnswer : answer.say;
      await saying;
      if (!this.alive) return;
      const rest = said && answer.say.startsWith(said) ? answer.say.slice(said.length).trim() : answer.say;
      if (rest) await this.say(rest, answer.say);
      // The whole answer, to hear once the page is tapped, rather than its last piece.
      if (this.blocked) this.screen.silent(answer.say);
      this.heardAt = Date.now();
    }
  }

  stop() {
    this.alive = false;
    this.cancelHearing?.();
    this.cutSpeech?.();
    this.resume?.();
    try {
      window.speechSynthesis?.cancel();
    } catch {}
    this.audio?.stream.getTracks().forEach((t) => t.stop());
    void this.audio?.context.close().catch(() => {});
    this.audio = null;
    releaseMic("voice");
  }

  /** Stop: Flash stops talking at once, and says nothing more of the answer it was giving. */
  hush() {
    this.hushed = true;
    this.cutSpeech?.();
  }

  /** "Tap to hear Flash": says what the browser wouldn't, while listening waits so Flash doesn't hear itself. */
  replay(text: string) {
    if (!this.alive || this.replaying) return;
    this.cancelHearing?.();
    this.hushed = false;
    this.replaying = this.sayAll(text).finally(() => {
      this.replaying = null;
      if (this.paused && this.alive) this.show("paused");
    });
  }

  /** The circle: interrupts Flash while it speaks, pauses listening, or starts it again. */
  tap() {
    if (this.phase === "speaking") {
      this.hush();
    } else if (this.phase === "paused") {
      this.paused = false;
      this.screen.problem("");
      this.resume?.();
    } else if (this.phase === "listening") {
      this.paused = true;
      this.cancelHearing?.();
      this.show("paused");
    }
  }

  /** Says text on its own (a greeting, a goodbye, an answer again), showing it to hear if the browser wouldn't speak. */
  private async sayAll(text: string) {
    this.blocked = false;
    await this.say(text);
    if (this.blocked) this.screen.silent(text);
  }

  /** Says text aloud, showing shown (by default the text), resolving when it's done or cut off. */
  private say(text: string, shown = text): Promise<void> {
    this.screen.flash(shown);
    if (!this.alive || this.hushed) return Promise.resolve();
    this.show("speaking");
    const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
    if (!synth) return Promise.resolve();
    synth.cancel();
    const pieces = speakPieces(text, talkingIn(this.screen.props().language));
    return new Promise((resolve) => {
      let next = 0;
      let current = -1;
      let done = false;
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(watchdog);
        this.cutSpeech = null;
        resolve();
      };
      const speakNext = () => {
        if (done || !this.alive || next >= pieces.length) return finish();
        const index = (current = next++);
        const u = pieces[index];
        const advance = () => index === current && speakNext();
        u.onend = advance;
        u.onerror = (e) => {
          if (e.error === "not-allowed") this.blocked = true;
          advance();
        };
        // Some browsers never say a piece has ended; move on after a generous wait.
        clearTimeout(watchdog);
        watchdog = setTimeout(advance, 5000 + (u.text.length * 200) / (u.rate || 1));
        synth.speak(u);
      };
      this.cutSpeech = () => {
        synth.cancel();
        finish();
      };
      speakNext();
    });
  }

  /** Listens for one thing said. "" when nothing was said; null when stopped (paused or closed). */
  private hearBuiltIn(): Promise<string | null> {
    return new Promise((resolve) => {
      const rec = newRecognition(talkingIn(this.screen.props().language));
      if (!rec) return resolve(null);
      rec.continuous = false;
      rec.interimResults = true;
      let final = "";
      let stopped = false;
      let settled = false;
      const done = (value: string | null) => {
        if (settled) return;
        settled = true;
        this.cancelHearing = null;
        releaseMic("voice");
        resolve(value);
      };
      rec.onresult = (e) => {
        let interim = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) final += e.results[i][0].transcript;
          else interim += e.results[i][0].transcript;
        }
        this.screen.you((final + interim).trim());
      };
      rec.onerror = (e) => {
        if (micBlocked(e.error)) {
          this.screen.problem(tNow(MIC_BLOCKED));
          this.paused = true;
          stopped = true;
        }
      };
      rec.onend = () => done(stopped || !this.alive ? null : final.trim());
      this.cancelHearing = () => {
        stopped = true;
        rec.abort();
        done(null);
      };
      takeMic("voice", () => this.cancelHearing?.());
      try {
        rec.start();
        this.screen.problem("");
      } catch {
        done("");
      }
    });
  }

  /** Opens the microphone once per conversation (browsers without speech recognition). */
  private async microphone() {
    if (this.audio) return this.audio;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      this.audio = { stream, context: new AudioContext() };
      return this.audio;
    } catch {
      this.screen.problem(tNow(MIC_BLOCKED));
      this.paused = true;
      return null;
    }
  }

  /**
   * Records one turn, ending it after a pause, and has Flash write down what was said. patient: wait
   * longer after only a word or a sound ("um…"), as when Flash isn't waiting for a yes or no.
   */
  private async hearRecorded(patient: boolean): Promise<string | null> {
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      this.screen.problem(tNow("This browser can't use the microphone."));
      this.paused = true;
      return null;
    }
    const mic = await this.microphone();
    if (!mic || !this.alive) return null;
    await mic.context.resume().catch(() => {});
    const analyser = mic.context.createAnalyser();
    // About 43 ms of sound at 48 kHz, so ticks every 40 ms hear all of it.
    analyser.fftSize = 2048;
    const source = mic.context.createMediaStreamSource(mic.stream);
    source.connect(analyser);
    const mime = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((t) => MediaRecorder.isTypeSupported(t));
    const recorder = new MediaRecorder(mic.stream, { ...(mime && { mimeType: mime }), audioBitsPerSecond: 24_000 });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);

    const spoke = await new Promise<boolean | null>((resolve) => {
      const samples = new Float32Array(analyser.fftSize);
      const turn = new TurnEnd(Date.now(), this.floor, { room: this.room, patient });
      let settled = false;
      const end = (value: boolean | null) => {
        if (settled) return;
        settled = true;
        clearInterval(tick);
        this.cancelHearing = null;
        releaseMic("voice");
        if (recorder.state !== "inactive") {
          recorder.onstop = () => resolve(value);
          recorder.stop();
        } else resolve(value);
      };
      const tick = setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const s of samples) sum += s * s;
        const heard = turn.tick(Math.sqrt(sum / samples.length), Date.now());
        this.floor = turn.floor;
        this.room = turn.room;
        if (heard) end(heard === "spoke");
      }, TURN_TICK_MS);
      this.cancelHearing = () => end(null);
      takeMic("voice", () => this.cancelHearing?.());
      recorder.start(250);
    });
    source.disconnect();
    if (spoke === null || !this.alive) return null;
    if (!spoke || !chunks.length) return "";

    this.show("thinking");
    const type = (recorder.mimeType || "audio/webm").split(";")[0];
    try {
      // A stuck upload or transcription mustn't leave Flash deaf on "Thinking…".
      const res = await fetch("/api/voice/hear", { method: "POST", headers: { "Content-Type": type }, body: new Blob(chunks, { type }), signal: AbortSignal.timeout(30_000) });
      const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
      if (!res.ok) {
        this.screen.problem(data.error ?? tNow("Flash couldn't hear that. Please try again."));
        // Out of credits, or not available (or not for what this browser records): stop listening
        // rather than fail every turn.
        if (res.status === 402 || res.status === 415 || res.status === 503) this.paused = true;
        return "";
      }
      this.screen.problem("");
      return (data.text ?? "").trim();
    } catch {
      this.screen.problem(tNow("Flash couldn't hear that. Check your connection."));
      return "";
    }
  }
}

/**
 * A live voice conversation, docked where the message box is: Flash listens, sends what it hears
 * to the open chat, reads the answer aloud, then listens again. The browser understands speech in
 * Chrome, Edge and Safari; elsewhere each turn is recorded and Flash writes it down.
 */
export function VoiceMode(props: VoiceProps) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>("starting");
  const [you, setYou] = useState("");
  const [flash, setFlash] = useState("");
  const [problem, setProblem] = useState("");
  const [silent, setSilent] = useState("");
  const [builtIn] = useState(hasBuiltInRecognition);
  const latest = useRef(props);
  const conversation = useRef<Conversation | null>(null);

  useEffect(() => {
    latest.current = props;
  });

  useEffect(() => {
    const c = new Conversation(
      { phase: setPhase, you: setYou, flash: setFlash, problem: setProblem, silent: setSilent, props: () => latest.current },
      builtIn,
    );
    conversation.current = c;
    // Started a moment later, so React's mount-twice check in development doesn't ask "Hey Flash, …" twice.
    const start = setTimeout(() => void c.run(), 0);
    return () => {
      clearTimeout(start);
      c.stop();
    };
  }, [builtIn]);

  useEffect(() => {
    // Escape ends the conversation, unless it's closing a dialog on top (like Settings).
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !document.querySelector('[role="dialog"]') && latest.current.onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  function hearAgain() {
    const text = silent;
    setSilent("");
    conversation.current?.replay(text);
  }

  const circle =
    phase === "listening"
      ? "animate-pulse bg-primary/30 ring-4 ring-primary/30"
      : phase === "speaking"
        ? "bg-primary/60 ring-8 ring-primary/20 motion-safe:animate-[pulse_0.9s_ease-in-out_infinite]"
        : phase === "thinking"
          ? "bg-primary/20 ring-2 ring-primary/40 motion-safe:animate-spin [border-top-color:transparent]"
          : "bg-zinc-700/60 ring-2 ring-white/10";
  const circleLabel =
    phase === "speaking" ? t("Interrupt Flash") : phase === "paused" ? t("Start listening") : phase === "listening" ? t("Pause listening") : t(LABELS[phase]);

  return (
    <section aria-label={t("Voice conversation")} className="rounded-3xl border border-primary/25 bg-zinc-900/90 p-3 shadow-2xl sm:p-4">
      <div className="flex items-center gap-3 sm:gap-4">
        <button
          type="button"
          onClick={() => conversation.current?.tap()}
          aria-label={circleLabel}
          title={circleLabel}
          className="relative flex h-14 w-14 shrink-0 items-center justify-center rounded-full"
        >
          <span className={`absolute inset-0 rounded-full border-2 border-primary/50 transition ${circle}`} aria-hidden />
          <span className="relative h-5 w-5 rounded-full bg-primary-soft" aria-hidden />
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-zinc-100" aria-live="polite">
            {t(LABELS[phase])}
            {phase === "paused" && <span className="font-normal text-zinc-400"> · {t("tap the circle to talk")}</span>}
          </p>
          {you && (
            <p className="truncate text-xs text-zinc-400" title={you}>
              {t("You: {words}", { words: you })}
            </p>
          )}
          {flash && (
            <p className="line-clamp-2 text-xs text-zinc-300" title={flash}>
              {t("Flash: {words}", { words: flash })}
            </p>
          )}
        </div>
        {(phase === "thinking" || phase === "speaking") && props.busy && (
          <button
            type="button"
            // Flash stops talking at once, as well as stopping the request.
            onClick={() => {
              conversation.current?.hush();
              props.onStop();
            }}
            className="shrink-0 rounded-full border border-white/10 px-3 py-1.5 text-xs text-zinc-200 hover:bg-white/[0.06]"
          >
            {t("Stop")}
          </button>
        )}
        <button
          type="button"
          onClick={props.onClose}
          className="shrink-0 rounded-full bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-900 hover:bg-white"
          aria-label={t("End voice conversation")}
        >
          {t("End")}
        </button>
      </div>
      {silent && (
        <button type="button" onClick={hearAgain} className="mt-2 text-xs text-primary-soft hover:underline">
          🔊 {t("Tap to hear Flash")}
        </button>
      )}
      {problem && (
        <p role="alert" className="mt-2 text-xs text-spark-soft">
          {problem}
        </p>
      )}
      {!builtIn && (
        <p className="mt-2 text-xs text-zinc-500">
          {t(
            "This browser can't understand speech by itself, so Flash listens for you: about 3 credits each time you speak. In Chrome, Edge or Safari, listening is free.",
          )}
        </p>
      )}
      <p className="mt-1 hidden text-xs text-zinc-600 sm:block">{t("Say “bye” or press End to finish. Everything said stays in this chat.")}</p>
    </section>
  );
}
