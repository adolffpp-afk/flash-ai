/*
 * Values picked out of a JSON document as it comes in, without parsing the rest. SEC EDGAR's
 * companyfacts runs to tens of megabytes, of which a reply needs a few tags: parsed whole, it would
 * hold the text and several times its size in objects at once. Here each byte is read once, as it
 * arrives, and only the bytes of the values asked for are kept, then parsed. JSON's structure is all
 * ASCII, and no byte of a UTF-8 character outside ASCII is, so the bytes are read undecoded.
 */

/** Where a value is: the keys of the objects that hold it, from the top, like ["facts", "us-gaap", "Revenues"]. */
export type JsonPath = readonly string[];

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OBJECT = 0x7b;
const OBJECT_END = 0x7d;
const ARRAY = 0x5b;
const ARRAY_END = 0x5d;
const COLON = 0x3a;
const COMMA = 0x2c;

// What may come next: a value, a value or the list's end (after "["), a key or the object's end (after
// "{"), a key (after a comma in an object), the colon after a key, a comma or the end after a value,
// or nothing (the document's value is over).
const VALUE = 0;
const FIRST_VALUE = 1;
const FIRST_KEY = 2;
const KEY = 3;
const AFTER_KEY = 4;
const AFTER_VALUE = 5;
const DONE = 6;

const space = (b: number) => b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09;
// What a number, true, false or null is written with (checked by JSON.parse where it's kept).
const literal = (b: number) => (b >= 0x30 && b <= 0x39) || (b >= 0x61 && b <= 0x7a) || (b >= 0x41 && b <= 0x5a) || b === 0x2d || b === 0x2b || b === 0x2e;
// A key longer than this can't be one asked for, so it isn't kept.
const MAX_KEY_BYTES = 1024;
const SEP = "\u0000";
// The byte order mark TextDecoder drops from the start of a body.
const BOM = [0xef, 0xbb, 0xbf];

/**
 * Reads a JSON document piece by piece (push, then end) and keeps the object or list at each path
 * asked for, as keep makes it from the parsed value as soon as its last byte is in. Where a key comes
 * twice, the last one counts, as with JSON.parse: what the first one held is dropped, at its path and
 * every path under it. A path whose value isn't an object or a list, or that the document doesn't have,
 * gives undefined; paths aren't inside one another. A byte order mark at the start is skipped, as
 * TextDecoder skips it. A document that isn't JSON throws a SyntaxError (outside the values kept, only
 * its structure is checked).
 */
export class JsonPicker<T> {
  private readonly wanted = new Map<string, number>();
  // The paths each key on the way to one leads to: "facts" and "facts\0us-gaap" to facts.us-gaap.Revenues.
  private readonly under = new Map<string, number[]>();
  private readonly depths = new Set<number>();
  private readonly deepest: number;
  private readonly keep: (value: unknown, index: number) => T;
  private readonly found: (T | undefined)[];
  // The open objects and lists, and the key each object is at (for the depths a path reaches).
  private readonly stack: number[] = [];
  private readonly keys: (string | null)[] = [];
  private state = VALUE;
  // How much of a byte order mark the start has had: 3 once the start is past, with one or without.
  private bom = 0;
  private inString = false;
  private escaped = false;
  private inLiteral = false;
  // The bytes of the key being read, when its depth is one a path reaches.
  private key: number[] | null = null;
  private keyIsString = false;
  // The value being kept: which path, the depth it's at, and its bytes so far.
  private capture: { index: number; depth: number; parts: Uint8Array[] } | null = null;

  constructor(paths: readonly JsonPath[], keep: (value: unknown, index: number) => T) {
    paths.forEach((path, i) => {
      this.wanted.set(path.join(SEP), i);
      this.depths.add(path.length);
      for (let n = 1; n <= path.length; n++) {
        const prefix = path.slice(0, n).join(SEP);
        this.under.set(prefix, [...(this.under.get(prefix) ?? []), i]);
      }
    });
    this.deepest = Math.max(0, ...this.depths);
    this.keep = keep;
    this.found = paths.map(() => undefined);
  }

