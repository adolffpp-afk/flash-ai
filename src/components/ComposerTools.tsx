"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ENGINES, ENGINE_LABELS, type Engine } from "@/lib/types";
import type { Me } from "@/lib/store";
import { BoltIcon } from "@/app/brand";
import { EngineIcon } from "./EngineIcon";
import { micBlocked, newRecognition, releaseMic, takeMic } from "@/lib/listen";
import { LEVELS, type Level } from "@/lib/levels";

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

// A little smaller in a narrow message box (a phone, or beside Ask Flash), so the tool picker keeps its name.
const round =
  "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-40 @min-[380px]/composer:h-10 @min-[380px]/composer:w-10";

function Icon({ d, className = "h-5 w-5" }: { d: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

/**
 * Whether the message box's menus open below their buttons. The box sits at the bottom of a chat,
 * so menus open upward there; on Home it sits near the top, where an upward menu would be cut off.
 */
export const MenusOpenDown = createContext(false);

/** A menu that opens above its button (below it on Home) and closes on Escape or a click elsewhere. */
function Popover({
  button,
  children,
  label,
  align = "left",
  phoneWide = false,
  shrink = false,
}: {
  button: (open: boolean, toggle: () => void) => ReactNode;
  children: (close: () => void) => ReactNode;
  label: string;
  align?: "left" | "right";
  // On phones the menu opens from the message box's edge instead of the button, so it stays on screen.
  phoneWide?: boolean;
  // Lets the button shrink (its label truncates) when the row is tight; the others keep their size.
  shrink?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const down = useContext(MenusOpenDown);
  const ref = useRef<HTMLDivElement>(null);
  // Opening downwards (the message box on Home), the page scrolls just enough to show the whole menu.
  const showWhole = useCallback((menu: HTMLDivElement | null) => {
    if (down) menu?.scrollIntoView({ block: "nearest" });
  }, [down]);
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
    <div ref={ref} className={`${shrink ? "min-w-0" : "shrink-0"} ${phoneWide ? "sm:relative" : "relative"}`}>
      {button(open, () => setOpen((o) => !o))}
      {open && (
        <div
          role="menu"
          aria-label={label}
          ref={showWhole}
          className={`absolute z-40 w-72 overflow-y-auto rounded-2xl border border-white/10 bg-zinc-900 p-1.5 shadow-2xl shadow-black/50 light:shadow-black/10 ${
            down ? "top-full mt-2 max-h-[min(60vh,520px)]" : "bottom-full mb-2 max-h-[min(70vh,520px)]"
          } ${
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
      shrink
      button={(open, toggle) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          title="Choose a tool"
          className={`inline-flex h-9 max-w-full min-w-0 items-center gap-1.5 overflow-hidden rounded-full bg-white/[0.06] px-3 text-sm text-zinc-100 transition hover:bg-white/[0.1] @min-[380px]/composer:h-10 @min-[440px]/composer:px-4 ${open ? "bg-white/[0.12]" : ""}`}
        >
          {choice === "auto" ? <BoltIcon className="h-3.5 w-3.5 shrink-0 text-gold" /> : null}
          <span className="truncate">{choice === "auto" ? "Auto" : ENGINE_LABELS[choice]}</span>
          <span className={`min-w-0 truncate text-zinc-300 light:text-zinc-500 ${picked ? "" : "hidden @min-[440px]/composer:inline"}`}>{picked ? picked.label : choice === "auto" ? "Best tool" : ""}</span>
          <Icon d="M7 10l5 5 5-5" className="hidden h-4 w-4 shrink-0 text-zinc-500 @min-[380px]/composer:block" />
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

// How many of the four bars each level fills; Auto shows them all, in gold.
const BARS: Record<Level, number> = { auto: 4, sonic: 1, ascend: 2, vision: 3, ultra: 4 };

/** Rising bars, filled up to the level: one for Sonic up to four for Summit. */
function LevelBars({ level, className = "h-4 w-4" }: { level: Level; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <rect
          key={i}
          x={1 + i * 3.75}
          y={11 - i * 3}
          width="2.5"
          height={4 + i * 3}
          rx="1"
          fill="currentColor"
          opacity={i < BARS[level] ? 1 : 0.25}
        />
      ))}
    </svg>
  );
}

/**
 * Flash's level of intelligence for writing, research and building: Auto, or one of the four
 * levels. Pictures, video, music and voice have their own models, so it hides for those tools.
 */
export function LevelPicker({ level, setLevel }: { level: Level; setLevel: (level: Level) => void }) {
  const current = LEVELS.find((l) => l.id === level) ?? LEVELS[0];
  const check = <Icon d="M5 12l5 5 9-10" className="ml-auto h-4 w-4 shrink-0 text-primary-soft" />;
  return (
    <Popover
      label="Intelligence level"
      align="right"
      phoneWide
      button={(open, toggle) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-label={`Intelligence level: ${current.name}`}
          title="Choose Flash's level of intelligence"
          // In a narrow message box only the bars show, so it keeps room for the tool picker.
          className={`inline-flex h-9 w-9 shrink-0 items-center justify-center gap-1.5 rounded-full text-sm text-zinc-200 transition hover:bg-white/[0.06] @min-[380px]/composer:h-10 @min-[380px]/composer:w-10 @min-[440px]/composer:w-auto @min-[440px]/composer:px-3 ${open ? "bg-white/[0.08]" : ""}`}
        >
          <LevelBars level={current.id} className={`h-4 w-4 shrink-0 ${current.id === "auto" ? "text-gold" : "text-primary-soft"}`} />
          <span className="hidden @min-[440px]/composer:inline">{current.short}</span>
          <Icon d="M7 10l5 5 5-5" className="hidden h-4 w-4 text-zinc-500 @min-[440px]/composer:block" />
        </button>
      )}
    >
      {(close) => (
        <>
          <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-500">Intelligence</p>
          {LEVELS.map((l) => (
            <button
              key={l.id}
              type="button"
              role="menuitemradio"
              aria-checked={level === l.id}
              className={item}
              onClick={() => (setLevel(l.id), close())}
            >
              <span
                className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md ring-1 ring-inset ${
                  l.id === "auto" ? "bg-gold/15 text-gold ring-gold/30" : "bg-primary/10 text-primary-soft ring-primary/25"
                }`}
              >
                <LevelBars level={l.id} className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0">
                {l.name}
                <span className="block text-xs text-zinc-500">{l.blurb}</span>
              </span>
              {level === l.id && check}
            </button>
          ))}
          <p className="px-2.5 pb-1.5 pt-2 text-xs leading-relaxed text-zinc-500">
            Credits follow what each answer really costs. Pictures, video, music and voice use their own models.
          </p>
        </>
      )}
    </Popover>
  );
}

