"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/store";
import { msg } from "@/lib/i18n";
import { useT } from "@/lib/use-t";
import {
  KIND_WORDS,
  NETWORKS,
  TELEGRAM_CAPTION,
  networkById,
  textLength,
  xMentionsCredits,
  xPostCredits,
  type InboxItemView,
  type NetworkId,
  type SocialAccountView,
  type SocialPostView,
} from "@/lib/social";
import { ICONS, Icon, Tile } from "./Home";

type Loaded = { networks: NetworkId[]; accounts: SocialAccountView[]; posts: SocialPostView[]; inbox: InboxItemView[] };
type FileItem = { id: string; mime: string; name: string };
type Tab = "post" | "posts" | "inbox" | "accounts";

const TABS: [Tab, string][] = [
  ["post", msg("New post")],
  ["posts", msg("Planned and sent")],
  ["inbox", msg("Inbox")],
  ["accounts", msg("Accounts")],
];

// How a sign-in that came back here ended (?social=…, set by /api/social/callback).
const OUTCOMES: Record<string, string> = {
  ok: msg("Account connected."),
  cancelled: msg("The sign-in was cancelled. Nothing was connected."),
  expired: msg("That sign-in took too long. Press Connect again."),
  failed: msg("The account couldn't be connected. Please try again."),
};

// Where to make what Bluesky, Mastodon and Telegram need, in plain steps.
const KEY_HELP: Partial<Record<NetworkId, string>> = {
  bluesky: msg("In Bluesky, open Settings > Privacy and security > App passwords, add one, and paste it here with your handle."),
  mastodon: msg("On your Mastodon server, open Preferences > Development > New application, keep read and write ticked, press Submit, open it and copy Your access token."),
  telegram: msg("In Telegram, message @BotFather, send /newbot and copy the token it gives. Then add your bot to your channel or group as an administrator that can post."),
};

const DELIVERY_WORDS: Record<SocialPostView["deliveries"][number]["status"], string> = {
  waiting: msg("Planned"),
  posting: msg("Posting…"),
  done: msg("Posted"),
  failed: msg("Not posted"),
  cancelled: msg("Cancelled"),
};

const card = "rounded-2xl bg-white/[0.03] p-4 ring-1 ring-inset ring-white/10 light:bg-black/[0.02] light:ring-black/10";
const field =
  "mt-1 block w-full rounded-xl bg-white/[0.04] px-3 py-2 text-sm text-zinc-100 ring-1 ring-inset ring-white/10 placeholder:text-zinc-500 focus:outline-none focus:ring-primary/60 light:bg-black/[0.03]";
const button = "rounded-xl px-3.5 py-2 text-sm ring-1 ring-inset ring-white/15 transition hover:bg-white/[0.05] disabled:opacity-40 light:ring-black/15";
const primary = "rounded-xl bg-white px-4 py-2 text-sm font-semibold text-zinc-950 transition hover:brightness-95 disabled:opacity-40";

/** A network's letter on its colour: Flash draws no logos. */
function NetworkTile({ network }: { network: NetworkId }) {
  const n = networkById(network)!;
  return (
    <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm font-bold text-white" style={{ background: n.color }} aria-hidden>
      {n.name[0]}
    </span>
  );
}

