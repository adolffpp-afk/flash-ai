"use client";

import { useEffect, useRef, useState } from "react";
import { hasBuiltInRecognition, micBlocked, newRecognition, releaseMic, takeMic } from "@/lib/listen";
import { isGoodbye, isNo, isYes, speechChunks } from "@/lib/voice-chat";
import { readAloudVoice } from "@/lib/device-settings";
import { speechLang } from "@/lib/languages";

/** What Flash says after a request, and whether it asked to go ahead with a costly one. */
export type VoiceAnswer = { say: string; confirm: boolean };

type Phase = "starting" | "listening" | "thinking" | "speaking" | "paused";

const LABELS: Record<Phase, string> = {
  starting: "Starting…",
  listening: "Listening…",
  thinking: "Thinking…",
  speaking: "Speaking…",
  paused: "Paused",
};

// After this long with nothing said, Flash stops listening until the user taps the circle.
const QUIET_MS = 60_000;
// Recording (browsers that can't recognise speech themselves): a turn ends after this much
// silence, gives up when nobody speaks, and never runs longer than the cap.
const END_SILENCE_MS = 1200;
const NO_SPEECH_MS = 12_000;
const MAX_TURN_MS = 30_000;
const MIC_BLOCKED = "Allow the microphone for Flash in your browser, then tap the circle.";

