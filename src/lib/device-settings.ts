/*
 * Settings kept on this device (in the browser's storage), like Claude's appearance and voice
 * settings. Storage can be blocked (private windows), so every read falls back to the default.
 */
import { voiceFor } from "./languages.ts";

export const DEVICE_KEYS = {
  // Set when the user says not to ask before costly requests.
  skipCostCheck: "flash:skip-cost-check",
  notifyDone: "flash:notify-done",
  font: "flash:font",
  textSize: "flash:text-size",
  voice: "flash:voice",
  voiceRate: "flash:voice-rate",
  memoryOff: "flash:memory-off",
  hideCompanion: "flash:hide-companion",
  // Listen for "Hey Flash" while Flash is open (Settings > General > Voice).
  wakeWord: "flash:wake-word",
} as const;

export type DeviceKey = keyof typeof DEVICE_KEYS;

export function readSetting(key: DeviceKey): string {
  try {
    return localStorage.getItem(DEVICE_KEYS[key]) ?? "";
  } catch {
    return "";
  }
}

/** Saves a setting; "" removes it, so it goes back to the default. */
export function writeSetting(key: DeviceKey, value: string): void {
  try {
    if (value) localStorage.setItem(DEVICE_KEYS[key], value);
    else localStorage.removeItem(DEVICE_KEYS[key]);
  } catch {}
}

export const FONTS = [
  ["", "Default", "Flash's own typeface"],
  ["system", "System", "Your device's typeface"],
  ["readable", "Readable", "Wide, open letters that are easier to tell apart"],
] as const;
export type Font = (typeof FONTS)[number][0];

export const TEXT_SIZES = [
  ["", "Default"],
  ["large", "Large"],
] as const;

export const VOICE_RATES = [
  ["0.8", "Slower"],
  ["", "Normal"],
  ["1.25", "Faster"],
  ["1.5", "Fastest"],
] as const;

/** Puts the chosen typeface and text size on the page (see globals.css). */
export function applyAppearance(font = readSetting("font"), size = readSetting("textSize")): void {
  const root = document.documentElement;
  if (font) root.dataset.font = font;
  else delete root.dataset.font;
  if (size) root.dataset.size = size;
  else delete root.dataset.size;
}

/**
 * The read-aloud voice and speed picked in Settings > General, for speechSynthesis. With lang (a
 * voice conversation in the language picked in Settings), a voice for that language when the
 * picked one speaks another.
 */
export function readAloudVoice(lang = ""): { voice: SpeechSynthesisVoice | null; rate: number } {
  const uri = readSetting("voice");
  const voices = typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis.getVoices() : [];
  const rate = Number(readSetting("voiceRate")) || 1;
  const picked = (uri && voices.find((v) => v.voiceURI === uri)) || null;
  return { voice: voiceFor(voices, lang, picked), rate: Math.min(2, Math.max(0.5, rate)) };
}

/** Whether to show a notification when a long request finishes while Flash is in the background. */
export const notifiesWhenDone = () =>
  readSetting("notifyDone") === "1" && typeof Notification !== "undefined" && Notification.permission === "granted";
