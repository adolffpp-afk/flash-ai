import { videoSeconds, type ModelInfo } from "../models.ts";

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
