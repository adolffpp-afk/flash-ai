import { animateSeconds, videoSeconds, wantsSound, type ModelInfo } from "../models.ts";

/** Builds the fal.ai input for a model from the user's request. */
export function falInput(model: ModelInfo, prompt: string, request: string): Record<string, unknown> {
  switch (model.id) {
    case "flux-2-pro":
      return { prompt, image_size: "landscape_4_3", output_format: "png" };
    case "veo-3.1":
      return { prompt, duration: "8s", aspect_ratio: "16:9", generate_audio: true };
    case "kling-3":
      return { prompt, duration: String(videoSeconds(request)), aspect_ratio: "16:9" };
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