/** Opens only an address on the network's own site (the server builds them); anything else isn't a link. */
const safeLink = (url: string) => (/^https:\/\/[^\s"<>]+$/.test(url) ? url : "");

/**
 * The Social hub, from the menu: the user's own accounts on X, YouTube, Google Business Profile,
 * Pinterest, Bluesky, Mastodon and Telegram, connected to Flash directly. Write a post once and send
 * it to several, now or later; see what went out; answer comments, mentions, messages and reviews in
 * one inbox. Everything is kept in Flash (see server/social.ts).
 */
export function SocialHub({ outcome = "", onClose }: { outcome?: string; onClose: () => void }) {
  const t = useT();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [tab, setTab] = useState<Tab>(outcome ? "accounts" : "post");
  const [data, setData] = useState<Loaded | null>(null);
  const [notice, setNotice] = useState(OUTCOMES[outcome] ? t(OUTCOMES[outcome]) : "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const load = useCallback(async () => {
    try {
      setData(await api<Loaded>("/api/social"));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);
  useEffect(() => {
    api<Loaded>("/api/social")
      .then(setData)
      .catch((err: Error) => setError(err.message));
  }, []);

  /** Runs a change, showing what went wrong in Flash's words, then reloads. */
  async function attempt(fn: () => Promise<unknown>, done = "") {
    if (busy) return false;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      if (done) setNotice(done);
      await load();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const accounts = data?.accounts ?? [];

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="social-title"
        className="flex max-h-[92dvh] w-full max-w-3xl flex-col rounded-t-3xl border border-white/8 bg-zinc-950 text-zinc-100 sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 px-6 pb-2 pt-6 sm:px-7">
          <div className="flex min-w-0 items-center gap-3">
            <Tile d={ICONS.megaphone} hue="pink" size="sm" />
            <div className="min-w-0">
              <h2 id="social-title" className="text-xl font-semibold tracking-tight">
                {t("Social hub")}
              </h2>
              <p className="mt-0.5 text-sm leading-relaxed text-zinc-400">{t("Post everywhere at once, plan posts ahead, and answer every comment and message in one place.")}</p>
            </div>
          </div>
          <button ref={closeRef} onClick={onClose} className="rounded-full p-2 text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100" aria-label={t("Close")}>
            ✕
          </button>
        </div>

        <div className="flex gap-1 overflow-x-auto px-6 pt-2 sm:px-7" role="tablist">
          {TABS.map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm transition ${tab === id ? "bg-white/10 text-white light:bg-black/10 light:text-zinc-900" : "text-zinc-400 hover:text-zinc-100"}`}
            >
              {t(label)}
            </button>
          ))}
        </div>

        <div className="min-h-0 space-y-4 overflow-y-auto px-6 pb-6 pt-4 sm:px-7">
          {notice && <p className="rounded-xl bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">{notice}</p>}
          {error && (
            <p className="rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-300" role="alert">
              {error}
            </p>
          )}
          {!data ? (
            !error && <p className="text-sm text-zinc-500">{t("Loading…")}</p>
          ) : tab === "post" ? (
            <Composer accounts={accounts.filter((a) => a.status === "ok")} busy={busy} attempt={attempt} onAccounts={() => setTab("accounts")} onSent={() => setTab("posts")} />
          ) : tab === "posts" ? (
            <Posts posts={data.posts} busy={busy} attempt={attempt} />
          ) : tab === "inbox" ? (
            <Inbox items={data.inbox} accounts={accounts} busy={busy} attempt={attempt} onReplied={(item) => setData({ ...data, inbox: data.inbox.map((i) => (i.id === item.id ? item : i)) })} />
          ) : (
            <Accounts networks={data.networks} accounts={accounts} busy={busy} attempt={attempt} />
          )}
        </div>
      </div>
    </div>
  );
}

type Attempt = (fn: () => Promise<unknown>, done?: string) => Promise<boolean>;

/** A picture or video from My creations, to go with the post. */
function useCreations() {
  const [files, setFiles] = useState<FileItem[]>([]);
  useEffect(() => {
    Promise.all([api<{ files: FileItem[] }>("/api/files?kind=image"), api<{ files: FileItem[] }>("/api/files?kind=video")])
      .then(([pictures, videos]) => setFiles([...videos.files, ...pictures.files]))
      .catch(() => setFiles([]));
  }, []);
  return files;
}

const pad = (n: number) => String(n).padStart(2, "0");
const localInput = (time: number) => {
  const d = new Date(time);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function Composer({ accounts, busy, attempt, onAccounts, onSent }: { accounts: SocialAccountView[]; busy: boolean; attempt: Attempt; onAccounts: () => void; onSent: () => void }) {
  const t = useT();
  const files = useCreations();
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [link, setLink] = useState("");
  const [fileId, setFileId] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [later, setLater] = useState(false);
  const [when, setWhen] = useState(() => localInput(Date.now() + 60 * 60_000));

  if (!accounts.length) {
    return (
      <div className={card}>
        <p className="text-sm text-zinc-300">{t("Connect an account first.")}</p>
        <button className={`${primary} mt-3`} onClick={onAccounts}>
          {t("Connect an account")}
        </button>
      </div>
    );
  }

  const chosen = accounts.filter((a) => picked.includes(a.id));
  const networks = [...new Set(chosen.map((a) => a.network))];
  const file = files.find((f) => f.id === fileId);
  const asksTitle = networks.some((n) => networkById(n)?.title);
  const asksLink = networks.some((n) => n === "pinterest" || n === "google-business");
  const xCredits = networks.includes("x") ? xPostCredits(text) * chosen.filter((a) => a.network === "x").length : 0;
  const over = networks.flatMap((n) => {
    const max = n === "telegram" && file ? TELEGRAM_CAPTION : networkById(n)!.maxText;
    return textLength(n, text) > max ? [t("This is too long for {network}: at most {max} characters.", { network: networkById(n)!.name, max })] : [];
  });
  const at = later ? new Date(when).getTime() : 0;
  const ready = chosen.length > 0 && text.trim().length > 0 && !over.length && !busy && (!later || at > 0);

  async function send() {
    const ok = await attempt(
      () => api("/api/social/posts", { method: "POST", json: { text, title, link, fileId, accountIds: picked, ...(later && { at }) } }),
      later ? t("Planned. Flash posts it on time.") : t("Posting now."),
    );
    if (ok) {
      setText("");
      setTitle("");
      setLink("");
      setFileId("");
      onSent();
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <span className="text-sm font-medium text-zinc-200">{t("Post to")}</span>
        <div className="mt-1.5 flex flex-wrap gap-2">
          {accounts.map((a) => {
            const on = picked.includes(a.id);
            return (
              <button
                key={a.id}
                type="button"
                aria-pressed={on}
                onClick={() => setPicked(on ? picked.filter((x) => x !== a.id) : [...picked, a.id])}
                className={`flex items-center gap-2 rounded-xl px-2.5 py-1.5 text-sm ring-1 ring-inset transition ${on ? "bg-primary/15 ring-primary/60" : "ring-white/10 hover:ring-white/25 light:ring-black/10"}`}
              >
                <NetworkTile network={a.network} />
                <span className="max-w-[12rem] truncate">{a.name}</span>
              </button>
            );
          })}
        </div>
      </div>

      {asksTitle && (
        <label className="block">
          <span className="text-sm font-medium text-zinc-200">{t("Title (YouTube and Pinterest)")}</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} className={field} />
        </label>
      )}
      <label className="block">
        <span className="text-sm font-medium text-zinc-200">{t("Post")}</span>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} maxLength={5000} placeholder={t("What do you want to say?")} className={`${field} resize-none`} />
        <span className="mt-1 flex flex-wrap gap-x-3 text-xs text-zinc-500">
          {networks.map((n) => (
            <span key={n}>
              {networkById(n)!.name} {textLength(n, text)}/{n === "telegram" && file ? TELEGRAM_CAPTION : networkById(n)!.maxText}
            </span>
          ))}
        </span>
      </label>
      {over.map((o) => (
        <p key={o} className="text-sm text-amber-300">
          {o}
        </p>
      ))}
      {asksLink && (
        <label className="block">
          <span className="text-sm font-medium text-zinc-200">{t("Link (Pinterest and Google)")}</span>
          <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://" className={field} />
        </label>
      )}
      <label className="block">
        <span className="text-sm font-medium text-zinc-200">{t("Picture or video from My creations")}</span>
        <select value={fileId} onChange={(e) => setFileId(e.target.value)} className={field}>
          <option value="">{t("None")}</option>
          {files.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </label>
      {file && file.mime.startsWith("image/") && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/api/files/${encodeURIComponent(file.id)}`} alt="" className="max-h-40 rounded-xl" />
      )}

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input type="checkbox" checked={later} onChange={(e) => setLater(e.target.checked)} />
          {t("Post later")}
        </label>
        {later && <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className={`${field} mt-0 w-auto`} aria-label={t("When")} />}
      </div>
      {xCredits > 0 && <p className="text-xs text-zinc-400">{t("Posting on X uses {credits} credits (X charges for each post; more with a link).", { credits: xCredits })}</p>}
      <button className={primary} disabled={!ready} onClick={send}>
        {later ? t("Plan the post") : t("Post now")}
      </button>
    </div>
  );
}

function Posts({ posts, busy, attempt }: { posts: SocialPostView[]; busy: boolean; attempt: Attempt }) {
  const t = useT();
  if (!posts.length) return <p className="text-sm text-zinc-500">{t("Nothing posted or planned yet.")}</p>;
  return (
    <div className="space-y-3">
      {posts.map((p) => {
        const waiting = p.deliveries.some((d) => d.status === "waiting");
        return (
          <div key={p.id} className={card}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs text-zinc-500">{new Date(p.at).toLocaleString(t.locale, { dateStyle: "medium", timeStyle: "short" })}</p>
                {p.title && <p className="mt-1 font-medium">{p.title}</p>}
                <p className="mt-1 whitespace-pre-wrap break-words text-sm text-zinc-200">{p.text}</p>
                {p.fileName && <p className="mt-1 text-xs text-zinc-500">{p.fileName}</p>}
              </div>
              {waiting && (
                <button className={button} disabled={busy} onClick={() => attempt(() => api("/api/social/posts", { method: "DELETE", json: { id: p.id } }), t("Cancelled"))}>
                  {t("Cancel")}
                </button>
              )}
            </div>
            <ul className="mt-3 space-y-1.5">
              {p.deliveries.map((d) => (
                <li key={d.accountId} className="flex flex-wrap items-center gap-2 text-sm">
                  <NetworkTile network={d.network} />
                  <span className="text-zinc-300">{d.name}</span>
                  <span className={d.status === "done" ? "text-emerald-300" : d.status === "failed" ? "text-red-300" : "text-zinc-400"}>{t(DELIVERY_WORDS[d.status])}</span>
                  {safeLink(d.url) && (
                    <a href={safeLink(d.url)} target="_blank" rel="noopener noreferrer" className="text-primary underline-offset-2 hover:underline">
                      {t("Open")}
                    </a>
                  )}
                  {d.problem && <span className="w-full text-xs text-red-300/90">{t(d.problem)}</span>}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function Inbox({ items, accounts, busy, attempt, onReplied }: { items: InboxItemView[]; accounts: SocialAccountView[]; busy: boolean; attempt: Attempt; onReplied: (item: InboxItemView) => void }) {
  const t = useT();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const xAccounts = accounts.filter((a) => a.network === "x" && a.status === "ok");
  const names = new Map(accounts.map((a) => [a.id, a.name]));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <button className={button} disabled={busy} onClick={() => attempt(() => api("/api/social/inbox", { method: "POST", json: {} }))}>
          {t("Check now")}
        </button>
        {xAccounts.map((a) => (
          <button key={a.id} className={button} disabled={busy} onClick={() => attempt(() => api("/api/social/inbox", { method: "POST", json: { accountId: a.id } }))}>
            {t("Check X mentions for {name} ({credits} credits at most)", { name: a.name, credits: xMentionsCredits() })}
          </button>
        ))}
      </div>
      {!items.length && <p className="text-sm text-zinc-500">{t("No comments, mentions, messages or reviews yet. Flash checks every 15 minutes.")}</p>}
      {items.map((i) => {
        const draft = drafts[i.id] ?? "";
        return (
          <div key={i.id} className={card}>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <NetworkTile network={i.network} />
              <span className="font-medium">{i.author || t("Someone")}</span>
              <span className="text-zinc-500">
                {t(KIND_WORDS[i.kind])} · {names.get(i.accountId) ?? ""} · {new Date(i.at).toLocaleString(t.locale, { dateStyle: "medium", timeStyle: "short" })}
              </span>
              {i.stars > 0 && <span className="text-amber-300" aria-label={t("{stars} stars", { stars: i.stars })}>{"★".repeat(i.stars)}</span>}
              {safeLink(i.url) && (
                <a href={safeLink(i.url)} target="_blank" rel="noopener noreferrer" className="text-primary underline-offset-2 hover:underline">
                  {t("Open")}
                </a>
              )}
            </div>
            {i.text && <p className="mt-2 whitespace-pre-wrap break-words text-sm text-zinc-200">{i.text}</p>}
            {i.repliedAt ? (
              <p className="mt-2 whitespace-pre-wrap break-words rounded-xl bg-white/[0.04] px-3 py-2 text-sm text-zinc-300">
                <span className="text-xs text-zinc-500">{t("You answered")}: </span>
                {i.reply}
              </p>
            ) : (
              <div className="mt-2 flex gap-2">
                <textarea value={draft} onChange={(e) => setDrafts({ ...drafts, [i.id]: e.target.value })} rows={2} placeholder={t("Write an answer")} className={`${field} mt-0 resize-none`} />
                <button
                  className={`${primary} self-end`}
                  disabled={busy || !draft.trim()}
                  onClick={() =>
                    attempt(async () => {
                      const { item } = await api<{ item: InboxItemView }>("/api/social/inbox/reply", { method: "POST", json: { id: i.id, text: draft } });
                      onReplied(item);
                    }, i.network === "x" ? t("Answered. It used {credits} credits on X.", { credits: xPostCredits(draft) }) : t("Answered."))
                  }
                >
                  {t("Send")}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Accounts({ networks, accounts, busy, attempt }: { networks: NetworkId[]; accounts: SocialAccountView[]; busy: boolean; attempt: Attempt }) {
  const t = useT();
  const [open, setOpen] = useState<NetworkId | "">("");
  const [form, setForm] = useState<Record<string, string>>({});

  async function signIn(network: NetworkId) {
    await attempt(async () => {
      const { url } = await api<{ url: string }>("/api/social/accounts", { method: "POST", json: { network } });
      const target = new URL(url);
      if (target.protocol !== "https:" && target.protocol !== "http:") throw new Error("Unexpected sign-in address.");
      window.location.assign(target.href);
    });
  }

  const set = (name: string) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [name]: e.target.value });

  return (
    <div className="space-y-5">
      {accounts.length > 0 && (
        <div className="space-y-2">
          {accounts.map((a) => (
            <div key={a.id} className={`${card} flex flex-wrap items-center gap-3`}>
              <NetworkTile network={a.network} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{a.name}</p>
                <p className="text-xs text-zinc-500">{networkById(a.network)!.name}</p>
                {a.status !== "ok" && <p className="text-xs text-amber-300">{t("This account needs to be connected again.")}</p>}
              </div>
              {a.targets.length > 1 && (
                <select
                  value={a.target}
                  disabled={busy}
                  aria-label={t("Where posts go")}
                  onChange={(e) => attempt(() => api("/api/social/accounts", { method: "PATCH", json: { id: a.id, target: e.target.value } }))}
                  className={`${field} mt-0 w-auto max-w-[14rem]`}
                >
                  {a.targets.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </select>
              )}
              {a.status !== "ok" && networkById(a.network)!.connect === "signin" && (
                <button className={button} disabled={busy} onClick={() => signIn(a.network)}>
                  {t("Reconnect")}
                </button>
              )}
              <button
                className={button}
                disabled={busy}
                onClick={() => {
                  if (confirm(t("Remove this account from Flash? Posts planned for it won't go out."))) void attempt(() => api("/api/social/accounts", { method: "DELETE", json: { id: a.id } }), t("Removed."));
                }}
              >
                {t("Remove")}
              </button>
            </div>
          ))}
        </div>
      )}

      <div>
        <p className="text-sm font-medium text-zinc-200">{t("Connect an account")}</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {NETWORKS.filter((n) => networks.includes(n.id)).map((n) => (
            <div key={n.id} className={card}>
              <div className="flex items-center gap-3">
                <NetworkTile network={n.id} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{n.name}</p>
                  <p className="text-xs text-zinc-400">{t(n.blurb)}</p>
                </div>
                <button className={button} disabled={busy} onClick={() => (n.connect === "signin" ? signIn(n.id) : setOpen(open === n.id ? "" : n.id))}>
                  {t("Connect")}
                </button>
              </div>
              {n.paid && <p className="mt-2 text-xs text-zinc-500">{t("X charges for each post, so each one uses a few credits (more with a link).")}</p>}
              {open === n.id && (
                <form
                  className="mt-3 space-y-2"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const ok = await attempt(() => api("/api/social/accounts", { method: "POST", json: { network: n.id, ...form } }), t("Account connected."));
                    if (ok) {
                      setOpen("");
                      setForm({});
                    }
                  }}
                >
                  <p className="text-xs leading-relaxed text-zinc-400">{t(KEY_HELP[n.id] ?? "")}</p>
                  {n.id === "bluesky" && (
                    <>
                      <input value={form.handle ?? ""} onChange={set("handle")} placeholder={t("Handle, like name.bsky.social")} className={field} autoComplete="off" />
                      <input value={form.password ?? ""} onChange={set("password")} placeholder={t("App password")} type="password" className={field} autoComplete="off" />
                    </>
                  )}
                  {n.id === "mastodon" && (
                    <>
                      <input value={form.server ?? ""} onChange={set("server")} placeholder={t("Server, like mastodon.social")} className={field} autoComplete="off" />
                      <input value={form.token ?? ""} onChange={set("token")} placeholder={t("Access token")} type="password" className={field} autoComplete="off" />
                    </>
                  )}
                  {n.id === "telegram" && (
                    <>
                      <input value={form.token ?? ""} onChange={set("token")} placeholder={t("Bot token")} type="password" className={field} autoComplete="off" />
                      <input value={form.chat ?? ""} onChange={set("chat")} placeholder={t("Channel or group, like @mychannel")} className={field} autoComplete="off" />
                    </>
                  )}
                  <button className={primary} disabled={busy}>
                    {t("Connect")}
                  </button>
                </form>
              )}
            </div>
          ))}
        </div>
        <p className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-zinc-500">
          <Icon d={ICONS.clock} className="mt-0.5 h-4 w-4 shrink-0" />
          {t("TikTok and LinkedIn are coming: Flash is waiting for their approval.")}
        </p>
      </div>
    </div>
  );
}
