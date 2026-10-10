/*
 * Finds every phrase Flash shows through t("…"), t.node("…"), tNow("…") or msg("…") (see
 * src/lib/i18n.ts): the keys of each language's table in src/lib/i18n. test/i18n.test.ts checks the
 * tables against them. To list them:
 *   node --experimental-strip-types scripts/i18n-keys.ts > keys.json
 */
import ts from "typescript";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const CALLS = new Set(["t", "tNow", "msg"]);

export type Phrases = {
  // Each phrase, with the files it's in.
  phrases: Map<string, Set<string>>;
  // Calls whose words are worked out while Flash runs (file:line), translated only if marked msg() where written.
  dynamic: string[];
  // Calls with ${…} inside the phrase (file:line): these can't be translated, and must use {blanks}.
  joined: string[];
};

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "i18n" ? [] : files(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

/** Whether a call is t(…), tNow(…), msg(…) or t.node(…). */
function isPhraseCall(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return CALLS.has(callee.text);
  return ts.isPropertyAccessExpression(callee) && callee.name.text === "node" && ts.isIdentifier(callee.expression) && callee.expression.text === "t";
}

/** The phrases an argument can be: a quoted phrase, or either side of a ?: or ?? between quoted phrases. */
function literals(node: ts.Expression): string[] | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isParenthesizedExpression(node)) return literals(node.expression);
  if (ts.isConditionalExpression(node)) {
    const a = literals(node.whenTrue);
    const b = literals(node.whenFalse);
    return a && b ? [...a, ...b] : null;
  }
  return null;
}

/** The phrases in Flash's source under root (the project folder). */
export function findPhrases(root: string): Phrases {
  const found: Phrases = { phrases: new Map(), dynamic: [], joined: [] };
  for (const path of files(join(root, "src"))) {
    const text = readFileSync(path, "utf8");
    if (!/\b(?:t|tNow|msg)\(|\bt\.node\(/.test(text)) continue;
    const file = relative(root, path);
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const where = (node: ts.Node) => `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && isPhraseCall(node) && node.arguments.length) {
        const arg = node.arguments[0];
        const words = literals(arg);
        if (words) {
          for (const phrase of words) {
            if (!found.phrases.has(phrase)) found.phrases.set(phrase, new Set());
            found.phrases.get(phrase)!.add(file);
          }
        } else if (ts.isTemplateExpression(arg)) found.joined.push(where(node));
        else found.dynamic.push(where(node));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

/** The keys every table may have, sorted. */
export const phraseKeys = (root: string) => [...findPhrases(root).phrases.keys()].sort();

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
  const { phrases, dynamic, joined } = findPhrases(root);
  process.stdout.write(`${JSON.stringify([...phrases.keys()].sort(), null, 1)}\n`);
  process.stderr.write(`${phrases.size} phrases, ${dynamic.length} worked-out calls, ${joined.length} with \${…}\n`);
  for (const line of joined) process.stderr.write(`  \${…} in ${line}\n`);
}
