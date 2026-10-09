import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = ":memory:";
const { run } = await import("../src/lib/server/db.ts");
const { previewText, recentChats } = await import("../src/lib/server/recent.ts");
const { dateLine, greeting, shortAgo, timeAgo } = await import("../src/lib/when.ts");
const { BAR_COLORS, THEME_SCRIPT, themeFor } = await import("../src/lib/device-settings.ts");

test("Home greets by the time of day and shows the date like the Nova screenshot", () => {
  const at = (h: number, m = 0) => greeting(new Date(2026, 9, 9, h, m));
  assert.deepEqual(
    [at(0), at(4, 59), at(5), at(11, 59), at(12), at(17, 59), at(18), at(23, 59)],
    ["Good evening", "Good evening", "Good morning", "Good morning", "Good afternoon", "Good afternoon", "Good evening", "Good evening"],
  );
  assert.equal(dateLine(new Date(2026, 9, 7, 9)), "Wednesday • Oct 7, 2026 • Your workspace is ready");
  assert.equal(dateLine(new Date(2026, 9, 9, 16)), "Friday • Oct 9, 2026 • Your workspace is ready");
});

test("times ago read naturally, and older ones show the date", () => {
  const now = new Date(2026, 9, 9, 16).getTime();
  const ago = (s: number) => timeAgo(now - s * 1000, now);
  assert.equal(ago(0), "just now");
  assert.equal(ago(59), "just now");
  assert.equal(ago(-30), "just now", "a clock a little ahead is not in the future");
  assert.equal(ago(60), "1 minute ago");
  assert.equal(ago(5 * 60 + 30), "5 minutes ago");
  assert.equal(ago(3600), "1 hour ago");
  assert.equal(ago(2 * 3600), "2 hours ago");
  assert.equal(ago(86_400), "1 day ago");
  assert.equal(ago(29 * 86_400), "29 days ago");
  assert.equal(ago(45 * 86_400), "Aug 25, 2026");
  const short = (s: number) => shortAgo(now - s * 1000, now);
  assert.deepEqual(
    [short(5), short(5 * 60), short(2 * 3600 + 59), short(3 * 86_400), short(45 * 86_400), shortAgo(new Date(2025, 11, 30).getTime(), now)],
    ["just now", "5m ago", "2h ago", "3d ago", "Aug 25", "Dec 30, 2025"],
  );
});

test("the theme is light unless Dark is picked, or Match device is on a dark device", () => {
  assert.equal(themeFor("", true), "light");
  assert.equal(themeFor("", false), "light", "no choice yet is light, whatever the device");
  assert.equal(themeFor("dark", true), "dark");
  assert.equal(themeFor("system", true), "light");
  assert.equal(themeFor("system", false), "dark");
  assert.equal(themeFor("anything else", false), "light");
});

test("the script that runs before the page paints picks the same theme as Settings", () => {
  for (const saved of [null, "", "light", "system", "dark", "something old"]) {
    for (const prefersLight of [true, false]) {
      const root: { dataset: Record<string, string> } = { dataset: {} };
      const bar = { content: BAR_COLORS.light as string, setAttribute: (_: string, v: string) => void (bar.content = v) };
      const document = { documentElement: root, querySelector: (q: string) => (q === 'meta[name="theme-color"]' ? bar : null) };
      const localStorage = { getItem: (key: string) => (key === "flash:theme" ? saved : null) };
      const matchMedia = (q: string) => ({ matches: q === "(prefers-color-scheme: light)" && prefersLight });
      new Function("localStorage", "matchMedia", "document", THEME_SCRIPT)(localStorage, matchMedia, document);
      const theme = themeFor(saved ?? "", prefersLight);
      assert.equal(root.dataset.theme === "light" ? "light" : "dark", theme, `${saved} ${prefersLight}`);
      // The browser's bar matches the page, so a phone shows no dark strip over a light page.
      assert.equal(bar.content, BAR_COLORS[theme]);
    }
  }
  // Blocked storage (a private window) reads as no choice: the page is light, and nothing breaks.
  const root = { dataset: {} as Record<string, string> };
  const blocked = {
    getItem: () => {
      throw new Error("denied");
    },
  };
  const page = { documentElement: root, querySelector: () => null };
  assert.doesNotThrow(() => new Function("localStorage", "matchMedia", "document", THEME_SCRIPT)(blocked, () => ({ matches: false }), page));
  assert.equal(root.dataset.theme, "light");
});

