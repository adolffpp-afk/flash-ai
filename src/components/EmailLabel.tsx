"use client";

import { useT } from "@/lib/use-t";

/**
 * A translated label with an email in it ("Back to {email}"), on one line. When space runs out only
 * the email shortens, at its own end, so its start (whose account it is) stays readable, in languages
 * written right to left too. The words around it keep their order and spacing from the table.
 */
export function EmailLabel({
  text,
  email,
}: {
  // The English phrase, marked msg() where it is written so the tables have it.
  text: string;
  email: string;
}) {
  const t = useT();
  return (
    <span className="flex min-w-0 items-center whitespace-pre">
      {t.node(text, {
        email: (
          <bdi dir="ltr" className="min-w-0 truncate" title={email}>
            {email}
          </bdi>
        ),
      })}
    </span>
  );
}
