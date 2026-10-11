import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { connectorsReady, lastFour, seal, unseal } from "../src/lib/server/secret-box.ts";

const key = () => randomBytes(32).toString("base64");
const place = { id: "c1", userId: "u1", provider: "linear", field: "token" };

test("connectors need CONNECTOR_KEYS with a usable key", () => {
  const before = process.env.CONNECTOR_KEYS;
  try {
    delete process.env.CONNECTOR_KEYS;
    assert.equal(connectorsReady(), false);
    assert.throws(() => seal("x", place), /aren't set up/);
    process.env.CONNECTOR_KEYS = "not json";
    assert.equal(connectorsReady(), false);
    process.env.CONNECTOR_KEYS = JSON.stringify({ v1: "short" });
    assert.equal(connectorsReady(), false, "a key must be 32 bytes");
    process.env.CONNECTOR_KEYS = JSON.stringify({ v1: key() });
    assert.equal(connectorsReady(), true);
  } finally {
    if (before === undefined) delete process.env.CONNECTOR_KEYS;
    else process.env.CONNECTOR_KEYS = before;
  }
});

test("a secret round-trips, only in its own place, and the stored form doesn't hold it", () => {
  process.env.CONNECTOR_KEYS = JSON.stringify({ v1: key() });
  const secret = "lin_api_0123456789abcdefSECRET";
  const { stored, version } = seal(secret, place);
  assert.equal(version, "v1");
  assert.match(stored, /^v1:[\w-]+:[\w-]+:[\w-]+$/);
  assert.ok(!stored.includes("SECRET"));
  assert.equal(unseal(stored, place), secret);
  // Two seals of the same secret differ (a random IV each time).
  assert.notEqual(seal(secret, place).stored, stored);
  for (const other of [{ ...place, id: "c2" }, { ...place, userId: "u2" }, { ...place, provider: "airtable" }, { ...place, field: "refresh" }]) {
    assert.throws(() => unseal(stored, other), /can't be opened/);
  }
});

test("a changed tag or ciphertext fails, without the value in the error", () => {
  process.env.CONNECTOR_KEYS = JSON.stringify({ v1: key() });
  const { stored } = seal("top-secret-value-1234", place);
  const [v, iv, tag, ct] = stored.split(":");
  const flip = (s: string) => {
    const b = Buffer.from(s, "base64url");
    b[0] ^= 1;
    return b.toString("base64url");
  };
  for (const bad of [[v, iv, flip(tag), ct], [v, iv, tag, flip(ct)], [v, flip(iv), tag, ct], [v, iv, tag.slice(0, 8), ct], ["v9", iv, tag, ct], [v, iv, tag]]) {
    assert.throws(
      () => unseal(bad.join(":"), place),
      (err: Error) => /can't be opened/.test(err.message) && !err.message.includes("top-secret"),
    );
  }
});

test("old key versions still open, and new secrets use the newest", () => {
  const v1 = key();
  process.env.CONNECTOR_KEYS = JSON.stringify({ v1 });
  const old = seal("old secret", place).stored;
  process.env.CONNECTOR_KEYS = JSON.stringify({ v1, v2: key() });
  assert.equal(unseal(old, place), "old secret");
  const fresh = seal("new secret", place);
  assert.equal(fresh.version, "v2");
  assert.ok(fresh.stored.startsWith("v2:"));
  // v10 is newer than v9, by number.
  process.env.CONNECTOR_KEYS = JSON.stringify({ v9: key(), v10: key() });
  assert.equal(seal("x", place).version, "v10");
  // Dropping a key leaves what it sealed closed.
  process.env.CONNECTOR_KEYS = JSON.stringify({ v2: key() });
  assert.throws(() => unseal(old, place), /can't be opened/);
});

test("only the last four characters of a long secret are ever shown", () => {
  assert.equal(lastFour("re_1234567890abcd"), "abcd");
  assert.equal(lastFour("short"), "");
});
