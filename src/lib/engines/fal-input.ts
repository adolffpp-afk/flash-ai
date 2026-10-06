import { PACK_VIDEO_SECONDS, animateSeconds, videoSeconds, wantsSound, type ModelInfo } from "../models.ts";

export type Shape = "tall" | "portrait" | "square" | "wide";

/** The shape a request asks for (a phone story, a square post, a wide banner), or null for the usual 4:3 or 16:9. */
export function shapeOf(request: string): Shape | null {
  // A ratio said outright wins over words like "poster" or "logo" in the description.
  const ratio = request.match(/\b(9 ?[:x/] ?16|3 ?[:x/] ?4|4 ?[:x/] ?5|1 ?[:x/] ?1|16 ?[:x/] ?9)\b/)?.[1].replace(/\D+/, ":");
  if (ratio) return ({ "9:16": "tall", "3:4": "portrait", "4:5": "portrait", "1:1": "square", "16:9": "wide" } as const)[ratio] ?? null;
  if (/\b(9 ?[:x/] ?16|vertical|(instagram|insta|ig|facebook|whatsapp|snapchat) stor(y|ies)|stor(y|ies) (format|size)|reels?|tik ?tok|youtube shorts|phone (wallpaper|screen|background)|lock ?screen)\b/i.test(request)) return "tall";
  if (/\b(3 ?[:x/] ?4|4 ?[:x/] ?5|portrait (format|mode|orientation)|poster|flyer|pinterest|book cover)\b/i.test(request)) return "portrait";
  if (/\b(1 ?[:x/] ?1|square|profile (picture|photo|pic)|avatar|instagram post|album cover|logo|icon)\b/i.test(request)) return "square";
  if (/\b(16 ?[:x/] ?9|widescreen|wide (format|shot|image|picture|photo|banner)|panoram\w*|banner|header|thumbnail|cover photo|desktop (wallpaper|background)|landscape (format|mode|orientation))\b/i.test(request)) return "wide";
  return null;
}

// Every size stays under one megapixel, so a picture costs the same 3 cents whatever its shape.
const IMAGE_SIZES: Record<Shape, { width: number; height: number }> = {
  tall: { width: 720, height: 1280 },
  portrait: { width: 768, height: 1024 },
  square: { width: 992, height: 992 },
  wide: { width: 1280, height: 720 },
};

/** A social post pack's picture in one of its shapes: square for feeds, tall for TikTok, Reels and Stories. */
export const packImageInput = (prompt: string, shape: "square" | "tall") => ({ prompt, image_size: IMAGE_SIZES[shape], output_format: "png" });

/** A post pack's short silent video, made from its tall picture so the two match. */
export const packVideoInput = (imageUrl: string, motion: string) => ({
  start_image_url: imageUrl,
  prompt: motion.slice(0, 2500) || "Gentle, natural motion with a slow camera push in.",
  duration: String(PACK_VIDEO_SECONDS),
  generate_audio: false,
});

/** The video aspect ratio for a request. Veo makes only wide and tall videos. */
export function videoAspect(request: string, square = true): "16:9" | "9:16" | "1:1" {
  const shape = shapeOf(request);
  if (shape === "tall" || shape === "portrait") return "9:16";
  return shape === "square" && square ? "1:1" : "16:9";
}

/** Builds the fal.ai input for a model from the user's request. */
export function falInput(model: ModelInfo, prompt: string, request: string): Record<string, unknown> {
  switch (model.id) {
    case "flux-2-pro": {
      const shape = shapeOf(request);
      return { prompt, image_size: shape ? IMAGE_SIZES[shape] : "landscape_4_3", output_format: "png" };
    }
    case "veo-3.1":
      return { prompt, duration: "8s", aspect_ratio: videoAspect(request, false), generate_audio: true };
    case "kling-3":
      return { prompt, duration: String(videoSeconds(request)), aspect_ratio: videoAspect(request) };
    case "minimax-music":
      // MiniMax writes the lyrics itself when none are given.
      return { prompt: prompt.slice(0, 2000).padEnd(10, "."), lyrics_optimizer: true };
    default:
      return { prompt };
  }
}

/** The longest side an upscaled photo may have, which keeps its price fixed (see the upscale model). */
export const UPSCALE_MAX_SIDE = 4096;

/**
 * The fal.ai input for an editing model, given the photo (as a URL or data URI), its size and
 * what the user asked.
 */
export function falEditInput(
  model: ModelInfo,
  imageUrl: string,
  size: { width: number; height: number } | null,
  request: string,
): Record<string, unknown> {
  switch (model.id) {
    case "remove-bg":
      return { image_url: imageUrl };
    case "kling-3-animate":
      return {
        start_image_url: imageUrl,
        prompt: request.slice(0, 2500) || "Bring this photo to life with natural, gentle motion.",
        duration: String(animateSeconds(request)),
        generate_audio: wantsSound(request),
      };
    case "upscale": {
      const long = Math.max(size?.width ?? 2048, size?.height ?? 2048);
      const factor = Math.min(4, Math.max(1, Math.floor((UPSCALE_MAX_SIDE / long) * 100) / 100));
      return { image_url: imageUrl, upscale_mode: "factor", upscale_factor: factor, output_format: "jpg" };
    }
    default: {
      // The same size as the photo, within the 512 to 2048 pixels the model makes.
      let image_size: { width: number; height: number } | undefined;
      if (size) {
        const scale = Math.max(1, 512 / Math.min(size.width, size.height));
        image_size = { width: Math.min(2048, Math.round(size.width * scale)), height: Math.min(2048, Math.round(size.height * scale)) };
      }
      return { prompt: request, image_urls: [imageUrl], image_size, output_format: "png" };
    }
  }
}
