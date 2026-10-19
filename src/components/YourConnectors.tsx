"use client";

import { useEffect, useState, type FormEvent } from "react";
import { api } from "@/lib/store";
import { PRESETS, presetById, toolWords, type ConnectionView, type Preset, type ToolKind, type ToolPreview, type ToolView } from "@/lib/connectors";
import { msg } from "@/lib/i18n";
import { useT } from "@/lib/use-t";
import { DriveFiles } from "./DrivePicker";
import { PasswordInput } from "./PasswordInput";

/*
 * Settings > Connectors > Your accounts in Flash: the user's own accounts that replies can use when
 * connectors are on in a chat (see connectors.ts). Most ready-made services connect by signing in on
 * the service's own page (OAuth); some take a key or token the user makes there, and Linear and
 * Airtable do both, sign-in first. "Add your own connector" takes any public https MCP server, shown
 * with its host and every tool before it is added; one that asks for a sign-in is signed in to first,
 * and its tools are shown when the browser comes back. GitHub connects through Flash's GitHub App,
 * installed on the repositories the user picks there, and is offered only once that app is set up (github).
 * Google Drive connects through Flash's own Google Cloud project, offered only once that is set up
 * (google), and opens only the files the user picks with Google's Picker (see DrivePicker.tsx).
 * Keys are never shown again, only their last 4 characters. Until CONNECTOR_KEYS is set, users see
 * nothing here, and the owner sees one line saying why.
 */

type Loaded = { ready: boolean; owner: boolean; github?: boolean; google?: boolean; connections: ConnectionView[] };
type Preview = { host: string; tools: ToolPreview[]; signIn?: { authHost: string; needsClient: boolean; callback: string } };

/** How a sign-in that came back here ended (?connect=…, set by /api/connect/mcp/callback, GitHub's or Google's), in the user's words. */
const OUTCOMES: Record<string, { text: string; ok: boolean }> = {
  ok: { text: msg("Your account is connected."), ok: true },
  review: { text: msg("Look at its tools, then add it."), ok: true },
  cancelled: { text: msg("Sign-in was cancelled. Nothing was connected."), ok: false },
  expired: { text: msg("That sign-in expired or was already used. Try again."), ok: false },
  failed: { text: msg("The sign-in didn't work, so nothing was connected. Try again."), ok: false },
  github_install: { text: msg("The Flash AI app isn't installed on any of your GitHub repositories. Connect again and pick the repositories it may use."), ok: false },
  google_scope: { text: msg("Google didn't give Flash access to the files you pick, so Google Drive can't be used. Reconnect and allow access to the Google Drive files you use with Flash."), ok: false },
};

/**
 * Signs in: the server stores the attempt and answers with the service's own sign-in page, which the
 * browser opens. Only a web address is opened (the server allows https only, or the dev stand-in).
 * GitHub has its own start (its authorize page; the app's installation page follows when needed), and
 * so does Google Drive (Google's authorize page).
 */
async function signIn(request: Record<string, unknown>, provider = "") {
  const route = provider === "github" ? "/api/connect/github/start" : provider === "google-drive" ? "/api/connect/google/start" : "/api/connect/mcp/start";
  const { url } = await api<{ url: string }>(route, { method: "POST", json: request });
  const target = new URL(url);
  if (target.protocol !== "https:" && target.protocol !== "http:") throw new Error("Unexpected sign-in address.");
  window.location.assign(target.href);
}

// A field's look without its margin, for PasswordInput, whose box takes the margin.
const fieldBox =
  "block w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-primary/60";
const field = `mt-1 ${fieldBox}`;
const label = "block text-sm text-zinc-300";
const hint = "text-xs text-zinc-500";
const button = "rounded-lg border border-white/10 px-3.5 py-1.5 text-sm text-zinc-200 transition hover:bg-white/[0.05] disabled:opacity-40";
const primary = "rounded-lg bg-brand px-4 py-1.5 text-sm font-medium text-on-brand transition hover:brightness-110 disabled:opacity-40";
const danger = "rounded-lg border border-red-500/40 px-3.5 py-1.5 text-sm text-red-300 transition hover:bg-red-500/10 disabled:opacity-40";
const section = "flex flex-col gap-4 border-b border-white/6 pb-8 last:border-0 last:pb-0";

