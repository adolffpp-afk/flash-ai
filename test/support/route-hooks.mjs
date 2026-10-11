/*
 * Lets a test load Flash's route handlers (src/app/api/...) as Node loads the rest of Flash: "@/" is
 * src/, and next/server is a stand-in (see next-server.mjs). Registered by the test itself:
 *   register("./support/route-hooks.mjs", import.meta.url)
 */
const SRC = new URL("../../src/", import.meta.url).href;
const NEXT_SERVER = new URL("./next-server.mjs", import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === "next/server") return { url: NEXT_SERVER, shortCircuit: true };
  if (specifier.startsWith("@/")) return next(SRC + specifier.slice(2), context);
  return next(specifier, context);
}
