import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { linkHost, safeMarkdown } from "../src/lib/safe-markdown.ts";
import { chatDocument } from "../src/lib/chat-export.ts";
import type { UIMessage } from "../src/lib/store.ts";

// The same call Message.tsx (in the chat and its PDF) and DownloadChat.tsx make.
const render = (text: string) => renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], components: safeMarkdown }, text));

test("a Markdown picture in a reply loads nothing, in the chat and in the downloaded chat", () => {
  for (const text of ["![](https://x/?d=1)", "Hi ![secret](https://x.example/p.png?d=abc) there", "![a][ref]\n\n[ref]: https://x/?d=2"]) {
    const html = render(text);
    assert.doesNotMatch(html, /<img/i, text);
    assert.doesNotMatch(html, /x\/\?d=|x\.example/, text);
  }
  const messages: UIMessage[] = [{ id: "1", role: "assistant", content: "Your total is 12. ![](https://x/?d=1)" }];
  const page = chatDocument("Chat", messages, { markdown: render, picture: () => null, link: (u) => u, date: "today" });
  assert.doesNotMatch(page, /<img/i);
  assert.match(page, /Your total is 12/);
});

test("raw HTML in a reply stays text", () => {
  assert.doesNotMatch(render('<img src="https://x/?d=1">'), /<img/i);
});

test("links show the host they go to, unless the words already say it", () => {
  const html = render("[your invoice](https://evil.example/collect?d=1)");
  assert.match(html, /<a href="https:\/\/evil\.example\/collect\?d=1" target="_blank" rel="noreferrer noopener">your invoice<\/a>/);
  assert.match(html, /<span class="link-host"> \(evil\.example\)<\/span>/);
  assert.doesNotMatch(render("See https://example.com/page"), /link-host/);
  assert.doesNotMatch(render("[Example.com](https://example.com)"), /link-host/);
  assert.doesNotMatch(render("[Files](/api/files/abc)"), /link-host/);
  assert.equal(linkHost("mailto:a@b.c"), "");
  assert.equal(linkHost("https://a.example:8443/x"), "a.example:8443");
  assert.equal(linkHost("not a url"), "");
});

test("a link written without a scheme, or whose words only mention its host, still shows where it goes", () => {
  // A link without a scheme goes to another server too.
  const relative = render("[Open the issue in Linear](//evil.example/c?d=SECRET)");
  assert.match(relative, /<span class="link-host"> \(evil\.example\)<\/span>/);
  assert.equal(linkHost("//evil.example/x"), "evil.example");
  // Words that mention the host aren't the address it goes to.
  const mention = render("[https://linear.app/team/issue?ref=evil.example](https://evil.example/c?d=SECRET)");
  assert.match(mention, /<span class="link-host"> \(evil\.example\)<\/span>/);
  assert.match(render("[see evil.example docs](https://evil.example/x)"), /link-host/);
  // Words that are the address, or its host, say it already.
  assert.doesNotMatch(render("<https://evil.example/x>"), /link-host/);
  assert.doesNotMatch(render("[evil.example](https://evil.example/x)"), /link-host/);
  assert.doesNotMatch(render("[https://evil.example/other](https://evil.example/x)"), /link-host/);
  // Links inside Flash still have none.
  assert.equal(linkHost("/api/files/abc"), "");
  assert.equal(linkHost("files/abc"), "");
  assert.equal(linkHost("#top"), "");
  // The ones that already worked still do.
  assert.match(render("[Open](https:evil.example/x)"), /link-host/);
});
