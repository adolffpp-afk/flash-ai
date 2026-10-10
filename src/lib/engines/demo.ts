import { english, type Translate } from "../i18n.ts";
import { ENGINE_LABELS, type Engine, type StreamEvent } from "../types.ts";

/**
 * The reply for an engine whose AI provider isn't set up yet. It is free, says so plainly and
 * shows nothing made up. Engines switch on by themselves once their key is added.
 */
export async function* unavailableReply(engine: Engine, t: Translate = english): AsyncGenerator<StreamEvent> {
  yield {
    type: "text",
    delta:
      engine === "transcribe"
        ? t("Transcribing audio and video isn't available yet. It's coming soon, and nothing was charged.")
        : t("{engine} isn't available yet. It's coming soon, and nothing was charged.", { engine: t(ENGINE_LABELS[engine]) }),
  };
}