/** A service's letter on its colour (a server the user added gets a plain one): Flash shows no logos from other servers. */
export function ConnectorTile({ provider, name, small = false }: { provider: string; name: string; small?: boolean }) {
  const preset = presetById(provider);
  return (
    <span
      aria-hidden
      style={preset ? { backgroundColor: preset.color } : undefined}
      className={`inline-flex shrink-0 items-center justify-center rounded-lg font-semibold text-white ${preset ? "" : "bg-zinc-700"} ${small ? "h-5 w-5 text-[11px]" : "h-9 w-9 text-sm"}`}
    >
      {(name.trim()[0] ?? "?").toUpperCase()}
    </span>
  );
}

function Switch({ on, onChange, name, disabled }: { on: boolean; onChange: (on: boolean) => void; name: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={name}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-40 ${on ? "bg-primary" : "bg-zinc-700"}`}
    >
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-paper shadow transition-all ${on ? "start-[22px]" : "start-0.5"}`} />
    </button>
  );
}

export function YourConnectors() {
  const t = useT();
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // The service being added: a preset, or a server of the user's own.
  const [adding, setAdding] = useState<Preset | "custom" | null>(null);
  // How a sign-in that just came back ended.
  const [outcome, setOutcome] = useState<{ text: string; ok: boolean } | null>(null);

  useEffect(() => {
    api<Loaded>("/api/connect")
      .then(setData)
      .catch(() => setData({ ready: false, owner: false, connections: [] }));
    const url = new URL(window.location.href);
    const came = url.searchParams.get("connect");
    if (came !== null) {
      // Read once (an effect of the page's first view), then taken out of the address.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOutcome(OUTCOMES[came] ?? OUTCOMES.failed);
      url.searchParams.delete("connect");
      window.history.replaceState(null, "", url.pathname + url.search);
    }
  }, []);

  async function attempt(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("Something went wrong. Please try again."));
    }
    setBusy(false);
  }

  const replace = (connection: ConnectionView) =>
    setData((d) => d && { ...d, connections: d.connections.some((c) => c.id === connection.id) ? d.connections.map((c) => (c.id === connection.id ? connection : c)) : [...d.connections, connection] });

  if (!data) return null;
  if (!data.ready) {
    // No fake features: until connectors are set up, only the owner hears about them.
    if (!data.owner) return null;
    return (
      <section className={section}>
        <h3 className="text-base font-medium text-zinc-100">{t("Your accounts in Flash")}</h3>
        <p className="text-sm text-zinc-400">
          {t("Connectors need a key set up first. Make one on the dashboard, under By provider.")}{" "}
          <a href="/admin" className="text-primary-soft underline-offset-2 hover:underline">
            {t("Open the dashboard")}
          </a>
        </p>
      </section>
    );
  }

  return (
    <section className={section}>
      <h3 className="text-base font-medium text-zinc-100">{t("Your accounts in Flash")}</h3>
      <p className="text-sm text-zinc-400">
        {t(
          "Turn connectors on in a chat to let Flash use these accounts in Write, Code, Translate and Docs & Sheets. Replies that use them cost credits as usual, and anything that sends or changes something waits for you to approve it.",
        )}
      </p>
      {outcome && (
        <p role="status" className={`rounded-lg px-3 py-2 text-sm ${outcome.ok ? "bg-emerald-500/10 text-emerald-200" : "bg-red-500/10 text-red-300"}`}>
          {t(outcome.text)}
        </p>
      )}
      {data.connections.length > 0 && (
        <ul className="flex flex-col gap-3">
          {data.connections.map((c) => (
            <Connection
              key={c.id}
              c={c}
              busy={busy}
              onChange={(change) =>
                attempt(async () => {
                  const { connection } = await api<{ connection: ConnectionView }>(`/api/connect/${c.id}`, { method: "PATCH", json: change });
                  replace(connection);
                })
              }
              onRemove={() =>
                attempt(async () => {
                  await api("/api/connect", { method: "DELETE", json: { id: c.id } });
                  setData((d) => d && { ...d, connections: d.connections.filter((x) => x.id !== c.id) });
                })
              }
              onReconnect={() => attempt(() => signIn({ connectionId: c.id }, c.provider))}
              onInstall={() => attempt(() => signIn({ install: true }, c.provider))}
              onFiles={(files) => replace({ ...c, files })}
              onConfirm={() =>
                attempt(async () => {
                  const { connection } = await api<{ connection: ConnectionView }>(`/api/connect/${c.id}`, { method: "PATCH", json: { confirm: true } });
                  replace(connection);
                })
              }
            />
          ))}
        </ul>
      )}
      {adding === null ? (
        <>
          <p className="text-sm text-zinc-300">{t("Add an account")}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {PRESETS.filter((p) => !p.rest || (p.id === "github" ? data.github : p.id === "google-drive" ? data.google : false)).map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => (setError(""), setAdding(p))}
                className="flex items-start gap-3 rounded-xl border border-zinc-800 p-3 text-start transition hover:border-primary/50 hover:bg-white/[0.03]"
              >
                <ConnectorTile provider={p.id} name={p.name} />
                <span className="min-w-0">
                  <span className="block text-sm text-zinc-100">{p.name}</span>
                  <span className={`block ${hint}`}>{t(p.blurb)}</span>
                </span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => (setError(""), setAdding("custom"))}
              className="flex items-start gap-3 rounded-xl border border-dashed border-zinc-700 p-3 text-start transition hover:border-primary/50 hover:bg-white/[0.03]"
            >
              <span aria-hidden className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/[0.06] text-lg text-zinc-300">
                +
              </span>
              <span className="min-w-0">
                <span className="block text-sm text-zinc-100">{t("Add your own connector")}</span>
                <span className={`block ${hint}`}>{t("Any MCP server at a public https address.")}</span>
              </span>
            </button>
          </div>
        </>
      ) : adding === "custom" ? (
        <AddCustom
          busy={busy}
          attempt={attempt}
          onAdded={(connection) => (replace(connection), setAdding(null))}
          onCancel={() => (setError(""), setAdding(null))}
        />
      ) : (
        <AddPreset
          preset={adding}
          busy={busy}
          attempt={attempt}
          onAdded={(connection) => (replace(connection), setAdding(null))}
          onCancel={() => (setError(""), setAdding(null))}
        />
      )}
      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
    </section>
  );
}

