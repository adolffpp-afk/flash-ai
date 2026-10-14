"use client";

import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { api } from "@/lib/store";
import { useT } from "@/lib/use-t";

type Status = { available: boolean; on: boolean; recoveryLeft: number };

const field =
  "mt-1.5 block h-9 w-full max-w-[12rem] rounded-lg border border-white/10 bg-white/[0.03] px-3 text-sm tracking-[0.2em] outline-none focus:border-primary/70";
const button =
  "rounded-lg border border-white/10 px-3.5 py-1.5 text-sm text-zinc-200 transition hover:bg-white/[0.05] disabled:opacity-40";
const primary =
  "rounded-lg bg-brand px-4 py-1.5 text-sm font-medium text-on-brand transition hover:brightness-110 disabled:opacity-40";
const danger =
  "rounded-lg border border-red-500/40 px-3.5 py-1.5 text-sm text-red-300 transition hover:bg-red-500/10 disabled:opacity-40";

/** Settings > Account: two-step sign-in with an authenticator app (see server/two-factor.ts). */
export function TwoStepSignIn({
  busy,
  attempt,
  section: Section,
}: {
  busy: boolean;
  attempt: (work: () => Promise<string>) => Promise<void>;
  // Settings' own section, with its title.
  section: ComponentType<{ title: string; children: ReactNode }>;
}) {
  const t = useT();
  const [status, setStatus] = useState<Status | null>(null);
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(
    null,
  );
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState("");
  const [asking, setAsking] = useState<"" | "disable" | "renew">("");

  const load = () =>
    api<Status>("/api/me/two-factor")
      .then(setStatus)
      .catch(() => setStatus(null));
  useEffect(() => {
    load();
  }, []);

  if (!status?.available) return null;

  const post = <T,>(json: Record<string, string>) =>
    api<T>("/api/me/two-factor", { method: "POST", json });

  const start = () =>
    attempt(async () => {
      setSetup(await post<{ secret: string; qr: string }>({ action: "start" }));
      setCode("");
      return "";
    });
  const enable = () =>
    attempt(async () => {
      const r = await post<{ codes: string[] }>({ action: "enable", code });
      setCodes(r.codes);
      setSetup(null);
      setCode("");
      await load();
      return t("Two-step sign-in is on.");
    });
  const confirmAsk = () =>
    attempt(async () => {
      if (asking === "renew") {
        const r = await post<{ codes: string[] }>({ action: "renew", code });
        setCodes(r.codes);
      } else await post({ action: "disable", code });
      const done =
        asking === "renew"
          ? t("New recovery codes made. The old ones no longer work.")
          : t("Two-step sign-in is off.");
      setAsking("");
      setCode("");
      await load();
      return done;
    });

  const saveCodes = () => {
    const text = `Flash AI recovery codes\n\n${codes!.join("\n")}\n\nEach code works once.\n`;
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    Object.assign(document.createElement("a"), {
      href: url,
      download: "flash-recovery-codes.txt",
    }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const codeInput = (
    <input
      className={field}
      value={code}
      onChange={(e) => setCode(e.target.value)}
      inputMode="numeric"
      autoComplete="one-time-code"
      placeholder="123456"
      aria-label={t("6-digit code")}
      maxLength={12}
    />
  );

  return (
    <Section title={t("Two-step sign-in")}>
      <div className="space-y-3">
        <p className="text-sm text-zinc-400">
          {t(
            "When it's on, signing in also asks for a code from an authenticator app on your phone, so a stolen password isn't enough to get in.",
          )}
        </p>

        {codes && (
          <div
            role="status"
            className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-3 text-sm text-zinc-300"
          >
            <p className="font-medium text-zinc-100">
              {t("Save your recovery codes")}
            </p>
            <p className="mt-1">
              {t(
                "If you lose your phone, each of these codes lets you sign in once. Keep them somewhere safe; they won't be shown again.",
              )}
            </p>
            <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-zinc-100">
              {codes.map((c) => (
                <li key={c} className="select-all">
                  {c}
                </li>
              ))}
            </ul>
            <div className="mt-3 flex flex-wrap gap-2">
              <button className={button} onClick={saveCodes}>
                {t("Download")}
              </button>
              <button className={primary} onClick={() => setCodes(null)}>
                {t("I saved them")}
              </button>
            </div>
          </div>
        )}

        {!status.on && !setup && (
          <button className={primary} disabled={busy} onClick={start}>
            {t("Turn on two-step sign-in")}
          </button>
        )}

        {!status.on && setup && (
          <div className="space-y-3 rounded-lg border border-white/10 p-3">
            <p className="text-sm text-zinc-300">
              {t(
                "1. Open an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…) and scan this code.",
              )}
            </p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`data:image/svg+xml;utf8,${encodeURIComponent(setup.qr)}`}
              alt={t("QR code for your authenticator app")}
              // White whatever the theme: scanners need a light edge around the code.
              style={{ background: "#fff" }}
              className="h-44 w-44 rounded-lg p-2"
            />
            <p className="text-xs text-zinc-500">
              {t("Can't scan it? Type this key in the app instead:")}{" "}
              <code className="select-all break-all rounded bg-white/[0.05] px-1.5 py-0.5 text-zinc-300">
                {setup.secret}
              </code>
            </p>
            <label className="block text-sm text-zinc-300">
              {t("2. Type the 6-digit code the app shows")}
              {codeInput}
            </label>
            <div className="flex gap-2">
              <button
                className={primary}
                disabled={busy || !code.trim()}
                onClick={enable}
              >
                {t("Turn on")}
              </button>
              <button className={button} onClick={() => setSetup(null)}>
                {t("Cancel")}
              </button>
            </div>
          </div>
        )}

        {status.on && (
          <>
            <p className="text-sm text-emerald-300">
              {t("On. {count} recovery codes left.", {
                count: status.recoveryLeft,
              })}
            </p>
            {asking ? (
              <div className="space-y-2">
                <label className="block text-sm text-zinc-300">
                  {asking === "disable"
                    ? t(
                        "To turn it off, type a code from your app or a recovery code",
                      )
                    : t(
                        "To make new recovery codes, type a code from your app",
                      )}
                  {codeInput}
                </label>
                <div className="flex gap-2">
                  <button
                    className={asking === "disable" ? danger : primary}
                    disabled={busy || !code.trim()}
                    onClick={confirmAsk}
                  >
                    {asking === "disable" ? t("Turn off") : t("Make new codes")}
                  </button>
                  <button
                    className={button}
                    onClick={() => {
                      setAsking("");
                      setCode("");
                    }}
                  >
                    {t("Cancel")}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <button className={button} onClick={() => setAsking("renew")}>
                  {t("New recovery codes")}
                </button>
                <button className={danger} onClick={() => setAsking("disable")}>
                  {t("Turn off")}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </Section>
  );
}
