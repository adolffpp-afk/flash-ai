import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

// Each pattern that reads a message, run on its own on 100,000-character messages built to make a
// careless pattern retry from every position. The checks read a window of a long message (see
// message-window.ts and test/hostile-input.test.ts), so a slow pattern would only show here: one whose
// work grows with the square of what it reads takes seconds on these, a linear one a few
// milliseconds.
const N = 100_000;
const LIMIT_MS = 250;

// The files whose patterns read the user's message before anything is charged.
const FILES = [
  "src/lib/router.ts",
  "src/lib/weather-words.ts",
  "src/lib/research-words.ts",
  "src/lib/schedule-words.ts",
  "src/lib/research.ts",
  "src/lib/free-order.ts",
  "src/lib/weather.ts",
  "src/lib/context-note.ts",
  "src/lib/levels.ts",
  "src/lib/models.ts",
  "src/lib/voices.ts",
  "src/lib/engines/fal-input.ts",
  "src/lib/seo-scan.ts",
  "src/lib/seo-rules.ts",
  "src/app/api/chat/route.ts",
];
const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
// Patterns that never see more than a few hundred characters, and why.
const BOUNDED = new Map([
  [String.raw`[^.!?\n]+\?$`, "reads the last 300 characters of Flash's own reply (offered, in the chat route)"],
]);

