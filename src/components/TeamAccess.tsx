"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/store";
import { useT } from "@/lib/use-t";

type Role = "member" | "manager";
type Access = "anyone" | "invited";
type Invite = { email: string; role: Role; createdAt: number; joined: boolean };
type TeamState = { invites: Invite[]; chosen: Access | ""; access: Access };

/**
 * Who may sign in to an app, for its owner: anyone, or only the people they invite, each as a
 * member or a manager. Flash's server checks this on every request (see site-team.ts).
 */
export function TeamAccess({ slug, onChange }: { slug: string; onChange?: () => void }) {
  const t = useT();
  const [team, setTeam] = useState<TeamState | null>(null);
  const [emails, setEmails] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    api<TeamState>(`/api/sites/${slug}/members`)
      .then((r) => live && setTeam({ invites: r.invites, chosen: r.chosen, access: r.access }))
      .catch(() => live && setError(t("Couldn't load the members. Please try again.")));
    return () => {
      live = false;
    };
  }, [slug, t]);

  async function send(json: unknown) {
    setBusy(true);
    setError("");
    try {
      const r = await api<TeamState>(`/api/sites/${slug}/members`, { method: "POST", json });
      setTeam({ invites: r.invites, chosen: r.chosen, access: r.access });
      onChange?.();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Something went wrong. Please try again."));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function invite() {
    const list = emails.split(/[\s,;]+/).filter(Boolean);
    if (!list.length) return;
    if (await send({ invite: list, role })) setEmails("");
  }

  async function takeBack(email: string) {
    setBusy(true);
    try {
      const r = await api<{ invites: Invite[] }>(`/api/sites/${slug}/members?invite=${encodeURIComponent(email)}`, { method: "DELETE" });
      setTeam((now) => (now ? { ...now, invites: r.invites } : now));
      onChange?.();
    } catch {
      setError(t("Something went wrong. Please try again."));
    } finally {
      setBusy(false);
    }
  }

  if (!team) return error ? <p className="mb-6 text-sm text-red-400">{error}</p> : null;
  const roleName = (r: Role) => (r === "manager" ? t("Manager") : t("Member"));
  return (
    <section className="mb-8 space-y-4 rounded-2xl border border-white/8 bg-white/[0.02] p-4">
      <div>
        <h3 className="text-sm font-medium text-zinc-100">{t("Who can sign in")}</h3>
        <p className="mt-1 text-xs text-zinc-500">
          {t("Flash checks this on every request, whatever the app's own buttons do. Managers can change everything your team adds; members change what they added.")}
        </p>
      </div>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t("Who can sign in")}>
        {(
          [
            ["invited", t("Only people I invite")],
            ["anyone", t("Anyone can sign up")],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            role="radio"
            aria-checked={team.access === value}
            disabled={busy}
            onClick={() => {
              // Opening an app that keeps team data to anyone lets strangers sign up and see it.
              if (value === "anyone" && team.access === "invited" && !team.chosen && !window.confirm(t("This app keeps your team's data. If anyone can sign up, strangers can see it too. Open it to anyone?"))) return;
              send({ access: value });
            }}
            className={`rounded-full border px-3.5 py-1.5 text-xs transition ${
              team.access === value ? "border-primary/50 bg-primary/15 text-primary-soft" : "border-white/10 text-zinc-300 hover:bg-white/[0.05]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {!team.chosen && team.access === "invited" && (
        <p className="text-xs text-zinc-500">{t("This app keeps your team's data, so Flash lets in only the people you invite.")}</p>
      )}
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          invite();
        }}
      >
        <input
          type="text"
          inputMode="email"
          value={emails}
          onChange={(e) => setEmails(e.target.value)}
          placeholder={t("Email addresses, separated by commas")}
          aria-label={t("Email addresses to invite")}
          className="h-9 min-w-0 flex-1 basis-60 rounded-xl border border-white/10 bg-transparent px-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-primary/50"
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
          aria-label={t("Role")}
          className="h-9 rounded-xl border border-white/10 bg-zinc-900 px-2 text-sm text-zinc-100"
        >
          <option value="member">{roleName("member")}</option>
          <option value="manager">{roleName("manager")}</option>
        </select>
        <button disabled={busy || !emails.trim()} className="h-9 rounded-xl bg-white px-4 text-sm font-medium text-zinc-950 transition hover:brightness-110 disabled:opacity-40">
          {t("Invite")}
        </button>
      </form>
      {error && <p className="text-xs text-red-400">{error}</p>}
      {team.invites.length > 0 && (
        <ul className="divide-y divide-white/5 text-sm">
          {team.invites.map((i) => (
            <li key={i.email} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <span className="min-w-0 flex-1 truncate text-zinc-200">{i.email}</span>
              <span className="text-xs text-zinc-500">{i.joined ? t("Signed up") : t("Not signed up yet")}</span>
              <select
                value={i.role}
                disabled={busy}
                onChange={(e) => send({ invite: [i.email], role: e.target.value })}
                aria-label={t("Role for {email}", { email: i.email })}
                className="h-8 rounded-lg border border-white/10 bg-zinc-900 px-2 text-xs text-zinc-100"
              >
                <option value="member">{roleName("member")}</option>
                <option value="manager">{roleName("manager")}</option>
              </select>
              <button disabled={busy} onClick={() => takeBack(i.email)} className="text-xs text-zinc-500 hover:text-red-400">
                {t("Remove")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
