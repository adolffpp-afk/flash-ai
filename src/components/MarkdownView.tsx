"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const REMARK = [remarkGfm];

/**
 * Words written in Markdown (with tables and lists), shown with the caller's components. In a file of
 * its own so the Markdown reader is downloaded only once there are words to show, never for Home.
 */
export default function MarkdownView({ text, components }: { text: string; components: Components }) {
  return (
    <ReactMarkdown remarkPlugins={REMARK} components={components}>
      {text}
    </ReactMarkdown>
  );
}
