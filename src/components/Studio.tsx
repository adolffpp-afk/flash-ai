"use client";

import { useEffect, useRef, useState } from "react";
import { msg } from "@/lib/i18n";
import { useT } from "@/lib/use-t";
import { modelById, modelCredits } from "@/lib/models";
import { AD_LENGTHS, adPlan, adRequest, adSecondsOf, type AdShape } from "@/lib/ad-studio";
import { STORY_LENGTHS, filmPartRequest, storyLength, storyPlan, storyRequest } from "@/lib/story-studio";
import { ICONS, Tile } from "./Home";

const SHAPES: [AdShape, string, string][] = [
  ["tall", msg("Vertical"), msg("9:16 · TikTok, Reels, Shorts")],
  ["square", msg("Square"), msg("1:1 · Instagram and Facebook feeds")],
  ["wide", msg("Landscape"), msg("16:9 · YouTube, websites, TV")],
];

/** What the Studio makes: an ad, or a story (a drama in parts, see story-studio.ts). */
export type StudioMode = "ad" | "story";

/**
 * Flash Infinity AI Studio, from the menu: the Ads Studio and Story mode. The user describes the ad and
 * picks its shape, length, voiceover and music; a storyboard comes first by default, so they see the
 * script and every scene's first picture for a few credits before paying to film it in HD.
 */
