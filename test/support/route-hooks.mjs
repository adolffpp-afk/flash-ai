/*
 * Lets a test load Flash's route handlers (src/app/api/...) as Node loads the rest of Flash: "@/" is
 * src/, next/server is a stand-in (see next-server.mjs), and a JSON file needs no import attribute.
 * Registered by the test itself:
 *   register("./support/route-hooks.mjs", import.meta.url)
 */
const SRC = new URL("../../src/", import.meta.url).href;
const NEXT_SERVER = new URL("./next-server.mjs", import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === "next/server") return { url: NEXT_SERVER, shortCircuit: true };
  if (specifier.startsWith("@/")) return next(SRC + specifier.slice(2), context);
  // The language tables (i18n-tables.ts) are imported as the bundler imports JSON, with no attribute.
  if (specifier.endsWith(".json") && !context.importAttributes?.type) {
    const importAttributes = { ...context.importAttributes, type: "json" };
    return { ...(await next(specifier, { ...context, importAttributes })), importAttributes };
  }
  return next(specifier, context);
}