test("Recent conversations lists the user's own chats with messages, newest first, with the last tool and a clean preview", async () => {
  await run("INSERT INTO users (id, email, password_hash, created_at) VALUES ('u1', 'a@x.co', 'h', 0), ('u2', 'b@x.co', 'h', 0)");
  const save = (id: string, user: string, name: string, messages: unknown[], at: number) =>
    run("INSERT INTO projects (id, user_id, name, messages, updated_at) VALUES (?, ?, ?, ?, ?)", [id, user, name, JSON.stringify(messages), at]);
  await save("p1", "u1", "Bakery menu", [
    { role: "user", content: "Write a menu for my bakery" },
    { role: "assistant", engine: "text", content: "## Menu\n\n**Sourdough loaf**: $8.\n\n| Item | Price |\n|---|---|\n| `Croissant` | $3 |" },
  ], 10);
  await save("p2", "u1", "Bakery site", [
    { role: "user", content: "make a bakery page" },
    { role: "assistant", engine: "app", content: "", after: "Your page is ready. Press Publish to share it." },
  ], 30);
  await save("p3", "u1", "Empty chat", [], 40);
  await save("p4", "u2", "Someone else", [{ role: "user", content: "hello" }], 50);
  await save("p5", "u1", "Just asked", [{ role: "user", content: "what's the weather like in snake_case_town? __Now__" }], 20);

  const chats = await recentChats("u1");
  assert.deepEqual(chats.map((c) => c.id), ["p2", "p5", "p1"], "newest first; no empty chats and nobody else's");
  assert.deepEqual(chats.map((c) => c.engine), ["app", null, "text"]);
  assert.equal(chats[0].preview, "Your page is ready. Press Publish to share it.", "an app's answer shows the words after it");
  assert.equal(chats[1].preview, "what's the weather like in snake_case_town? Now");
  assert.equal(chats[2].preview, "Menu Sourdough loaf: $8. Item Price Croissant $3");
  assert.equal(chats[2].updatedAt, 10);
  assert.equal(chats[2].name, "Bakery menu");

  assert.deepEqual((await recentChats("u1", 2)).map((c) => c.id), ["p2", "p5"]);
  assert.deepEqual(await recentChats("nobody"), []);

  // Code, links, web pages and quotes read as words, not raw markup.
  assert.equal(previewText("Here's a function:\n\n```python\ndef is_prime(n: int) -> bool:\n    return n > 1\n```\n\nIt checks primes."), "Here's a function: It checks primes.");
  assert.equal(previewText("```html\n<!doctype html><html><head><title>Rosa</title>"), "Code", "an answer cut short inside its code block");
  assert.equal(previewText("According to [Reuters](https://reuters.com/a), rates held. ![chart](https://x.co/c.png)"), "According to Reuters, rates held. chart");
  assert.equal(previewText("<h1>Rosa's Bakery</h1><p>Fresh bread</p>"), "Rosa's Bakery Fresh bread");
  assert.equal(previewText("> Quoted line\nPro is cheaper if x > 3."), "Quoted line Pro is cheaper if x > 3.");
  assert.equal(previewText(""), "");

  // A long last message gives a short preview.
  await save("p6", "u1", "Long", [{ role: "user", content: "word ".repeat(500) }], 60);
  assert.ok((await recentChats("u1", 1))[0].preview.length <= 160);
});