type Change = { tool: string; enabled?: boolean; trusted?: boolean; review?: boolean; hash?: string };

/**
 * One connected account: its host, its key's last 4 characters (or that it signed in), and its tools.
 * One that signed in can sign in again (Reconnect), which it needs when its sign-in stopped working
 * or a tool asked for more access. A server the user added and signed in to waits here, its tools
 * shown, until they add it.
 */
function Connection({
  c,
  busy,
  onChange,
  onRemove,
  onReconnect,
  onInstall,
  onConfirm,
  onFiles,
}: {
  c: ConnectionView;
  busy: boolean;
  onChange: (change: Change) => void;
  onRemove: () => void;
  onReconnect: () => void;
  onInstall: () => void;
  onConfirm: () => void;
  onFiles: (files: NonNullable<ConnectionView["files"]>) => void;
}) {
  const t = useT();
  const [removing, setRemoving] = useState(false);
  const review = c.status === "review";
  // A service's own name (a GitHub account's label also has its login): what removing asks it to cancel.
  const service = presetById(c.provider)?.name ?? c.label;
  return (
    <li className="rounded-xl border border-zinc-800 p-4">
      <div className="flex items-center gap-3">
        <ConnectorTile provider={c.provider} name={c.label} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-zinc-100">{c.label}</p>
          <p className={`truncate ${hint}`}>
            <span dir="ltr">{c.account || c.host}</span> · {c.signIn ? t("Connected") : c.last4 ? t("key ending in {last4}", { last4: c.last4 }) : t("no sign-in")}
          </p>
        </div>
        {c.signIn && !review && !removing && c.status === "ok" && (
          <button type="button" className={button} disabled={busy} onClick={onReconnect}>
            {t("Reconnect")}
          </button>
        )}
        {!removing && (
          <button type="button" className={button} disabled={busy} onClick={() => setRemoving(true)}>
            {t("Remove")}
          </button>
        )}
      </div>
      {removing && (
        <div className="mt-3 rounded-lg bg-white/[0.03] p-3">
          <p className="text-sm text-zinc-300">
            {c.signIn
              ? c.revocable
                ? t("Remove {name} from Flash? Flash also asks {name} to cancel the access you gave it.", { name: service })
                : t("Remove {name} from Flash? {name} offers Flash no way to cancel the access you gave it: cancel it in your account there if you don't want it to work any more.", { name: service })
              : c.custom
                ? t("Remove {name} from Flash?", { name: c.label })
                : t("Remove {name} from Flash? This doesn't delete the key in {name}: delete it there too if you don't need it any more.", { name: service })}
          </p>
          <div className="mt-2 flex gap-2">
            <button type="button" className={danger} disabled={busy} onClick={onRemove}>
              {t("Remove")}
            </button>
            <button type="button" className={button} onClick={() => setRemoving(false)}>
              {t("Cancel")}
            </button>
          </div>
        </div>
      )}
      {c.provider === "github" && c.status === "ok" && !removing && (
        // The app's installation page, with a flow that brings the user back (see startGithub): to add
        // repositories, their own or another organization's, which GitHub's own settings may not offer.
        <div className="mt-2">
          <button type="button" className={button} disabled={busy} onClick={onInstall}>
            {t("Add repositories on GitHub")}
          </button>
        </div>
      )}
      {c.status === "needs_reconnect" &&
        (c.signIn ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <p className="text-xs text-amber-300">{t("Its sign-in stopped working. Reconnect to use it again.")}</p>
            <button type="button" className={primary} disabled={busy} onClick={onReconnect}>
              {t("Reconnect")}
            </button>
          </div>
        ) : (
          <p className="mt-2 text-xs text-amber-300">{t("Its key stopped working. Remove this account, then add it again with a new key.")}</p>
        ))}
      {review && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <p className="text-xs text-amber-200">
            {t("This server receives what Claude sends to its tools.")} {t("Look at its tools, then add it.")}
          </p>
          <button type="button" className={primary} disabled={busy} onClick={onConfirm}>
            {t("Add connector")}
          </button>
        </div>
      )}
      {c.files && <DriveFiles connectionId={c.id} files={c.files} usable={c.status === "ok"} busy={busy} onFiles={onFiles} />}
      <details className="mt-3" open={review}>
        <summary className="cursor-pointer text-xs text-zinc-400 hover:text-zinc-200">{t("Tools ({count})", { count: c.tools.length })}</summary>
        <ul className="mt-2 divide-y divide-white/6">
          {c.tools.map((tool) => (
            <ToolRow
              key={tool.name}
              tool={tool}
              connectionId={c.id}
              custom={c.custom}
              busy={busy}
              onChange={(change) => onChange({ tool: tool.name, ...change })}
            />
          ))}
        </ul>
      </details>
    </li>
  );
}