// The patterns written out in the source.
const patterns = new Map<string, { source: string; flags: string; where: string }>();
const keep = (source: string, flags: string, where: string) => {
  const plain = flags.replace(/[gy]/g, "");
  if (!BOUNDED.has(source) && !patterns.has(`${plain}/${source}`)) patterns.set(`${plain}/${source}`, { source, flags: plain, where });
};
for (const file of FILES) {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node) => {
    if (ts.isRegularExpressionLiteral(node)) {
      const text = node.getText(source);
      const end = text.lastIndexOf("/");
      keep(text.slice(1, end), text.slice(end + 1), `${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}
// The patterns built from pieces when the modules load (the chat route can't load in a test; its
// patterns are all written out).
const Real = RegExp;
globalThis.RegExp = new Proxy(Real, {
  construct(target, args, newTarget) {
    const made = Reflect.construct(target, args, newTarget) as RegExp;
    const from = new Error().stack?.match(/(src\/lib\/[\w/.-]+\.ts):(\d+)/);
    if (from && FILES.includes(from[1])) keep(made.source, made.flags, `${from[1]}:${from[2]}`);
    return made;
  },
});
try {
  const { route, pictureFollowUp } = await import("../src/lib/router.ts");
  const { pickVoice } = await import("../src/lib/voices.ts");
  await import("../src/lib/weather-words.ts");
  await import("../src/lib/research-words.ts");
  // The schedule words' patterns are built when a message could match them (their quick checks are
  // plain strings, see test/schedule-words.test.ts), so they're read here as written.
  const { SCHEDULE_PATTERNS } = await import("../src/lib/schedule-words.ts");
  SCHEDULE_PATTERNS.forEach(({ source, flags }, n) => keep(source, flags, `src/lib/schedule-words.ts pattern ${n + 1}`));
  await import("../src/lib/research.ts");
  await import("../src/lib/free-order.ts");
  await import("../src/lib/weather.ts");
  await import("../src/lib/context-note.ts");
  await import("../src/lib/levels.ts");
  await import("../src/lib/models.ts");
  await import("../src/lib/engines/fal-input.ts");
  await import("../src/lib/seo-scan.ts");
  await import("../src/lib/seo-rules.ts");
  // And the ones built for each message.
  route("Read this in a deep British voice: hello", undefined, "app", { spoken: true });
  pictureFollowUp("make it darker");
  pickVoice("say hello in Ava's calm voice");
} finally {
  globalThis.RegExp = Real;
}

// Messages from the tests, which the patterns are written to match, so a long run can follow an
// opening a pattern accepts ("how much is a dollar in naira" and 99,000 spaces).
const examples: string[] = [];
for (const file of ["test/router.test.ts", "test/weather-words.test.ts", "test/research-words.test.ts", "test/schedule-words.test.ts", "test/classify.test.ts", "test/picture-edits.test.ts", "test/photo-edit.test.ts", "test/post-pack.test.ts", "test/levels.test.ts", "test/free-order.test.ts", "test/voices.test.ts"]) {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node) => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text.length >= 3 && node.text.length <= 200 && /\s/.test(node.text)) examples.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
}
// And the schedule-words samples, in all 30 languages.
for (const { asks, not } of Object.values(JSON.parse(read("test/fixtures/schedule-words.json")) as Record<string, { asks: string[]; not: string[] }>)) {
  examples.push(...[...asks, ...not].filter((s) => s.length >= 3 && s.length <= 200));
}

const fill = (start: string, unit: string, end: string) =>
  start + unit.repeat(Math.ceil((N - start.length - end.length) / unit.length)).slice(0, N - start.length - end.length) + end;

const RUNS = [" ", "\t", "\n", "a", "A", "1", "1 ", "1.", "?", "!", ".", ",", "'", '"', "“", ":", "-", "é", "天", "😀", "a ", "Aa ", "a, ", "°"];
const ENDS = ["", "x"];

function inputsFor(pattern: RegExp): string[] {
  const inputs: string[] = [];
  for (const unit of RUNS) for (const end of ENDS) inputs.push(fill("", unit, end));
  // The pattern's own words, repeated as written, capitalised and in a list.
  const text = pattern.source.replace(/\\[pP]\{[^}]*\}|\\u\{?[0-9a-fA-F]+\}?|\\x[0-9a-fA-F]{2}|\\[a-zA-Z]/g, " ");
  const words = new Set<string>();
  for (const word of text.match(/[\p{L}\p{M}][\p{L}\p{M}'’-]*/gu) ?? []) if (word.length >= 2) words.add(word);
  for (const piece of text.split(/[|()[\]{}?*+^$]/)) {
    const phrase = piece.replace(/\\/g, "").trim();
    if (phrase.includes(" ") && phrase.length <= 40 && /^[\p{L}\p{M}' .,-]+$/u.test(phrase)) words.add(phrase);
  }
  for (const word of [...words].slice(0, 60)) inputs.push(fill("", `${word} ${word[0].toUpperCase()}${word.slice(1)}, `, "x"));
  // Openings it accepts, from the tests, then a long run.
  let openings = 0;
  for (const example of examples) {
    if (openings >= 3) break;
    const found = pattern.exec(example);
    if (!found) continue;
    openings++;
    const opening = example.slice(0, found.index + found[0].length).replace(/[\s?.!]+$/, "");
    for (const unit of [" ", "\t", "?", ".", "!", "a", ", "]) for (const end of ["x", "?"]) inputs.push(fill(opening + (/\s/.test(unit) ? "" : " "), unit, end));
  }
  return inputs;
}

const time = (f: () => unknown) => {
  const begun = performance.now();
  f();
  return performance.now() - begun;
};

// The shape that made patterns slow three times over: two runs of spaces with only optional
// characters between them ("\s*[?.!]*\s*$"), which a long run of spaces can split in every way. Such
// a pattern only slows once something before it has matched, which the messages below may not
// reach, so the shape itself is refused. Written "\s*(?:[?.!]+\s*)?$", it reads the same messages.
test("no pattern lets two runs of spaces meet", () => {
  assert.ok(patterns.size > 250, `found ${patterns.size} patterns`);
  const meet = /\\s[*+](?:\[(?:[^\]\\]|\\.)*\][*?]|\\.\?|\.\?)*\\s[*+]/;
  const found = [...patterns.values()].filter(({ source }) => meet.test(source)).map(({ where, source }) => `${where}: ${source.match(meet)?.[0]}`);
  assert.deepEqual(found, []);
});

test("every pattern that reads a message stays quick on 100,000-character hostile messages", () => {
  for (const { source, flags, where } of patterns.values()) {
    const pattern = new RegExp(source, flags);
    for (const input of inputsFor(pattern)) {
      let took = time(() => pattern.test(input));
      if (took >= LIMIT_MS) took = Math.min(took, time(() => pattern.test(input)), time(() => pattern.test(input)));
      assert.ok(took < LIMIT_MS, `${where} took ${took.toFixed(0)} ms on ${JSON.stringify(input.slice(0, 40))}… (${input.length} characters): /${source.slice(0, 120)}/`);
    }
  }
});
