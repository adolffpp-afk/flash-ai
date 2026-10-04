import { test } from "node:test";
import assert from "node:assert/strict";
import { speakable } from "../src/lib/speech.ts";

test("read aloud skips markdown symbols, code and link targets", () => {
  assert.equal(
    speakable("## Plan\n\n- **Call** the [bakery](https://x.co)\n- Run `npm test`\n\n```js\nconsole.log(1)\n```\nDone!"),
    "Plan Call the bakery Run npm test Done!",
  );
});