type VoiceProps = {
  name: string;
  // The language picked in Settings > General; Flash listens and speaks in it. "" or missing: the browser's.
  language?: string;
  // Words said right after "Hey Flash", asked at once.
  first?: string;
  // Opened by "Hey Flash" (Flash answers "Yes?") rather than the Talk button.
  woke: boolean;
  busy: boolean;
  ask: (text: string) => Promise<VoiceAnswer>;
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
 * until it is stopped. Lives outside React so its timers and callbacks aren't tied to renders.
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
    this.heardAt = Date.now();
    if (!pending) await this.say(p().woke ? `Yes, ${p().name}?` : `Hi ${p().name}. What can I do for you?`);
    while (this.alive) {
      if (this.paused) {
        this.show("paused");
        await new Promise<void>((r) => (this.resume = r));
        this.resume = null;
        this.heardAt = Date.now();
        continue;
      }
      let heard: string | null = pending || null;
      pending = "";
      if (heard === null) {
        this.show("listening");
        heard = await (this.builtIn ? this.hearBuiltIn() : this.hearRecorded());
      }
      if (!this.alive) return;
      if (heard === null) continue;
      if (!heard) {
        if (Date.now() - this.heardAt > QUIET_MS) this.paused = true;
        continue;
      }
      this.heardAt = Date.now();
      this.screen.you(heard);
      if (isGoodbye(heard)) {
        await this.say(`Bye, ${p().name}.`);
        if (this.alive) p().onClose();
        return;
      }
      this.show("thinking");
      this.screen.flash("");
      let answer: VoiceAnswer;
      if (confirming && isYes(heard)) answer = await p().confirm();
      else if (confirming && isNo(heard)) answer = { say: "Okay, I won't make it.", confirm: false };
      else if (p().busy) answer = { say: "I'm still working on your last request. Ask me again when it's done.", confirm: false };
      else answer = await p().ask(heard);
      confirming = answer.confirm;
      if (!this.alive) return;
      await this.say(answer.say);
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

  /** The circle: interrupts Flash while it speaks, pauses listening, or starts it again. */
  tap() {
    if (this.phase === "speaking") this.cutSpeech?.();
    else if (this.phase === "paused") {
      this.paused = false;
      this.screen.problem("");
      this.resume?.();
    } else if (this.phase === "listening") {
      this.paused = true;
      this.cancelHearing?.();
      this.show("paused");
    }
  }

  /** Says text aloud, resolving when it's done or cut off. */
  private say(text: string): Promise<void> {
    this.screen.flash(text);
    if (!this.alive) return Promise.resolve();
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
          if (e.error === "not-allowed") this.screen.silent(text);
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
          this.screen.problem(MIC_BLOCKED);
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
      this.screen.problem(MIC_BLOCKED);
      this.paused = true;
      return null;
    }
  }

  /** Records one turn, ending it after a pause, and has Flash write down what was said. */
  private async hearRecorded(): Promise<string | null> {
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      this.screen.problem("This browser can't use the microphone.");
      this.paused = true;
      return null;
    }
    const mic = await this.microphone();
    if (!mic || !this.alive) return null;
    await mic.context.resume().catch(() => {});
    const analyser = mic.context.createAnalyser();
    analyser.fftSize = 1024;
    const source = mic.context.createMediaStreamSource(mic.stream);
    source.connect(analyser);
    const mime = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((t) => MediaRecorder.isTypeSupported(t));
    const recorder = new MediaRecorder(mic.stream, { ...(mime && { mimeType: mime }), audioBitsPerSecond: 24_000 });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);

    const spoke = await new Promise<boolean | null>((resolve) => {
      const samples = new Float32Array(analyser.fftSize);
      const started = Date.now();
      let floor = 0;
      let measured = 0;
      let speechAt = 0;
      let lastVoice = 0;
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
        const level = Math.sqrt(sum / samples.length);
        const now = Date.now();
        // The first moments set how loud the room is.
        if (now - started < 300) {
          floor = (floor * measured + level) / ++measured;
          return;
        }
        if (level > Math.max(0.02, floor * 3)) {
          if (!speechAt) speechAt = now;
          lastVoice = now;
        }
        if (speechAt && now - lastVoice > END_SILENCE_MS && lastVoice - speechAt > 300) end(true);
        else if (!speechAt && now - started > NO_SPEECH_MS) end(false);
        else if (speechAt && now - speechAt > MAX_TURN_MS) end(true);
      }, 50);
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
      const res = await fetch("/api/voice/hear", { method: "POST", headers: { "Content-Type": type }, body: new Blob(chunks, { type }) });
      const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
      if (!res.ok) {
        this.screen.problem(data.error ?? "Flash couldn't hear that. Please try again.");
        // Out of credits or not available: stop listening rather than fail every turn.
        if (res.status === 402 || res.status === 503) this.paused = true;
        return "";
      }
      this.screen.problem("");
      return (data.text ?? "").trim();
    } catch {
      this.screen.problem("Flash couldn't hear that. Check your connection.");
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
    void c.run();
    return () => c.stop();
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
    window.speechSynthesis.cancel();
    for (const u of speakPieces(text, talkingIn(props.language))) window.speechSynthesis.speak(u);
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
    phase === "speaking" ? "Interrupt Flash" : phase === "paused" ? "Start listening" : phase === "listening" ? "Pause listening" : LABELS[phase];

  return (
    <section aria-label="Voice conversation" className="rounded-3xl border border-primary/25 bg-zinc-900/90 p-3 shadow-2xl sm:p-4">
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
            {LABELS[phase]}
            {phase === "paused" && <span className="font-normal text-zinc-400"> · tap the circle to talk</span>}
          </p>
          {you && (
            <p className="truncate text-xs text-zinc-400" title={you}>
              You: {you}
            </p>
          )}
          {flash && (
            <p className="line-clamp-2 text-xs text-zinc-300" title={flash}>
              Flash: {flash}
            </p>
          )}
        </div>
        {phase === "thinking" && props.busy && (
          <button type="button" onClick={props.onStop} className="shrink-0 rounded-full border border-white/10 px-3 py-1.5 text-xs text-zinc-200 hover:bg-white/[0.06]">
            Stop
          </button>
        )}
        <button
          type="button"
          onClick={props.onClose}
          className="shrink-0 rounded-full bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-900 hover:bg-white"
          aria-label="End voice conversation"
        >
          End
        </button>
      </div>
      {silent && (
        <button type="button" onClick={hearAgain} className="mt-2 text-xs text-primary-soft hover:underline">
          🔊 Tap to hear Flash
        </button>
      )}
      {problem && (
        <p role="alert" className="mt-2 text-xs text-spark-soft">
          {problem}
        </p>
      )}
      {!builtIn && (
        <p className="mt-2 text-xs text-zinc-500">
          This browser can&apos;t understand speech by itself, so Flash listens for you: about 3 credits each time you speak. In Chrome, Edge or
          Safari, listening is free.
        </p>
      )}
      <p className="mt-1 hidden text-xs text-zinc-600 sm:block">Say &ldquo;bye&rdquo; or press End to finish. Everything said stays in this chat.</p>
    </section>
  );
}