/** What a tool does before it runs: a read runs by itself; anything else waits for the user. */
function kindText(kind: ToolKind, custom: boolean, t: ReturnType<typeof useT>) {
  if (custom) return t("Asks you each time");
  return kind === "read" ? t("Reads, runs by itself") : t("Asks you first");
}

function ToolRow({
  tool,
  connectionId,
  custom,
  busy,
  onChange,
}: {
  tool: ToolView;
  connectionId: string;
  custom: boolean;
  busy: boolean;
  onChange: (change: Omit<Change, "tool">) => void;
}) {
  const t = useT();
  // A changed tool as its server lists it now (null: it no longer has it), read before it's used again.
  const [now, setNow] = useState<ToolPreview | null | undefined>(undefined);
  const [looking, setLooking] = useState(false);
  const [lookError, setLookError] = useState("");
  async function look() {
    setLooking(true);
    setLookError("");
    try {
      const { tool: live } = await api<{ tool: ToolPreview | null }>(`/api/connect/${connectionId}?tool=${encodeURIComponent(tool.name)}`);
      setNow(live);
    } catch (e) {
      setLookError(e instanceof Error ? e.message : t("Something went wrong. Please try again."));
    }
    setLooking(false);
  }
  return (
    <li className="flex items-start gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        {/* A title and description Flash wrote itself (GitHub's and Google Drive's tools) are shown in the user's language; any other is the server's own. */}
        <p className="text-sm text-zinc-200">
          {toolWords(t, tool.title)} <span className={hint}>· {tool.trusted ? t("Always allowed") : kindText(tool.kind, custom, t)}</span>
        </p>
        {tool.description && <p className={`mt-0.5 line-clamp-3 ${hint}`}>{toolWords(t, tool.description)}</p>}
        {tool.changed ? (
          <div className="mt-1 text-xs">
            <p className="text-amber-300">
              {t("Its server changed this tool since you added it, so Flash leaves it out.")}{" "}
              {now === undefined && (
                <button type="button" disabled={busy || looking} onClick={look} className="underline underline-offset-2 hover:text-amber-200">
                  {looking ? t("Looking…") : t("See what changed")}
                </button>
              )}
            </p>
            {now === null && (
              <p className="mt-1.5 text-zinc-400">
                {t("Its server no longer has this tool.")}{" "}
                <button type="button" disabled={busy} onClick={() => onChange({ review: true })} className="underline underline-offset-2 hover:text-zinc-200">
                  {t("Remove it")}
                </button>
              </p>
            )}
            {now && (
              <div className="mt-1.5 rounded-lg bg-white/[0.03] p-2.5">
                <p className="text-zinc-500">{t("What it says now")}</p>
                <p dir="auto" className="mt-0.5 whitespace-pre-wrap break-words text-zinc-200">
                  {toolWords(t, now.description)}
                </p>
                <p className="mt-1 text-zinc-500">{kindText(now.kind, custom, t)}</p>
                <button type="button" disabled={busy} onClick={() => onChange({ review: true, hash: now.hash })} className={`mt-2 ${button}`}>
                  {t("Use the new version")}
                </button>
              </div>
            )}
            {lookError && (
              <p role="alert" className="mt-1 text-red-400">
                {lookError}
              </p>
            )}
          </div>
        ) : (
          custom && (
            <label className="mt-1 inline-flex items-center gap-2 text-xs text-zinc-400">
              <input type="checkbox" checked={tool.trusted} disabled={busy} onChange={(e) => onChange({ trusted: e.target.checked })} className="accent-primary" />
              {t("Always allow this tool")}
            </label>
          )
        )}
      </div>
      <Switch on={tool.enabled} disabled={busy} name={t("Use {tool}", { tool: toolWords(t, tool.title) })} onChange={(enabled) => onChange({ enabled })} />
    </li>
  );
}