/**
 * The mic: speak and your words appear in the message box. Browsers without speech recognition
 * (Firefox) record a clip instead and attach it, which Flash transcribes.
 */
export function MicButton({
  onText,
  onRecording,
  onListening,
  disabled,
}: {
  onText: (text: string) => void;
  onRecording: (file: File) => void;
  // Tells Flash the mic is in use, so the "Hey Flash" listener waits.
  onListening?: (on: boolean) => void;
  disabled?: boolean;
}) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState("");
  const stopRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopRef.current?.(), []);
  const listen = (on: boolean) => {
    setListening(on);
    onListening?.(on);
    if (!on) releaseMic("dictation");
  };

  async function start() {
    setError("");
    const rec = newRecognition();
    if (rec) {
      rec.continuous = true;
      rec.interimResults = false;
      rec.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) onText(e.results[i][0].transcript.trim());
        }
      };
      rec.onerror = (e) => {
        if (micBlocked(e.error)) setError("Allow the microphone to talk to Flash.");
        else if (e.error !== "no-speech" && e.error !== "aborted") setError("Flash couldn't hear that. Please try again.");
      };
      rec.onend = () => {
        stopRef.current = null;
        listen(false);
      };
      stopRef.current = () => rec.stop();
      takeMic("dictation", () => rec.abort());
      listen(true);
      rec.start();
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
        listen(false);
        const type = (recorder.mimeType || "audio/webm").split(";")[0];
        const ext = type.split("/")[1] === "mp4" ? "m4a" : type.split("/")[1];
        if (chunks.length) onRecording(new File(chunks, `recording.${ext}`, { type }));
      };
      stopRef.current = () => recorder.state !== "inactive" && recorder.stop();
      takeMic("dictation", () => recorder.state !== "inactive" && recorder.stop());
      recorder.start();
      listen(true);
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

/**
 * The round send button, which becomes a stop button while Flash replies. They're separate
 * elements (the keys): stopping re-renders at once, and a reused element would turn into the send
 * button mid-click and send whatever is typed in the composer.
 */
export function SendButton({ busy, disabled, onStop }: { busy: boolean; disabled: boolean; onStop: () => void }) {
  return busy ? (
    <button
      key="stop"
      type="button"
      onClick={(e) => {
        e.preventDefault();
        onStop();
      }}
      aria-label="Stop"
      title="Stop"
      className={`${round} bg-zinc-100 text-zinc-900 hover:bg-white`}
    >
      <span className="h-3.5 w-3.5 rounded-[3px] bg-current" />
    </button>
  ) : (
    <button
      key="send"
      type="submit"
      disabled={disabled}
      aria-label="Send"
      title="Send"
      // Still the brand colours while there's nothing to send, only softer.
      className={`${round.replace("disabled:opacity-40", "disabled:opacity-60")} bg-send text-on-brand shadow-[0_8px_20px_-10px_rgb(139_92_246/0.8)] hover:brightness-110 disabled:saturate-[.8]`}
    >
      <Icon d="M12 19V5 M6 11l6-6 6 6" className="h-5 w-5" />
    </button>
  );
}

/** Starts a voice conversation. The dot shows that Flash is listening for "Hey Flash". */
export function TalkButton({ onTalk, waking, disabled }: { onTalk: () => void; waking: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onTalk}
      disabled={disabled}
      aria-label="Talk with Flash"
      title={waking ? 'Talk with Flash. Flash is also listening for "Hey Flash".' : "Talk with Flash: a voice conversation"}
      className={`${round} relative bg-white/[0.06] text-zinc-200 hover:bg-white/[0.1]`}
    >
      <Icon d="M4 10v4 M8 7v10 M12 4v16 M16 7v10 M20 10v4" />
      {waking && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-primary ring-2 ring-zinc-900" aria-hidden />}
    </button>
  );
}
