/*
 * Loads Flash with assistants on, for a test of what their routes do once they are (see
 * assistants-api.test.ts): src/lib/assistants.ts as written, with ASSISTANTS_ON true. Fails to load
 * it if that line isn't there, so the switch can't move without the test knowing. Registered by the
 * test itself:
 *   register("./support/assistants-on.mjs", import.meta.url)
 * Nothing else is changed, and the code as shipped keeps the switch off (assistants-api-off.test.ts).
 */
const SWITCH = new URL("../../src/lib/assistants.ts", import.meta.url).href;
const OFF = "export const ASSISTANTS_ON = false;";

export async function load(url, context, next) {
  const loaded = await next(url, context);
  if (url.split("?")[0] !== SWITCH) return loaded;
  const source = String(loaded.source);
  if (!source.includes(OFF)) throw new Error(`assistants.ts no longer says "${OFF}"`);
  return { ...loaded, source: source.replace(OFF, "export const ASSISTANTS_ON = true;"), shortCircuit: true };
}
