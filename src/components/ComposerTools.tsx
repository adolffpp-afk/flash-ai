"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ENGINES, ENGINE_LABELS, type Engine } from "@/lib/types";
import type { Me } from "@/lib/store";
import { BoltIcon } from "@/app/brand";
import { EngineIcon } from "./EngineIcon";

export type Choice = Engine | "auto";

// One line per tool in the tool menu.
const HINTS: Record<Engine, string> = {
  text: "Emails, posts, plans and answers",
  search: "Up-to-date answers with sources",
  code: "Write, explain and fix code",
  translate: "Natural translations in your tone",
  docs: "Spreadsheets, tables and reports",
  image: "Logos, posters and photos",
  video: "Short clips, with sound",
  voice: "Read any text aloud",
  music: "Jingles, beats and songs",
  transcribe: "Recordings into text",
  app: "Working apps you can publish",
  slides: "A presentation from one sentence",
};

const round =
  "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-40";

function Icon({ d, className = "h-5 w-5" }: { d: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

/** A menu that opens above its button and closes on Escape or a click elsewhere. */
function Popover({
  button,
  children,
  label,
  align = "left",
}: {
  button: (open: boolean, toggle: () => void) => ReactNode;
  children: (close: () => void) => ReactNode;
  label: string;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const escape = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      {button(open, () => setOpen((o) => !o))}
      {open && (
        <div
          role="menu"
          aria-label={label}
          className={`absolute bottom-full z-30 mb-2 max-h-[min(70vh,520px)] w-72 overflow-y-auto rounded-2xl border border-white/10 bg-zinc-900 p-1.5 shadow-2xl shadow-black/50 ${
            align === "left" ? "left-0" : "right-0"
          }`}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

const item =
  "flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left text-sm text-zinc-200 transition hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-45";

/** The + button: add a file, or take a photo on phones. */
export function PlusMenu({ onFiles, onCamera }: { onFiles: () => void; onCamera: () => void }) {
  return (
    <Popover
      label="Add"
      button={(open, toggle) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-label="Add files and more"
          title="Add files and more"
          className={`${round} bg-white/[0.06] text-zinc-200 hover:bg-white/[0.1] ${open ? "bg-white/[0.12]" : ""}`}
        >
          <Icon d="M12 5v14 M5 12h14" className={`h-5 w-5 transition ${open ? "rotate-45" : ""}`} />
        </button>
      )}
    >
      {(close) => (
        <>
          <button type="button" role="menuitem" className={item} onClick={() => (close(), onFiles())}>
            <Icon d="M21 11.5l-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6l8-8" className="h-5 w-5 text-zinc-400" />
            <span>
              Add photos & files
              <span className="block text-xs text-zinc-500">PDF, image, sheet, text, audio or video</span>
            </span>
          </button>
          <button type="button" role="menuitem" className={item} onClick={() => (close(), onCamera())}>
            <Icon d="M4 8h3l2-3h6l2 3h3v11H4z M15.5 13a3.5 3.5 0 1 1-7 0a3.5 3.5 0 1 1 7 0z" className="h-5 w-5 text-zinc-400" />
            <span>
              Take a photo
              <span className="block text-xs text-zinc-500">Uses your camera on phones and tablets</span>
            </span>
          </button>
        </>
      )}
    </Popover>
  );
}

/** The tool pill: Auto or one tool, plus that tool's model when it has several. */
export function ToolPicker({
  choice,
  setChoice,
  isLive,
  models,
  model,
  setModel,
}: {
  choice: Choice;
  setChoice: (c: Choice) => void;
  isLive: (e: Engine) => boolean;
  models: Me["models"];
  model: string | undefined;
  setModel: (engine: Engine, id: string | undefined) => void;
}) {
  const options = choice === "auto" ? [] : models.filter((m) => m.engine === choice);
  const picked = options.find((m) => m.id === model);
  const check = <Icon d="M5 12l5 5 9-10" className="ml-auto h-4 w-4 text-primary-soft" />;
  return (
    <Popover
      label="Tools"
      button={(open, toggle) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          title="Choose a tool"
          className={`inline-flex h-10 min-w-0 items-center gap-1.5 rounded-full bg-white/[0.06] px-4 text-sm text-zinc-100 transition hover:bg-white/[0.1] ${open ? "bg-white/[0.12]" : ""}`}
        >
          {choice === "auto" ? <BoltIcon className="h-3.5 w-3.5 text-gold" /> : null}
          <span className="truncate">{choice === "auto" ? "Auto" : ENGINE_LABELS[choice]}</span>
          <span className="truncate text-zinc-400">{picked ? picked.label : choice === "auto" ? "Best tool" : ""}</span>
          <Icon d="M7 10l5 5 5-5" className="h-4 w-4 shrink-0 text-zinc-500" />
        </button>
      )}
    >
      {(close) => (
        <>
          {options.some((m) => m.live) && (
            <>
              <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                {ENGINE_LABELS[choice as Engine]} model
              </p>
              <button type="button" role="menuitemradio" aria-checked={!picked} className={item} onClick={() => (setModel(choice as Engine, undefined), close())}>
                <span>
                  ⚡ Best for each request
                  <span className="block text-xs text-zinc-500">Flash matches each request to the right model</span>
                </span>
                {!picked && check}
              </button>
              {options.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={picked?.id === m.id}
                  disabled={!m.live}
                  className={item}
                  onClick={() => (setModel(m.engine, m.id), close())}
                >
                  <span className="min-w-0">
                    {m.label} <span className="text-xs text-zinc-500">· {m.credits} credits</span>
                    <span className="block truncate text-xs text-zinc-500">{m.live ? m.blurb : "Coming soon"}</span>
                  </span>
                  {picked?.id === m.id && check}
                </button>
              ))}
              <div className="my-1.5 border-t border-white/8" />
            </>
          )}
          <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-500">Tool</p>
          <button type="button" role="menuitemradio" aria-checked={choice === "auto"} className={item} onClick={() => (setChoice("auto"), close())}>
            <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-gold/15 text-gold ring-1 ring-inset ring-gold/30">
              <BoltIcon className="h-3.5 w-3.5" />
            </span>
            <span>
              Auto
              <span className="block text-xs text-zinc-500">Flash picks the best tool for each message</span>
            </span>
            {choice === "auto" && check}
          </button>
          {ENGINES.map((e) => (
            <button
              key={e}
              type="button"
              role="menuitemradio"
              aria-checked={choice === e}
              disabled={!isLive(e)}
              className={item}
              onClick={() => (setChoice(e), close())}
            >
              <EngineIcon engine={e} size="sm" />
              <span>
                {ENGINE_LABELS[e]}
                <span className="block text-xs text-zinc-500">{isLive(e) ? HINTS[e] : "Coming soon"}</span>
              </span>
              {choice === e && check}
            </button>
          ))}
        </>
      )}
    </Popover>
  );
}

type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
};

function recognition(): Recognition | null {
  const w = window as unknown as Record<string, (new () => Recognition) | undefined>;
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return Ctor ? new Ctor() : null;
}

/**
 * The mic: speak and your words appear in the message box. Browsers without speech recognition
 * (Firefox) record a clip instead and attach it, which Flash transcribes.
 */
export function MicButton({
  onText,
  onRecording,
  disabled,
}: {
  onText: (text: string) => void;
  onRecording: (file: File) => void;
  disabled?: boolean;
}) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState("");
  const stopRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopRef.current?.(), []);

  async function start() {
    setError("");
    const rec = recognition();
    if (rec) {
      rec.lang = navigator.language || "en-US";
      rec.continuous = true;
      rec.interimResults = false;
      rec.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) onText(e.results[i][0].transcript.trim());
        }
      };
      rec.onerror = (e) => {
        if (e.error === "not-allowed" || e.error === "service-not-allowed") setError("Allow the microphone to talk to Flash.");
        else if (e.error !== "no-speech" && e.error !== "aborted") setError("Flash couldn't hear that. Please try again.");
      };
      rec.onend = () => {
        stopRef.current = null;
        setListening(false);
      };
      stopRef.current = () => rec.stop();
      rec.start();
      setListening(true);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("This browser can't use the microphone.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Formats Flash's transcription accepts, best first.
      const mime = ["audio/ogg;codecs=opus", "audio/mp4", "audio/webm"].find((t) => MediaRecorder.isTypeSupported(t));
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        stopRef.current = null;
        setListening(false);
        const type = (recorder.mimeType || "audio/webm").split(";")[0];
        const ext = type.split("/")[1] === "mp4" ? "m4a" : type.split("/")[1];
        if (chunks.length) onRecording(new File(chunks, `recording.${ext}`, { type }));
      };
      stopRef.current = () => recorder.state !== "inactive" && recorder.stop();
      recorder.start();
      setListening(true);
    } catch {
      setError("Allow the microphone to talk to Flash.");
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => (listening ? stopRef.current?.() : start())}
        aria-pressed={listening}
        aria-label={listening ? "Stop listening" : "Talk"}
        title={listening ? "Stop listening" : "Talk instead of typing"}
        className={`${round} ${
          listening ? "animate-pulse bg-spark/20 text-spark-soft ring-1 ring-spark/40" : "bg-white/[0.06] text-zinc-200 hover:bg-white/[0.1]"
        }`}
      >
        <Icon d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z M5 11a7 7 0 0 0 14 0 M12 18v3" />
      </button>
      {error && (
        <p role="status" className="absolute bottom-full right-0 mb-2 w-56 rounded-lg bg-zinc-800 px-3 py-2 text-xs text-zinc-200 shadow-lg">
          {error}
        </p>
      )}
    </div>
  );
}

/** The round send button, which becomes a stop button while Flash replies. */
export function SendButton({ busy, disabled, onStop }: { busy: boolean; disabled: boolean; onStop: () => void }) {
  return busy ? (
    <button type="button" onClick={onStop} aria-label="Stop" title="Stop" className={`${round} bg-zinc-100 text-zinc-900 hover:bg-white`}>
      <span className="h-3.5 w-3.5 rounded-[3px] bg-current" />
    </button>
  ) : (
    <button type="submit" disabled={disabled} aria-label="Send" title="Send" className={`${round} bg-zinc-100 text-zinc-900 hover:bg-white`}>
      <Icon d="M12 19V5 M6 11l6-6 6 6" className="h-5 w-5" />
    </button>
  );
}
