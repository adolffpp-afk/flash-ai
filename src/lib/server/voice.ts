import { charge, ensureMonthlyCredits, logUsage, settle } from "./credits.ts";
import { freeAudioFailed, recordFreeAudio, releaseFreeUser, reserveFreeAudio, reserveFreeUser } from "./free.ts";
import { audioLength, billableSeconds } from "./audio-length.ts";
import { MIN_AUDIO_SECONDS, freeHear, freeTranscribeConfigured } from "../engines/free.ts";
import { overLimit } from "./limits.ts";
import { NO_SPEECH, speechProvider, transcribe } from "../engines/media.ts";
import { JobAbandoned } from "../engines/errors.ts";
import { creditsFor, transcribeCostCents } from "../credits.ts";
import { english, type Translate } from "../i18n.ts";
import { heardWords } from "../voice-chat.ts";

// One spoken turn: 30 seconds of speech at the browser's recording rate is well under this.
export const MAX_HEAR_BYTES = 1_000_000;
// The voice panel waits up to 12 seconds for words and stops a turn after 30 seconds of talking, so
// a turn plays for at most about 45 seconds.
export const MAX_HEAR_SECONDS = 50;
const AUDIO = /^audio\/(?:webm|ogg|mp4|mpeg|wav|x-wav|aac)$/;

type Reply = { status: number; body: Record<string, unknown> };
/** Said when a recording is too big to hear in one turn. */
export const tooLongToHear = (t: Translate = english): Reply => ({
  status: 413,
  body: { error: t("That was too long to hear in one go. Say it in shorter parts.") },
});

/**
 * Voice conversations in browsers that can't understand speech themselves (Firefox): one recorded
 * turn in, its words out. Priced like Transcribe, on the recording's real length (see
 * audio-length.ts), so only what Flash can measure is heard: Opus in Ogg or WebM, as the voice
 * panel records, or WAV, up to MAX_HEAR_SECONDS. A failed turn is free. Out of credits, a verified
 * user's turn is heard for free while today's free turns last. signal ends a turn still waiting in
 * line when the browser stops waiting. t gives the errors in the user's language.
 */
export async function hearTurn(
  userId: string,
  contentType: string,
  data: Buffer,
  { verified = false, signal }: { verified?: boolean; signal?: AbortSignal } = {},
  t: Translate = english,
): Promise<Reply> {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (!AUDIO.test(type)) return { status: 415, body: { error: t("Send the recording as audio.") } };
  if (data.length > MAX_HEAR_BYTES) return tooLongToHear(t);
  if (!data.length) return { status: 200, body: { text: "" } };
  const provider = speechProvider();
  if (!provider) {
    return { status: 503, body: { error: t("Talking with Flash isn't available in this browser yet. Try Chrome, Edge or Safari.") } };
  }
  // A recording Flash can't measure could hold any amount of audio, so it isn't heard at all.
  const length = audioLength(data);
  if (!length) {
    return { status: 415, body: { error: t("Talking with Flash isn't available in this browser yet. Try Chrome, Edge or Safari.") } };
  }
  const seconds = billableSeconds(length);
  if (seconds > MAX_HEAR_SECONDS) return tooLongToHear(t);
  // A turn every 15 seconds for ten minutes is already fast talking.
  if (await overLimit(`hear:${userId}`, 40, 10 * 60_000)) {
    return { status: 429, body: { error: t("That's a lot of talking at once. Take a short break and try again.") } };
  }

  await ensureMonthlyCredits(userId);
  const cents = transcribeCostCents(data.length, seconds);
  const credits = creditsFor(cents);
  const chargeId = await charge(userId, credits, "Voice conversation");
  // Out of credits: Whisper on Groq's free tier hears the turn, which costs Flash nothing.
  if (chargeId === null && verified && freeTranscribeConfigured()) {
    const free = await hearFree(userId, type, data, seconds, t);
    if (free) return free;
  }
  if (chargeId === null) {
    return {
      status: 402,
      body: {
        error: t(
          "Hearing you in this browser uses {credits} credits a turn and you're out of credits. Get more credits, or talk to Flash in Chrome, Edge or Safari, where listening is free.",
          { credits },
        ),
        code: "out_of_credits",
      },
    };
  }

  const ext = type === "audio/mp4" ? "m4a" : type.split("/")[1].replace("x-", "");
  let text = "";
  let ok = true;
  // A job the provider never started costs nothing, so neither does the turn.
  let billed = true;
  try {
    text = await transcribe({ name: `turn.${ext}`, mediaType: type, data: data.toString("base64") }, { turn: true, signal });
    // A cough or the room is no request: "(coughs)" isn't sent to the chat.
    text = text === NO_SPEECH ? "" : heardWords(text);
  } catch (err) {
    ok = false;
    billed = err instanceof JobAbandoned && err.billed;
    console.error("[flash] voice turn failed", err);
  }
  const used = ok || billed ? credits : 0;
  await settle(chargeId, used);
  await logUsage({ userId, engine: "transcribe", model: "voice conversation", provider, credits: used, costCents: used ? cents : 0, ok }).catch((err) =>
    console.error("[flash] usage log failed", err),
  );
  if (!ok) return { status: 502, body: { error: t("Flash couldn't hear that just now. Please say it again.") } };
  return { status: 200, body: { text, credits } };
}

/**
 * A turn heard for free, or null when the user's (or Flash's) free turns for today are used up. Its
 * measured seconds come off Groq's daily audio allowance before it's sent, so nobody can spend the
 * free audio every user shares with a recording longer than it looks.
 */
async function hearFree(userId: string, type: string, data: Buffer, seconds: number, t: Translate): Promise<Reply | null> {
  // Groq counts every request as at least 10 seconds.
  const reserve = Math.max(MIN_AUDIO_SECONDS, Math.ceil(seconds));
  if (!(await reserveFreeUser(userId, "voice"))) return null;
  if (!(await reserveFreeAudio(reserve))) {
    await releaseFreeUser(userId, "voice");
    return null;
  }
  const ext = type === "audio/mp4" ? "m4a" : type.split("/")[1].replace("x-", "");
  try {
    const { text, seconds: counted } = await freeHear({ name: `turn.${ext}`, mediaType: type, data: data.toString("base64") });
    await recordFreeAudio(counted, reserve);
    await logUsage({ userId, engine: "transcribe", model: "voice conversation (free)", provider: "groq", credits: 0, costCents: 0, ok: true }).catch(() => {});
    return { status: 200, body: { text: heardWords(text), credits: 0, free: true } };
  } catch (err) {
    console.error("[flash] free voice turn failed", err);
    await freeAudioFailed(userId, "voice", reserve, err).catch((e) => console.error("[flash] free release failed", e));
    return { status: 502, body: { error: t("Flash couldn't hear that just now. Please say it again.") } };
  }
}
