"use client";

import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { api } from "@/lib/store";
import { cancelled, createPasskey, usePasskeysSupported } from "@/lib/passkey";
import { useT } from "@/lib/use-t";
import { PasswordInput } from "./PasswordInput";

type Passkey = { id: string; name: string; createdAt: number; lastUsedAt: number };

const button =
  "rounded-lg border border-white/10 px-3.5 py-1.5 text-sm text-zinc-200 transition hover:bg-white/[0.05] disabled:opacity-40";
const primary =
  "rounded-lg bg-brand px-4 py-1.5 text-sm font-medium text-on-brand transition hover:brightness-110 disabled:opacity-40";
const field =
  "mt-1.5 block h-9 w-full max-w-xs rounded-lg border border-white/10 bg-white/[0.03] px-3 text-sm outline-none focus:border-primary/70";
const danger =
  "rounded-lg border border-red-500/40 px-3 py-1 text-xs text-red-300 transition hover:bg-red-500/10 disabled:opacity-40";

/** Settings > Account: the account's passkeys, to add one on this device or remove one (see server/passkeys.ts). */
export function Passkeys({
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
  const [list, setList] = useState<Passkey[] | null>(null);
  const supported = usePasskeysSupported();
  const [removing, setRemoving] = useState("");
  // Asked to confirm it's them first (see the route): which ways the account has, and what's typed.
  const [confirm, setConfirm] = useState<{ password: boolean; twoFactor: boolean } | null>(null);
  const [secret, setSecret] = useState("");

  const load = () =>
    api<{ passkeys: Passkey[] }>("/api/me/passkeys")
      .then((r) => setList(r.passkeys))
      .catch(() => setList(null));
  useEffect(() => {
    load();
  }, []);

  if (!list) return null;

  const day = (at: number) => new Date(at).toLocaleDateString(t.locale, { year: "numeric", month: "short", day: "numeric" });

  const add = () =>
    attempt(async () => {
      const proof = confirm?.password ? { password: secret } : confirm?.twoFactor ? { code: secret } : {};
      let options;
      try {
        ({ options } = await api<{ options: unknown }>("/api/me/passkeys", { method: "POST", json: { action: "options", ...proof } }));
      } catch (err) {
        const e = err as { code?: string; data?: { password?: boolean; twoFactor?: boolean } };
        if (e.code === "reauth" && (e.data?.password || e.data?.twoFactor)) setConfirm({ password: !!e.data.password, twoFactor: !!e.data.twoFactor });
        throw err;
      }
      setConfirm(null);
      setSecret("");
      let response;
      try {
        response = await createPasskey(options);
      } catch (err) {
        // Closing the device's prompt isn't an error.
        if (cancelled(err)) return "";
        throw err;
      }
      await api("/api/me/passkeys", { method: "POST", json: { action: "add", response } });
      await load();
      return t("Passkey added. Next time, choose \"Sign in with a passkey\".");
    });

  const remove = (id: string) =>
    attempt(async () => {
      await api("/api/me/passkeys", { method: "POST", json: { action: "remove", id } });
      setRemoving("");
      await load();
      return t("Passkey removed.");
    });

  return (
    <Section title={t("Passkeys")}>
      <div className="space-y-3">
        <p className="text-sm text-zinc-400">
          {t(
            "Sign in with your face, fingerprint or device PIN instead of a password. A passkey only works on Flash's own site, so it can't be phished, and it counts as both steps of two-step sign-in.",
          )}
        </p>
        <p className="text-xs text-zinc-500">{t("Logging out of all devices, or changing or resetting your password, also removes your passkeys.")}</p>
        {list.length > 0 && (
          <ul className="divide-y divide-white/5 rounded-lg border border-white/10">
            {list.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm text-zinc-200">{p.name || t("Passkey")}</p>
                  <p className="text-xs text-zinc-500">
                    {t("Added {date}", { date: day(p.createdAt) })}
                    {p.lastUsedAt > 0 && ` · ${t("last used {date}", { date: day(p.lastUsedAt) })}`}
                  </p>
                </div>
                {removing === p.id ? (
                  <span className="flex gap-2">
                    <button className={danger} disabled={busy} onClick={() => remove(p.id)}>
                      {t("Remove")}
                    </button>
                    <button className="text-xs text-zinc-400 hover:text-zinc-100" onClick={() => setRemoving("")}>
                      {t("Cancel")}
                    </button>
                  </span>
                ) : (
                  <button className={button} disabled={busy} onClick={() => setRemoving(p.id)}>
                    {t("Remove")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {supported && confirm && (
          <label className="block text-sm text-zinc-300">
            {confirm.password ? t("Current password") : t("6-digit code")}
            {confirm.password ? (
              <PasswordInput wrapClassName="max-w-xs" className={field} autoComplete="current-password" value={secret} onValue={setSecret} />
            ) : (
              <input
                className={field}
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                maxLength={12}
              />
            )}
          </label>
        )}
        {supported ? (
          <button className={primary} disabled={busy || (!!confirm && !secret.trim())} onClick={add}>
            {confirm ? t("Continue") : t("Add a passkey on this device")}
          </button>
        ) : (
          <p className="text-xs text-zinc-500">{t("This browser can't make passkeys. Try Chrome, Safari or Edge on a recent phone or computer.")}</p>
        )}
      </div>
    </Section>
  );
}
