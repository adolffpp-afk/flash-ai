"use client";

import { useState } from "react";
import { api, type Me } from "@/lib/store";
import { fullName } from "@/lib/names";

/**
 * Business plan team. The owner invites and removes people and sees what each used this month;
 * a member sees whose credits they share and can leave. Members never see each other's projects.
 */
export function TeamPanel({ me, onChanged }: { me: Me; onChanged: () => void }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const team = me.team;
  if (!team) return null;

  async function act(key: string, path: string, init: RequestInit & { json?: unknown }, done?: (r: { devLink?: string }) => void) {
    setBusy(key);
    setMessage("");
    try {
      const res = await api<{ devLink?: string }>(path, init);
      done?.(res);
      onChanged();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  if (team.role === "member") {
    return (
      <div className="rounded-xl border border-zinc-800 p-4 text-sm">
        <p className="text-zinc-300">
          You&apos;re on <span className="font-medium text-zinc-100">{team.owner}</span>&apos;s team.{" "}
          {team.active
            ? `Requests use the team's shared credits first (${(me.teamCredits ?? 0).toLocaleString("en-US")} left), then your own.`
            : "The team's Business plan isn't active, so requests use your own credits."}{" "}
          Your projects stay private.
        </p>
        <button
          onClick={() => confirm("Leave this team?") && act("leave", "/api/team", { method: "DELETE", json: { userId: me.user.id } })}
          disabled={busy !== null}
          className="mt-3 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:bg-zinc-900 disabled:opacity-50"
        >
          {busy === "leave" ? "Leaving…" : "Leave team"}
        </button>
        {message && <p className="mt-2 text-sm text-amber-300">{message}</p>}
      </div>
    );
  }

  const used = 1 + team.members.length + team.invites.length;
  return (
    <div className="rounded-xl border border-zinc-800 p-4 text-sm">
      <p className="text-zinc-400">
        {team.active
          ? `Everyone on your team spends your plan's shared credits. ${used} of ${team.seats} seats used, you included.`
          : "Your Business plan isn't active, so members use their own credits until you renew."}
      </p>
      {team.active && (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            act("invite", "/api/team", { method: "POST", json: { email } }, (r) => {
              setEmail("");
              if (r.devLink) setMessage(`Test mode: the invitation link is ${r.devLink}`);
            });
          }}
        >
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@company.com"
            aria-label="Teammate's email"
            className="h-9 min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-3 text-sm outline-none focus:border-primary/70"
          />
          <button
            type="submit"
            disabled={busy !== null || used >= team.seats}
            className="h-9 shrink-0 rounded-lg bg-brand px-4 text-sm font-medium text-white transition hover:brightness-110 disabled:opacity-50"
          >
            {busy === "invite" ? "Sending…" : "Invite"}
          </button>
        </form>
      )}
      {(team.members.length > 0 || team.invites.length > 0) && (
        <ul className="mt-3 divide-y divide-white/5">
          {team.members.map((m) => (
            <li key={m.id} className="flex items-center gap-3 py-1.5">
              <span className="min-w-0 flex-1 truncate text-zinc-200" title={m.email}>
                {fullName(m)}
              </span>
              <span className="shrink-0 text-xs text-zinc-500">{m.used.toLocaleString("en-US")} credits this month</span>
              <button
                onClick={() => act(m.id, "/api/team", { method: "DELETE", json: { userId: m.id } })}
                disabled={busy !== null}
                className="shrink-0 text-xs text-zinc-500 hover:text-red-400 disabled:opacity-50"
              >
                Remove
              </button>
            </li>
          ))}
          {team.invites.map((i) => (
            <li key={i.id} className="flex items-center gap-3 py-1.5">
              <span className="min-w-0 flex-1 truncate text-zinc-400">{i.email}</span>
              <span className="shrink-0 text-xs text-zinc-500">invited</span>
              <button
                onClick={() => act(i.id, "/api/team", { method: "DELETE", json: { inviteId: i.id } })}
                disabled={busy !== null}
                className="shrink-0 text-xs text-zinc-500 hover:text-red-400 disabled:opacity-50"
              >
                Cancel
              </button>
            </li>
          ))}
        </ul>
      )}
      {message && <p className="mt-2 break-all text-sm text-amber-300">{message}</p>}
    </div>
  );
}
