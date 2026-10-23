"use client";

import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { api } from "@/lib/store";
import { cancelled, createPasskey, usePasskeysSupported } from "@/lib/passkey";
import { useT } from "@/lib/use-t";

type Passkey = { id: string; name: string; createdAt: number; lastUsedAt: number };

const button =
  "rounded-lg border border-white/10 px-3.5 py-1.5 text-sm text-zinc-200 transition hover:bg-white/[0.05] disabled:opacity-40";
const primary =
  "rounded-lg bg-brand px-4 py-1.5 text-sm font-medium text-on-brand transition hover:brightness-110 disabled:opacity-40";
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
      const { options } = await api<{ options: unknown }>("/api/me/passkeys", { method: "POST", json: { action: "options" } });
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
        {supported ? (
          <button className={primary} disabled={busy} onClick={add}>
            {t("Add a passkey on this device")}
          </button>
        ) : (
          <p className="text-xs text-zinc-500">{t("This browser can't make passkeys. Try Chrome, Safari or Edge on a recent phone or computer.")}</p>
        )}
      </div>
    </Section>
  );
}
