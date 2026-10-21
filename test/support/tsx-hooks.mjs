/*
 * Lets a test render Flash's components (src/components/*.tsx) with react-dom/server: "@/" is src/,
 * an "@/" or "./" import is found with or without the file's extension as the components write it,
 * and a .tsx file is turned into JavaScript by TypeScript, with React's JSX as Next uses it.
 * Registered by the test itself:
 *   register("./support/tsx-hooks.mjs", import.meta.url)
 */
import { readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SRC = new URL("../../src/", import.meta.url).href;

const isFile = (url) => {
  try {
    return statSync(fileURLToPath(url)).isFile();
  } catch {
    return false;
  }
};

export async function resolve(specifier, context, next) {
  const fromSrc = specifier.startsWith(".") && context.parentURL?.startsWith(SRC);
  if (!specifier.startsWith("@/") && !fromSrc) return next(specifier, context);
  const url = fromSrc ? new URL(specifier, context.parentURL).href : SRC + specifier.slice(2);
  return next([url, `${url}.ts`, `${url}.tsx`].find(isFile) ?? url, context);
}

export async function load(url, context, next) {
  if (!url.startsWith("file:") || !url.endsWith(".tsx")) return next(url, context);
  const file = fileURLToPath(url);
  const { outputText } = ts.transpileModule(await readFile(file, "utf8"), {
    fileName: file,
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return { format: "module", source: outputText, shortCircuit: true };
}