type Adding = {
  busy: boolean;
  attempt: (work: () => Promise<void>) => Promise<void>;
  onAdded: (connection: ConnectionView) => void;
  onCancel: () => void;
};

/**
 * A ready-made service: Connect signs in on the service's own page; a service that takes a key
 * instead (or also, under "Use a key instead") takes it here, with a link to where to make one.
 */
function AddPreset({ preset, busy, attempt, onAdded, onCancel }: Adding & { preset: Preset }) {
  const t = useT();
  const [token, setToken] = useState("");
  const [withKey, setWithKey] = useState(!preset.signIn);
  const host = new URL(preset.url).host;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    attempt(async () => {
      const { connection } = await api<{ connection: ConnectionView }>("/api/connect", { method: "POST", json: { action: "add", provider: preset.id, token } });
      onAdded(connection);
    });
  };
  const heading = (
    <div className="flex items-center gap-3">
      <ConnectorTile provider={preset.id} name={preset.name} />
      <div className="min-w-0">
        <p className="text-sm text-zinc-100">{preset.name}</p>
        <p className={hint}>{t(preset.blurb)}</p>
      </div>
    </div>
  );
  const note = preset.note && <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">{t(preset.note)}</p>;
  if (!withKey || !preset.keyName) {
    return (
      <div className="flex flex-col gap-3 rounded-xl border border-zinc-800 p-4">
        {heading}
        {note}
        <p className={hint}>{t("You sign in at {name}. Flash never sees your password.", { name: preset.name })}</p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={primary} disabled={busy} onClick={() => attempt(() => signIn({ provider: preset.id }, preset.id))}>
            {busy ? t("Connecting…") : t("Connect")}
          </button>
          <button type="button" className={button} onClick={onCancel}>
            {t("Cancel")}
          </button>
          {preset.keyName && (
            <button type="button" className="ms-auto text-xs text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline" onClick={() => setWithKey(true)}>
              {t("Use a key instead")}
            </button>
          )}
        </div>
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-xl border border-zinc-800 p-4">
      {heading}
      {note}
      <label className={label}>
        {t(preset.keyName)}
        <PasswordInput
          secret
          autoComplete="off"
          value={token}
          onValue={setToken}
          required
          dir="ltr"
          wrapClassName="mt-1"
          className={fieldBox}
        />
      </label>
      <p className={hint}>
        {t("Flash keeps it encrypted, sends it only to {host}, and never shows it again.", { host })}{" "}
        <a href={preset.help} target="_blank" rel="noreferrer" className="text-primary-soft underline-offset-2 hover:underline">
          {t("Where to make one")}
        </a>
      </p>
      <div className="flex gap-2">
        <button type="submit" className={primary} disabled={busy || !token.trim()}>
          {busy ? t("Connecting…") : t("Connect")}
        </button>
        <button type="button" className={button} onClick={preset.signIn ? () => setWithKey(false) : onCancel}>
          {preset.signIn ? t("Back") : t("Cancel")}
        </button>
      </div>
    </form>
  );
}

