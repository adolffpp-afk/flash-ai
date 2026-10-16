import { test } from "node:test";
import assert from "node:assert/strict";

/*
 * Picking values out of a JSON document as it comes in (server/json-pick.ts, which SEC EDGAR's
 * companyfacts is read with): what it keeps is what JSON.parse finds at the same place, however the
 * document is cut into pieces, and a document that isn't JSON is refused.
 */

const { JsonPicker } = await import("../src/lib/server/json-pick.ts");
type Path = readonly string[];

/** Picks paths out of text sent in pieces of size bytes (all at once by default). */
function pick(text: string | Uint8Array, paths: Path[], size = Infinity) {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
  const picker = new JsonPicker(paths, (value) => value);
  const step = Math.min(size, bytes.length || 1);
  for (let at = 0; at < bytes.length; at += step) picker.push(bytes.slice(at, at + step));
  return picker.end();
}

/** What JSON.parse finds at a path: an object or a list, else undefined. */
function parsedAt(text: string, path: Path): unknown {
  let value: unknown = JSON.parse(text);
  for (const key of path) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value && typeof value === "object" ? value : undefined;
}

// A small random JSON writer, seeded, so a failure is the same every run.
let seed = 1;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const WORDS = ["Revenues", "us-gaap", "facts", "a", "", 'q"uote', "back\\slash", "é", "中文", "😀", "{", "]", "tab\there", "line\nbreak", "\u0000", "\u2028"];
function value(depth: number): unknown {
  const r = rand();
  if (depth > 4 || r < 0.3) {
    const kinds = [() => WORDS[Math.floor(rand() * WORDS.length)], () => Math.round((rand() - 0.5) * 1e6) / 100, () => -1.5e21, () => true, () => false, () => null, () => 0];
    return kinds[Math.floor(rand() * kinds.length)]();
  }
  const n = Math.floor(rand() * 5);
  if (r < 0.55) return Array.from({ length: n }, () => value(depth + 1));
  return Object.fromEntries(Array.from({ length: n }, () => [WORDS[Math.floor(rand() * WORDS.length)], value(depth + 1)]));
}
/** Writes JSON with spaces and line breaks in the places JSON allows them, and \u escapes for some characters. */
const spaced = (text: string) =>
  text.replace(/("(?:[^"\\]|\\.)*")|([{}[\],:])/g, (_m, str: string | undefined, punct: string | undefined) =>
    str ? str.replace(/é/g, "\\u00e9").replace(/😀/g, "\\ud83d\\ude00") : ` ${punct}\n\t`,
  );

test("what's picked is what JSON.parse finds there, in pieces of any size, with escapes, other scripts and spaces anywhere", () => {
  let compared = 0;
  let found = 0;
  for (let doc = 0; doc < 300; doc++) {
    const root = { facts: { "us-gaap": { Revenues: value(1), a: value(1), "é": value(2) }, "": value(1) }, other: value(0), [WORDS[doc % WORDS.length]]: value(1) };
    for (const text of [JSON.stringify(root), spaced(JSON.stringify(root)), JSON.stringify(root, null, 2)]) {
      assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(root)), "the document is JSON");
      const paths: Path[] = [["facts", "us-gaap", "Revenues"], ["facts", "us-gaap", "a"], ["facts", "us-gaap", "é"], ["facts", ""], ["other"], ["facts", "missing"], [WORDS[doc % WORDS.length]]];
      // Paths may not be inside one another, so each is picked on its own.
      for (const path of paths) {
        const want = parsedAt(text, path);
        if (want !== undefined) found++;
        for (const size of [1, 2, 3, 7, 64, Infinity]) {
          assert.deepEqual(pick(text, [path], size)[0], want, `${JSON.stringify(path)} in pieces of ${size}: ${text.slice(0, 200)}`);
          compared++;
        }
      }
    }
  }
  assert.ok(compared > 30_000 && found > 1000, `${compared} compared, ${found} paths with an object or a list`);
});

test("several paths at once, a key written with escapes, the last of a repeated key, and what isn't an object or a list", () => {
  const text = '{"facts":{"us\\u002dgaap":{"Net\\u0049ncomeLoss":{"units":{"USD":[1,2]}},"Revenues":{"v":1},"Revenues":{"v":2},"Assets":7,"Equity":"x"},"dei":{"Shares":[3]}}}';
  const paths: Path[] = [["facts", "us-gaap", "NetIncomeLoss"], ["facts", "us-gaap", "Revenues"], ["facts", "us-gaap", "Assets"], ["facts", "us-gaap", "Equity"], ["facts", "dei", "Shares"], ["facts", "us-gaap", "Missing"]];
  for (const size of [1, 5, Infinity]) {
    assert.deepEqual(pick(text, paths, size), [{ units: { USD: [1, 2] } }, { v: 2 }, undefined, undefined, [3], undefined]);
  }
  // A value at a path inside a list isn't at that path.
  assert.deepEqual(pick('{"facts":[{"us-gaap":{"Revenues":{}}}]}', [["facts", "us-gaap", "Revenues"]]), [undefined]);
  // keep makes what's kept, with the path's index.
  const picker = new JsonPicker([["b"], ["a"]], (v, i) => `${i}:${JSON.stringify(v)}`);
  picker.push(new TextEncoder().encode('{"a":[1],"b":{}}'));
  assert.deepEqual(picker.end(), ["0:{}", "1:[1]"]);
});

test("a character of another script cut between two pieces is read whole", () => {
  const text = JSON.stringify({ facts: { "us-gaap": { "Revenus€": { label: "中文 😀 é", v: [1] } } } });
  const bytes = new TextEncoder().encode(text);
  for (let cut = 1; cut < bytes.length; cut++) {
    const picker = new JsonPicker([["facts", "us-gaap", "Revenus€"]], (v) => v);
    picker.push(bytes.slice(0, cut));
    picker.push(bytes.slice(cut));
    assert.deepEqual(picker.end(), [{ label: "中文 😀 é", v: [1] }], `cut at ${cut}`);
  }
});

test("a document that isn't JSON is refused", () => {
  const broken = [
    "",
    "   ",
    '{"a":1',
    '{"a" 1}',
    '{"a":1}}',
    '{"a":1} x',
    '{"a":1}{"b":2}',
    "[1,]",
    '{"a":1,}',
    '{"a":[1}',
    '{"a":{1:2}}',
    '"unterminated',
    '{"a":"b"c}',
    "{,}",
    '{"a"::1}',
    "[1 2]",
    '{"facts":{"us-gaap":{"Revenues":{"v":1,}}}}',
  ];
  for (const text of broken) {
    assert.throws(() => JSON.parse(text), SyntaxError, `JSON.parse refuses ${text}`);
    assert.throws(() => pick(text, [["facts", "us-gaap", "Revenues"], ["a"]]), SyntaxError, text);
  }
  // A key with a broken escape, where a path reaches, is refused too.
  assert.throws(() => pick('{"fa\\xcts":{}}', [["facts", "x"]]), SyntaxError);
  // Values on their own are documents too.
  assert.deepEqual(pick("[1, 2]", [["a"]]), [undefined]);
  assert.deepEqual(pick(" 12 ", [["a"]]), [undefined]);
});
