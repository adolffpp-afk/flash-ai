"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/store";
import { PRESETS, toolWords, type ActionCard as Card } from "@/lib/connectors";
import { useT } from "@/lib/use-t";
import { ConnectorTile } from "./YourConnectors";

/*
 * A connector call waiting for the user (see pending-actions.ts). Everything on it comes from the
 * call itself, never from Claude's words: the account, the server's host, the tool, and every field
 * of the input exactly as it will be sent. Approve runs it with no model, so it costs nothing; only
 * Continue, which writes a new reply with what came back, uses credits. Shown read-only (without
 * onChange) where it can't be answered.
 */

const button = "rounded-lg border border-white/10 px-3.5 py-1.5 text-sm text-zinc-200 transition hover:bg-white/[0.05] disabled:opacity-40";
const primary = "rounded-lg bg-brand px-4 py-1.5 text-sm font-medium text-on-brand transition hover:brightness-110 disabled:opacity-40";

/** An input value as the user should read it: text as it is, anything else as indented JSON. */
const shown = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value, null, 2));

/** Rows of cells (a Sheet's rows): a list of lists of text or numbers, shown as a table, every cell of it. */
const isRows = (value: unknown): value is (string | number)[][] =>
  Array.isArray(value) && value.length > 0 && value.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === "string" || typeof cell === "number"));

const box = "rounded-lg bg-black/20 px-3 py-2 text-zinc-100 light:bg-black/5";

/** One input value, all of it. */
function Value({ value }: { value: unknown }) {
  if (isRows(value)) {
    return (
      <dd className={`max-h-96 overflow-auto ${box}`}>
        <table className="text-xs">
          <tbody>
            {value.map((row, i) => (
              <tr key={i} className="border-b border-white/6 last:border-0">
                <td className="py-1 pe-3 align-top text-zinc-500">{i + 1}</td>
                {row.map((cell, j) => (
                  <td key={j} dir="auto" className="whitespace-pre-wrap break-words py-1 pe-3 align-top">
                    {String(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </dd>
    );
  }
  return (
    <dd dir="auto" className={`whitespace-pre-wrap break-words ${box}`}>
      {shown(value)}
    </dd>
  );
}

export function ActionCard({
  card,
  onChange,
  onContinue,
}: {
  card: Card;
  // Saves the card's new state on its reply.
  onChange?: (card: Card) => void;
  // Writes the answer on with what an approved call returned (a new reply, paid as usual).
  onContinue?: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [always, setAlways] = useState(false);
  // Read after mount, so the page and the server draw the same thing first.
  const [now, setNow] = useState(0);
  useEffect(() => {
    // Known only in the browser, not while rendering on the server.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const status = card.status === "pending" && now && now >= card.expiresAt ? "expired" : (card.status ?? "pending");
  const waiting = status === "pending";

  async function answer(decision: "approve" | "cancel") {
    if (!onChange) return;
    setBusy(true);
    setError("");
    try {
      if (decision === "approve" && always && card.custom) {
        await api(`/api/connect/${card.connectionId}`, { method: "PATCH", json: { tool: card.tool, trusted: true } });
      }
      const done = await api<{ status: Card["status"]; result?: string }>(`/api/connect/actions/${card.id}`, {
        method: "POST",
        json: decision === "approve" ? { decision, inputHash: card.inputHash } : { decision },
      });
      onChange({ ...card, status: done.status, ...(done.result && { result: done.result }) });
    } catch (e) {
      // Answered elsewhere, or too late: the card shows how it ended.
      const latest = await api<{ status: Card["status"]; result?: string }>(`/api/connect/actions/${card.id}`).catch(() => null);
      if (latest && latest.status !== "pending") onChange({ ...card, status: latest.status, ...(latest.result && { result: latest.result }) });
      else setError(e instanceof Error ? e.message : t("Something went wrong. Please try again."));
    }
    setBusy(false);
  }

  const fields = Object.entries(card.input);
  // A title Flash wrote itself (GitHub's and Google Drive's tools) is shown in the user's language; any other is the server's own.
  const title = toolWords(t, card.title);
  // The service's own name: a GitHub account's label also has its login (GitHub · login).
  const service = card.connection.split(" · ")[0];
  return (
    <div className="mt-3 rounded-xl border border-primary/30 bg-primary/[0.04] p-4 text-sm" role="group" aria-label={t("{connection} · {tool}", { connection: card.connection, tool: title })}>
      <div className="flex items-center gap-3">
        <ConnectorTile provider={card.custom ? "" : (PRESETS.find((p) => p.name === service)?.id ?? service.toLowerCase())} name={card.connection} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-zinc-100">{t("{connection} · {tool}", { connection: card.connection, tool: title })}</p>
          <p className="truncate text-xs text-zinc-500" dir="ltr">
            {card.host}
          </p>
        </div>
      </div>
      {waiting && (
        <p className="mt-3 text-zinc-300">
          {card.custom
            ? t("Flash can't tell what this tool does. Check what it will send before you approve it.")
            : card.kind === "read"
              ? t("This reads from your account. It asks first because this answer already used another account.")
              : t("This may change or send something, or use up what your {connection} plan allows. It runs only if you approve it.", { connection: card.connection })}
        </p>
      )}
      {fields.length > 0 ? (
        <dl className="mt-3 space-y-2">
          {fields.map(([key, value]) => (
            <div key={key}>
              <dt className="text-xs text-zinc-500" dir="ltr">
                {key}
              </dt>
              {/* What Flash knows the value as (a picked file's name), beside the value itself. */}
              {card.labels?.[key] && (
                <dd dir="auto" className="mb-1 text-sm font-medium text-zinc-100">
                  {card.labels[key]}
                </dd>
              )}
              <Value value={value} />
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-3 text-xs text-zinc-500">{t("It sends nothing else.")}</p>
      )}
      {waiting && onChange ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" className={primary} disabled={busy} onClick={() => answer("approve")}>
            {busy ? t("Running…") : t("Approve")}
          </button>
          <button type="button" className={button} disabled={busy} onClick={() => answer("cancel")}>
            {t("Cancel")}
          </button>
          {card.custom && (
            <label className="inline-flex items-center gap-2 text-xs text-zinc-400">
              <input type="checkbox" checked={always} onChange={(e) => setAlways(e.target.checked)} className="accent-primary" />
              {t("Always allow this tool")}
            </label>
          )}
          <span className="text-xs text-zinc-500">{t("Approving costs no credits.")}</span>
        </div>
      ) : (
        <p className="mt-3 text-xs text-zinc-400">
          {status === "done"
            ? t("Done.")
            : status === "failed"
              ? t("It didn't work.")
              : status === "cancelled"
                ? t("Cancelled. Nothing was sent.")
                : status === "expired"
                  ? t("This expired after 30 minutes, so nothing was sent. Ask again if you still want it.")
                  : t("Waiting for your approval.")}
        </p>
      )}
      {card.result && (status === "done" || status === "failed") && (
        <div className="mt-2">
          <p className="text-xs text-zinc-500">{t("What it returned")}</p>
          <pre dir="auto" className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/20 px-3 py-2 font-sans text-xs text-zinc-300 light:bg-black/5">
            {card.result}
          </pre>
        </div>
      )}
      {status === "done" && onContinue && !card.continued && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button type="button" className={button} onClick={onContinue}>
            {t("Continue the answer")}
          </button>
          <span className="text-xs text-zinc-500">{t("Uses credits, like any reply.")}</span>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