  /** Reads the next piece of the document. */
  push(chunk: Uint8Array): void {
    // Where the value being kept starts in this piece (0 when it began in an earlier one).
    let from = this.capture ? 0 : -1;
    let i = 0;
    // A byte order mark before the document is skipped; part of one is refused, as JSON.parse would.
    for (; this.bom < BOM.length && i < chunk.length; i++) {
      if (chunk[i] === BOM[this.bom]) this.bom++;
      else if (this.bom) throw new SyntaxError("JSON: an unexpected character");
      else {
        this.bom = BOM.length;
        break;
      }
    }
    for (; i < chunk.length; i++) {
      const b = chunk[i];
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (b === BACKSLASH) this.escaped = true;
        else if (b === QUOTE) {
          this.inString = false;
          if (this.keyIsString) this.endKey();
          else this.valueDone();
          continue;
        }
        if (this.key) {
          if (this.key.length < MAX_KEY_BYTES) this.key.push(b);
          else this.key = null;
        }
        continue;
      }
      if (this.inLiteral) {
        if (literal(b)) continue;
        this.inLiteral = false;
      }
      if (space(b)) continue;
      const state = this.state;
      switch (b) {
        case QUOTE:
          if (state === VALUE || state === FIRST_VALUE) this.keyIsString = false;
          else if (state === FIRST_KEY || state === KEY) {
            this.keyIsString = true;
            this.key = this.stack.length <= this.deepest ? [] : null;
          } else throw new SyntaxError("JSON: a string where none may be");
          this.inString = true;
          break;
        case OBJECT:
        case ARRAY:
          if (state !== VALUE && state !== FIRST_VALUE) throw new SyntaxError("JSON: an object or a list where none may be");
          if (!this.capture && this.depths.has(this.stack.length)) {
            const index = this.match();
            if (index !== undefined) {
              this.capture = { index, depth: this.stack.length, parts: [] };
              from = i;
            }
          }
          this.stack.push(b);
          if (this.stack.length <= this.deepest) this.keys[this.stack.length - 1] = null;
          this.state = b === OBJECT ? FIRST_KEY : FIRST_VALUE;
          break;
        case OBJECT_END:
        case ARRAY_END: {
          const open = b === OBJECT_END ? OBJECT : ARRAY;
          const ends = b === OBJECT_END ? state === FIRST_KEY || state === AFTER_VALUE : state === FIRST_VALUE || state === AFTER_VALUE;
          if (this.stack.at(-1) !== open || !ends) throw new SyntaxError("JSON: a closing bracket that doesn't match");
          this.stack.pop();
          if (this.capture && this.stack.length === this.capture.depth) {
            this.capture.parts.push(chunk.slice(from, i + 1));
            this.settle();
            from = -1;
          }
          this.valueDone();
          break;
        }
        case COLON:
          if (state !== AFTER_KEY) throw new SyntaxError("JSON: a colon where none may be");
          this.state = VALUE;
          break;
        case COMMA:
          if (state !== AFTER_VALUE || !this.stack.length) throw new SyntaxError("JSON: a comma where none may be");
          this.state = this.stack.at(-1) === OBJECT ? KEY : VALUE;
          break;
        default:
          if ((state !== VALUE && state !== FIRST_VALUE) || !literal(b)) throw new SyntaxError("JSON: an unexpected character");
          this.inLiteral = true;
          this.valueDone();
      }
    }
    if (this.capture && from >= 0) this.capture.parts.push(chunk.slice(from));
  }

  /** The values kept, in the order of the paths, once the whole document has been read. */
  end(): (T | undefined)[] {
    if (this.state !== DONE || this.inString) throw new SyntaxError("JSON: the document ends before its value does");
    return this.found;
  }

  private valueDone() {
    this.state = this.stack.length ? AFTER_VALUE : DONE;
  }

  private endKey() {
    this.state = AFTER_KEY;
    if (this.stack.length > this.deepest) return;
    let key: string | null = null;
    if (this.key) {
      const raw = Buffer.from(this.key).toString("utf8");
      key = raw.includes("\\") ? (JSON.parse(`"${raw}"`) as string) : raw;
    }
    this.keys[this.stack.length - 1] = key;
    this.key = null;
    // A key that comes again replaces the value before it: nothing kept under the first one stands.
    const at = this.path(this.stack.length);
    if (at !== undefined) for (const index of this.under.get(at) ?? []) this.found[index] = undefined;
  }

  /** The path a value starting here is at, when it's one asked for. */
  private match(): number | undefined {
    const at = this.path(this.stack.length);
    return at === undefined ? undefined : this.wanted.get(at);
  }

  /** The keys down to depth, joined, when every container on the way is an object, each at a key. */
  private path(depth: number): string | undefined {
    for (let d = 0; d < depth; d++) if (this.stack[d] !== OBJECT || this.keys[d] === null) return undefined;
    return this.keys.slice(0, depth).join(SEP);
  }

  /** Parses the value just read whole, and keeps what keep makes of it. */
  private settle() {
    const { index, parts } = this.capture!;
    this.capture = null;
    const bytes = parts.length === 1 ? parts[0] : Buffer.concat(parts);
    this.found[index] = this.keep(JSON.parse(new TextDecoder().decode(bytes)), index);
  }
}
