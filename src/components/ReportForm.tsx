"use client";

import { useState, type ReactNode } from "react";
import { api } from "@/lib/store";
import type { T } from "@/lib/use-t";
import { MAX_REPORT_ADDRESS, MAX_REPORT_DETAILS, MAX_REPORT_EMAIL, REPORT_REASONS, type ReportReason } from "@/lib/report";

const field =
  "w-full rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-500 focus:border-primary/70";

/**
 * Tells Flash's team what's wrong with a page (see src/lib/report.ts): a reason, and details and an
 * email for a reply if the person wants. With address, it reports that page (a shared chat's own
 * form); without, it asks for the page's address (the /report page). Once sent it thanks the
 * person, with `after` below the thanks; nothing else changes anywhere.
 */
export function ReportForm({ t, address, onCancel, after }: { t: T; address?: string; onCancel?: () => void; after?: ReactNode }) {
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState<ReportReason | "">("");
  const [details, setDetails] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!reason) {
      setError(t("Pick what's wrong."));
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api("/api/reports", { method: "POST", json: { address: address ?? typed, reason, details, email } });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t("Something went wrong. Please try again."));
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div role="status">
        <div className="flex items-center gap-2.5">
          <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-950 text-emerald-300">
            <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4.5 10.5l3.5 3.5 7.5-8" />
            </svg>
          </span>
          <h3 className="text-base font-medium text-white">{t("Thanks for telling us")}</h3>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-zinc-400">
          {t("Your report was sent to the Flash team. We'll review it and take down anything that breaks our terms.")}
        </p>
        {after}
      </div>
    );
  }

  return (
    <form onSubmit={send} noValidate className="space-y-5">
      {address === undefined && (
        <div>
          <label htmlFor="report-address" className="block text-sm font-medium text-zinc-200">
            {t("Page address")}
          </label>
          <input
            id="report-address"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="https://…"
            maxLength={MAX_REPORT_ADDRESS}
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            required
            dir="ltr"
            aria-describedby="report-address-hint"
            className={`${field} mt-1.5`}
          />
          <p id="report-address-hint" className="mt-1.5 text-xs text-zinc-500">
            {t("A shared chat, a file, or an app made with Flash, including apps on their own domain.")}
          </p>
        </div>
      )}

      <fieldset>
        <legend className="text-sm font-medium text-zinc-200">{t("What's wrong?")}</legend>
        <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
          {REPORT_REASONS.map((r) => (
            <label
              key={r.id}
              className={`flex cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2 text-sm transition ${
                reason === r.id ? "border-primary/70 bg-primary/10 text-white" : "border-white/8 text-zinc-300 hover:bg-white/[0.04]"
              }`}
            >
              <input
                type="radio"
                name="report-reason"
                value={r.id}
                checked={reason === r.id}
                onChange={() => {
                  setReason(r.id);
                  setError("");
                }}
                className="h-4 w-4 shrink-0 accent-primary"
              />
              {t(r.label)}
            </label>
          ))}
        </div>
      </fieldset>

      <div>
        <label htmlFor="report-details" className="block text-sm font-medium text-zinc-200">
          {t("Details (optional)")}
        </label>
        <textarea
          id="report-details"
          value={details}
          onChange={(e) => setDetails(e.target.value)}
          placeholder={t("What should we look at, and where on the page?")}
          maxLength={MAX_REPORT_DETAILS}
          rows={3}
          className={`${field} mt-1.5 resize-y`}
        />
        {details.length > MAX_REPORT_DETAILS * 0.8 && (
          <p className="mt-1 text-end text-xs tabular-nums text-zinc-500" aria-live="polite">
            {details.length}/{MAX_REPORT_DETAILS}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="report-email" className="block text-sm font-medium text-zinc-200">
          {t("Your email (optional)")}
        </label>
        <input
          id="report-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          maxLength={MAX_REPORT_EMAIL}
          autoComplete="email"
          dir="ltr"
          aria-describedby="report-email-hint"
          className={`${field} mt-1.5`}
        />
        <p id="report-email-hint" className="mt-1.5 text-xs text-zinc-500">
          {t("Only if you'd like a reply.")}
        </p>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {onCancel && (
          <button type="button" onClick={onCancel} className="h-10 rounded-full px-4 text-sm text-zinc-300 transition hover:bg-white/[0.06]">
            {t("Cancel")}
          </button>
        )}
        <button
          type="submit"
          disabled={busy}
          className="h-10 rounded-full bg-brand px-5 text-sm font-medium text-on-brand transition hover:brightness-110 disabled:opacity-50"
        >
          {busy ? t("Sending…") : t("Send report")}
        </button>
      </div>
    </form>
  );
}