export function Studio({
  brief: typed = "",
  mode: startMode = "story",
  onMake,
  onClose,
  busy,
}: {
  // Words typed in the chat that asked for a video: the brief, with its length and sound as it says.
  brief?: string;
  mode?: StudioMode;
  onMake: (request: string, photo: File | null, model: string) => Promise<boolean>;
  onClose: () => void;
  busy: boolean;
}) {
  const t = useT();
  const closeRef = useRef<HTMLButtonElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<StudioMode>(startMode);
  const [asked] = useState(() => adPlan(typed));
  // A part's length, the one offered nearest to what the words ask for.
  const [partSeconds, setPartSeconds] = useState<number>(() => {
    const said = storyLength(storyPlan(typed));
    return STORY_LENGTHS.reduce((best, s) => (Math.abs(s - said) < Math.abs(best - said) ? s : best));
  });
  const [brief, setBrief] = useState(typed);
  // Vertical unless the words ask for another shape (adPlan reads none as wide, for a TV ad).
  const [shape, setShape] = useState<AdShape>(/\b(square|1:1|landscape|16:9|wide|youtube|tv)\b/i.test(typed) ? asked.shape : "tall");
  const [seconds, setSeconds] = useState<number>(() => adSecondsOf(typed));
  const [voice, setVoice] = useState(asked.voice);
  const [music, setMusic] = useState(asked.music);
  const [photo, setPhoto] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  useEffect(() => {
    closeRef.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const ads = modelById("ad-studio")!;
  const stories = modelById("story-studio")!;
  const story = storyRequest(brief, { seconds: partSeconds, shape });
  const storyCredits = modelCredits(stories, story);
  // Filming the part afterwards, at most (any storyboard id prices the same).
  const filmCredits = modelCredits(stories, filmPartRequest("storyboard", storyPlan(story)));
  const choices = { seconds, shape, voice, music };
  // The most each costs; what's made is charged (see ad-studio.ts).
  const boardCredits = modelCredits(ads, adRequest(brief, { ...choices, storyboard: true }));
  const wholeCredits = modelCredits(ads, adRequest(brief, choices));
  const ready = brief.trim().length >= 3 && !busy && !sending;

  async function make(storyboard: boolean) {
    if (!ready) return;
    setSending(true);
    const sent = await onMake(adRequest(brief, { ...choices, storyboard }), photo, "ad-studio");
    setSending(false);
    if (sent) onClose();
  }

  async function writeStory() {
    if (!ready) return;
    setSending(true);
    const sent = await onMake(story, null, "story-studio");
    setSending(false);
    if (sent) onClose();
  }

  const chip = (on: boolean) =>
    `rounded-2xl px-3 py-2 text-left text-sm ring-1 ring-inset transition ${
      on ? "bg-primary/15 text-white ring-primary/60" : "bg-white/[0.03] text-zinc-300 ring-white/10 hover:ring-white/25 light:bg-black/[0.02] light:ring-black/10"
    }`;

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="studio-title"
        className="flex max-h-[92dvh] w-full max-w-2xl flex-col rounded-t-3xl border border-white/8 bg-zinc-950 text-zinc-100 sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 px-6 pb-2 pt-6 sm:px-7">
          <div className="flex min-w-0 items-center gap-3">
            <Tile d={ICONS.film} hue="violet" size="sm" />
            <div className="min-w-0">
              <h2 id="studio-title" className="text-xl font-semibold tracking-tight">
                {t("Infinity AI Studio")}
              </h2>
              <p className="mt-0.5 text-sm leading-relaxed text-zinc-400">{t(mode === "story" ? stories.blurb : ads.blurb)}</p>
            </div>
          </div>
          <button ref={closeRef} onClick={onClose} className="rounded-full p-2 text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100" aria-label={t("Close")}>
            ✕
          </button>
        </div>

        <div className="min-h-0 space-y-5 overflow-y-auto px-6 pb-6 pt-3 sm:px-7">
          <div className="grid grid-cols-2 gap-2" role="group" aria-label={t("What to make")}>
            <button type="button" onClick={() => setMode("story")} className={chip(mode === "story")} aria-pressed={mode === "story"}>
              <span className="block font-medium">🎭 {t("Story or drama")}</span>
              <span className="block text-xs text-zinc-400">{t("Characters who talk, in parts")}</span>
            </button>
            <button type="button" onClick={() => setMode("ad")} className={chip(mode === "ad")} aria-pressed={mode === "ad"}>
              <span className="block font-medium">📣 {t("Ad")}</span>
              <span className="block text-xs text-zinc-400">{t("Voiceover, music, your product")}</span>
            </button>
          </div>

          <label className="block">
            <span className="text-sm font-medium text-zinc-200">{mode === "story" ? t("Describe your story") : t("Describe your ad")}</span>
            <textarea
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              rows={4}
              maxLength={3000}
              placeholder={
                mode === "story"
                  ? t("A young nurse in Lagos finds out her new boss is the man who left her at the altar. Emotional and romantic, with a twist at the end.")
                  : t("A luxury perfume ad: a woman walks through a golden palace, cinematic light, elegant music, French voiceover.")
              }
              className="mt-1.5 w-full resize-none rounded-2xl bg-white/[0.04] px-4 py-3 text-[15px] text-zinc-100 ring-1 ring-inset ring-white/10 placeholder:text-zinc-500 focus:outline-none focus:ring-primary/60 light:bg-black/[0.03]"
            />
          </label>

          <div>
            <span className="text-sm font-medium text-zinc-200">{t("Shape")}</span>
            <div className="mt-1.5 grid grid-cols-1 gap-2 sm:grid-cols-3">
              {SHAPES.map(([id, label, about]) => (
                <button key={id} type="button" onClick={() => setShape(id)} className={chip(shape === id)} aria-pressed={shape === id}>
                  <span className="block font-medium">{t(label)}</span>
                  <span className="block text-xs text-zinc-400">{t(about)}</span>
                </button>
              ))}
            </div>
          </div>

          {mode === "ad" ? (
            <>
          <div className="flex flex-wrap gap-5">
            <div>
              <span className="text-sm font-medium text-zinc-200">{t("Length")}</span>
              <div className="mt-1.5 flex gap-2">
                {AD_LENGTHS.map((s) => (
                  <button key={s} type="button" onClick={() => setSeconds(s)} className={chip(seconds === s)} aria-pressed={seconds === s}>
                    {t("{seconds} s", { seconds: s })}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <span className="text-sm font-medium text-zinc-200">{t("Sound")}</span>
              <div className="mt-1.5 flex gap-2">
                <button type="button" onClick={() => setVoice(!voice)} className={chip(voice)} aria-pressed={voice}>
                  {t("Voiceover")}
                </button>
                <button type="button" onClick={() => setMusic(!music)} className={chip(music)} aria-pressed={music}>
                  {t("Music")}
                </button>
              </div>
            </div>
          </div>

          <div>
            <span className="text-sm font-medium text-zinc-200">{t("Product photo (optional)")}</span>
            <p className="text-xs text-zinc-500">{t("Flash puts your real product into every scene.")}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => photoRef.current?.click()} className={chip(Boolean(photo))}>
                {photo ? photo.name : t("Add a photo")}
              </button>
              {photo && (
                <button type="button" onClick={() => setPhoto(null)} className="text-xs text-zinc-400 hover:text-zinc-100">
                  {t("Remove")}
                </button>
              )}
              <input
                ref={photoRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => {
                  setPhoto(e.target.files?.[0] ?? null);
                  e.target.value = "";
                }}
              />
            </div>
          </div>

          <div className="space-y-2 rounded-2xl bg-white/[0.03] p-4 ring-1 ring-inset ring-white/10 light:bg-black/[0.02] light:ring-black/10">
            <button
              type="button"
              disabled={!ready}
              onClick={() => make(true)}
              className="flex w-full items-center justify-between gap-3 rounded-xl bg-white px-4 py-3 text-left text-zinc-950 transition hover:brightness-95 disabled:opacity-50"
            >
              <span>
                <span className="block font-semibold">{t("Preview the storyboard first")}</span>
                <span className="block text-xs text-zinc-600">{t("The script and a picture of every scene. Then film it in HD.")}</span>
              </span>
              <span className="shrink-0 text-sm font-medium">{t("up to {credits} credits", { credits: boardCredits.toLocaleString() })}</span>
            </button>
            <button
              type="button"
              disabled={!ready}
              onClick={() => make(false)}
              className="flex w-full items-center justify-between gap-3 rounded-xl px-4 py-3 text-left ring-1 ring-inset ring-white/15 transition hover:bg-white/[0.04] disabled:opacity-50 light:ring-black/15"
            >
              <span>
                <span className="block font-semibold">{t("Make the whole ad now")}</span>
                <span className="block text-xs text-zinc-400">{t("Filmed in HD (1080p). Takes three to eight minutes.")}</span>
              </span>
              <span className="shrink-0 text-sm font-medium">{t("up to {credits} credits", { credits: wholeCredits.toLocaleString() })}</span>
            </button>
            <p className="pt-1 text-xs leading-relaxed text-zinc-500">{t("The most it can cost is set aside first. You only pay for what is made.")}</p>
          </div>
            </>
          ) : (
            <>
          <div>
            <span className="text-sm font-medium text-zinc-200">{t("Length of each part")}</span>
            <div className="mt-1.5 flex gap-2">
              {STORY_LENGTHS.map((s) => (
                <button key={s} type="button" onClick={() => setPartSeconds(s)} className={chip(partSeconds === s)} aria-pressed={partSeconds === s}>
                  {t("{seconds} s", { seconds: s })}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-zinc-500">
              {t("Flash writes the story and the dialogue, creates the characters, and keeps the same faces in every scene and every part.")}
            </p>
          </div>

          <div className="space-y-2 rounded-2xl bg-white/[0.03] p-4 ring-1 ring-inset ring-white/10 light:bg-black/[0.02] light:ring-black/10">
            <button
              type="button"
              disabled={!ready}
              onClick={() => void writeStory()}
              className="flex w-full items-center justify-between gap-3 rounded-xl bg-white px-4 py-3 text-left text-zinc-950 transition hover:brightness-95 disabled:opacity-50"
            >
              <span>
                <span className="block font-semibold">{t("Write Part 1 and meet the cast")}</span>
                <span className="block text-xs text-zinc-600">{t("The script with its dialogue, each character and each scene's picture. Then film it in HD.")}</span>
              </span>
              <span className="shrink-0 text-sm font-medium">{t("up to {credits} credits", { credits: storyCredits.toLocaleString() })}</span>
            </button>
            <p className="pt-1 text-xs leading-relaxed text-zinc-500">
              {t("Filming the part with the characters speaking: up to {credits} credits more. The most it can cost is set aside first. You only pay for what is made.", {
                credits: filmCredits.toLocaleString(),
              })}
            </p>
          </div>
            </>
          )}

          <p className="text-xs leading-relaxed text-zinc-500">
            {t("Coming next: subtitles and your logo, and redoing one scene.")}
          </p>
        </div>
      </div>
    </div>
  );
}
