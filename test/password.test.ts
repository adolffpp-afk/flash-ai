import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

const { strongPassword, passwordStrength, SUGGEST_LETTERS } = await import("../src/lib/password.ts");
const { flashDbShim } = await import("../src/lib/flashdb-shim.ts");

/** flashAuth as an app sees it, from the published page's script or the preview's. */
function flashAuthOf(script: string) {
  const window: { flashAuth?: { suggestPassword(): string; passwordStrength(text: string): string } } = {};
  const document = { readyState: "complete", addEventListener() {} };
  vm.runInNewContext(script.replace(/^<script>|<\/script>$/g, ""), {
    window,
    document,
    fetch,
    console,
    crypto,
    location: { href: "https://flash.test/p/x" },
    history: { replaceState() {} },
    URL,
    URLSearchParams,
    Promise,
  });
  return window.flashAuth!;
}

test("a suggested password is 16 easy-to-read random characters in groups of four, with a small letter, a capital and a digit", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const password = strongPassword();
    assert.match(password, /^[^-]{4}-[^-]{4}-[^-]{4}-[^-]{4}$/);
    for (const c of password.replace(/-/g, "")) assert.ok(SUGGEST_LETTERS.includes(c), c);
    assert.match(password, /[a-z]/);
    assert.match(password, /[A-Z]/);
    assert.match(password, /\d/);
    assert.doesNotMatch(password, /[lIO01]/, "no characters that look alike");
    assert.equal(passwordStrength(password), "strong");
    seen.add(password);
  }
  assert.equal(seen.size, 200);
});

test("a password's strength reads weak, okay or strong", () => {
  assert.equal(passwordStrength(""), "");
  assert.equal(passwordStrength("abc1!"), "weak", "too short");
  assert.equal(passwordStrength("password123"), "weak", "a common one");
  assert.equal(passwordStrength("Qwerty!2024x"), "weak", "a common one inside");
  assert.equal(passwordStrength("aaaaaaaaaaaaaaaaaa"), "weak", "the same letter again and again");
  assert.equal(passwordStrength("sunflower"), "weak", "one kind of character, short");
  assert.equal(passwordStrength("sunflower7"), "okay");
  assert.equal(passwordStrength("Sunflower7!x"), "strong");
  assert.equal(passwordStrength("correct horse battery"), "strong", "a long phrase");
});

test("apps Flash builds get the same suggestion and strength, live and in the preview", () => {
  const samples = ["", "abc1!", "password123", "sunflower", "sunflower7", "Sunflower7!x", "correct horse battery", "Kq7m-Xp2r-Vh9t-Lw4z", "ññññññññ"];
  for (const page of [flashDbShim("/d", null, null, false, "/auth"), flashDbShim(null)]) {
    const auth = flashAuthOf(page);
    for (const text of samples) assert.equal(auth.passwordStrength(text), passwordStrength(text), text);
    const password = auth.suggestPassword();
    assert.match(password, /^[^-]{4}-[^-]{4}-[^-]{4}-[^-]{4}$/);
    assert.equal(passwordStrength(password), "strong");
  }
});
