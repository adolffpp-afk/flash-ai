import { test } from "node:test";
import assert from "node:assert/strict";
import { chatDocument, chatFileName } from "../src/lib/chat-export.ts";
import type { UIMessage } from "../src/lib/store.ts";

test("a downloaded chat keeps the words, pictures and links, and escapes what people typed", () => {
  const messages: UIMessage[] = [
    { id: "1", role: "user", content: "Draw <b>a fox</b>\nplease", attachmentName: "fox.jpg" },
    { id: "2", role: "assistant", content: "Here it is", model: "FLUX.2 Pro", images: [{ url: "/api/files/a", prompt: "A red fox" }, { url: "/api/files/b", prompt: "Gone" }] },
    { id: "3", role: "assistant", content: "", videos: [{ url: "/api/files/v", prompt: "Fox running" }], sources: [{ title: "Foxes", url: "https://example.com/fox" }] },
    { id: "4", role: "assistant", content: "half", pending: true },
  ];
  const html = chatDocument("Fox & friends", messages, {
    markdown: (t) => `<p>${t}</p>`,
    picture: (url) => (url === "/api/files/a" ? "data:image/png;base64,AAA" : null),
    link: (url) => `https://www.flash-app.dev${url}`,
    date: "October 4, 2026",
  });
  assert.match(html, /<title>Fox &amp; friends · Flash AI<\/title>/);
  assert.match(html, /Draw &lt;b&gt;a fox&lt;\/b&gt;<br>please/);
  assert.match(html, /📎 fox\.jpg/);
  assert.match(html, /<img src="data:image\/png;base64,AAA" alt="A red fox">/);
  assert.match(html, /Picture: Gone/, "a picture that couldn't be fetched becomes a caption");
  assert.match(html, /href="https:\/\/www\.flash-app\.dev\/api\/files\/v">Fox running/);
  assert.match(html, /href="https:\/\/example\.com\/fox">Foxes/);
  assert.match(html, /<span>FLUX\.2 Pro<\/span>/);
  assert.doesNotMatch(html, /half/, "an unfinished answer is left out");
});

test("download file names come from the project name", () => {
  assert.equal(chatFileName("Trip to Lisbon!"), "Trip-to-Lisbon.html");
  assert.equal(chatFileName("Café ☕ menu"), "Café-menu.html");
  assert.equal(chatFileName("???"), "flash-chat.html");
});