/**
 * A server of the user's own: its address and key (or none), then its host and every tool, before
 * anything is saved. It's added with the tools exactly as shown (see addConnection).
 */
function AddCustom({ busy, attempt, onAdded, onCancel }: Adding) {
  const t = useT();
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  // For a server Flash can't register with: a client the user made there (theirs alone, never shared).
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const input = { provider: "custom", url: url.trim(), token: token.trim(), label: name.trim() };
  const look = (e: FormEvent) => {
    e.preventDefault();
    attempt(async () => setPreview(await api<Preview>("/api/connect", { method: "POST", json: { action: "preview", ...input } })));
  };
  if (preview?.signIn) {
    const needsClient = preview.signIn.needsClient;
    return (
      <div className="flex flex-col gap-3 rounded-xl border border-zinc-800 p-4">
        <p className={hint}>{t("Flash will connect to")}</p>
        <p dir="ltr" className="break-all text-start text-2xl font-semibold text-zinc-100">
          {preview.host}
        </p>
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          {t("This server receives what Claude sends to its tools.")} {t("Each tool asks you before it runs, until you choose Always allow for it.")}
        </p>
        <p className={hint}>
          {t("You sign in at {name}. Flash never sees your password.", { name: preview.signIn.authHost })}
        </p>
        <details open={needsClient} className="rounded-lg bg-white/[0.03] p-3">
          <summary className="cursor-pointer text-sm text-zinc-300">{t("Advanced")}</summary>
          {needsClient && <p className="mt-2 text-sm text-amber-200">{t("This server needs a client ID from its own settings. Fill it in under Advanced.")}</p>}
          <p className={`mt-2 ${hint}`}>{t("Only for a server that doesn't let Flash register itself: make a client there with this redirect address.")}</p>
          <p dir="ltr" className="mt-1 select-all break-all rounded bg-zinc-900 px-2 py-1 font-mono text-xs text-zinc-300">
            {preview.signIn.callback}
          </p>
          <label className={`mt-2 ${label}`}>
            {t("Client ID")}
            <input autoComplete="off" spellCheck={false} value={clientId} onChange={(e) => setClientId(e.target.value)} dir="ltr" className={field} />
          </label>
          <label className={`mt-2 ${label}`}>
            {t("Client secret (optional)")}
            <PasswordInput secret autoComplete="off" value={clientSecret} onValue={setClientSecret} dir="ltr" wrapClassName="mt-1" className={fieldBox} />
          </label>
        </details>
        <div className="flex gap-2">
          <button
            type="button"
            className={primary}
            disabled={busy || (needsClient && !clientId.trim())}
            onClick={() => attempt(() => signIn({ provider: "custom", url: input.url, label: input.label, clientId: clientId.trim(), clientSecret: clientSecret.trim() }))}
          >
            {busy ? t("Connecting…") : t("Sign in")}
          </button>
          <button type="button" className={button} onClick={() => setPreview(null)}>
            {t("Back")}
          </button>
        </div>
      </div>
    );
  }
  const add = () =>
    attempt(async () => {
      const pins = Object.fromEntries(preview!.tools.map((tool) => [tool.name, tool.hash]));
      const { connection } = await api<{ connection: ConnectionView }>("/api/connect", { method: "POST", json: { action: "add", ...input, pins } });
      onAdded(connection);
    });
  if (preview) {
    return (
      <div className="flex flex-col gap-3 rounded-xl border border-zinc-800 p-4">
        <p className={hint}>{t("Flash will connect to")}</p>
        <p dir="ltr" className="break-all text-start text-2xl font-semibold text-zinc-100">
          {preview.host}
        </p>
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          {t("This server receives what Claude sends to its tools.")} {t("Each tool asks you before it runs, until you choose Always allow for it.")}
        </p>
        <p className="text-sm text-zinc-300">{t("Tools ({count})", { count: preview.tools.length })}</p>
        <ul className="max-h-72 divide-y divide-white/6 overflow-y-auto">
          {preview.tools.map((tool) => (
            <li key={tool.name} className="py-2">
              <p className="text-sm text-zinc-200">{tool.title}</p>
              {tool.description && <p className={`mt-0.5 whitespace-pre-line ${hint}`}>{tool.description}</p>}
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <button type="button" className={primary} disabled={busy} onClick={add}>
            {t("Add connector")}
          </button>
          <button type="button" className={button} onClick={() => setPreview(null)}>
            {t("Back")}
          </button>
        </div>
      </div>
    );
  }
  return (
    <form onSubmit={look} className="flex flex-col gap-3 rounded-xl border border-zinc-800 p-4">
      <p className="text-sm text-zinc-100">{t("Add your own connector")}</p>
      <label className={label}>
        {t("Server address")}
        <input type="url" inputMode="url" required placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} dir="ltr" className={field} />
      </label>
      <label className={label}>
        {t("Key or token (leave empty if it needs no sign-in)")}
        <PasswordInput secret autoComplete="off" value={token} onValue={setToken} dir="ltr" wrapClassName="mt-1" className={fieldBox} />
      </label>
      <label className={label}>
        {t("Name (optional)")}
        <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} className={field} />
      </label>
      <div className="flex gap-2">
        <button type="submit" className={primary} disabled={busy || !url.trim()}>
          {busy ? t("Looking…") : t("Look at its tools")}
        </button>
        <button type="button" className={button} onClick={onCancel}>
          {t("Cancel")}
        </button>
      </div>
    </form>
  );
}
