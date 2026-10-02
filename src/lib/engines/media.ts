export const IMAGE_MODEL = process.env.FLASH_IMAGE_MODEL || "gpt-image-1";
export const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
export const VOICE_MODEL = process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2";

export const imageConfigured = () => Boolean(process.env.OPENAI_API_KEY);
export const voiceConfigured = () => Boolean(process.env.ELEVENLABS_API_KEY);

async function failure(res: Response, service: string): Promise<Error> {
  const body = await res.text().catch(() => "");
  return new Error(`${service} returned ${res.status}: ${body.slice(0, 300)}`);
}

/** Generates one image with OpenAI and returns it as a data URL. */
export async function generateImage(prompt: string): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: IMAGE_MODEL, prompt, size: "1024x1024", n: 1 }),
  });
  if (!res.ok) throw await failure(res, "The image service");
  const json = (await res.json()) as { data?: { b64_json?: string; url?: string }[] };
  const item = json.data?.[0];
  if (item?.b64_json) return `data:image/png;base64,${item.b64_json}`;
  if (item?.url) return item.url;
  throw new Error("The image service returned no image.");
}

/** Speaks the text with ElevenLabs and returns an MP3 data URL. */
export async function synthesizeSpeech(text: string): Promise<string> {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
      "xi-api-key": process.env.ELEVENLABS_API_KEY ?? "",
    },
    body: JSON.stringify({ text: text.slice(0, 5000), model_id: VOICE_MODEL }),
  });
  if (!res.ok) throw await failure(res, "The voice service");
  const audio = Buffer.from(await res.arrayBuffer()).toString("base64");
  return `data:audio/mpeg;base64,${audio}`;
}
