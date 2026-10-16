"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/store";
import { MAX_NAME, MAX_NOTES, MAX_STAGES, MAX_STAGE_NAME, cleanName, cleanTags, contactMatches, sourceLabel } from "@/lib/contacts";
import { useT, type T } from "@/lib/use-t";

// One app's contact list (see server/contacts.ts), in My websites & apps › Contacts.
type Stage = { id: string; name: string };
type Contact = {
  id: string;
  email: string;
  phone: string;
  name: string;
  stage: string;
  tags: string[];
  notes: string;
  source: string;
  firstSeen: number;
  lastSeen: number;
  consent: { text: string; at: number; form: string } | null;
  unsubscribedAt: number;
  subscribed: boolean;
};
// everything: the whole list came at once, so this page searches it and lays out the board itself.
type List = { contacts: Contact[]; total: number; byStage: Record<string, number>; matched?: number; stages: Stage[]; max: number; everything: boolean };
type Detail = {
  contact: Contact;
  member: { joined: number } | null;
  messages: { id: string; form: string; data: Record<string, unknown>; createdAt: number }[];
  messageCount: number;
  orders: { id: string; item: string; quantity: number; total: string; createdAt: number; done: boolean }[];
  orderCount: number;
  unsubscribeLink: string;
};
type Mode = "board" | "list";
type Screen = { kind: "all" } | { kind: "detail"; id: string } | { kind: "add" } | { kind: "stages" };
// A stage being edited; key keeps its row while it moves, and id is "" for a new one.
type DraftStage = { key: number; id: string; name: string };

const MODE_KEY = "flash-contacts-mode";
const dateLabel = (when: number, locale: string) =>
  new Date(when).toLocaleString(locale, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const dayLabel = (when: number, locale: string) =>
  new Date(when).toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    ...(new Date(when).getFullYear() !== new Date().getFullYear() && { year: "numeric" }),
  });
const fieldText = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
const shownName = (c: Contact) => c.name || c.email || c.phone;
const input = "h-10 min-w-0 rounded-lg border border-white/10 bg-white/[0.03] px-3 text-sm text-zinc-200 outline-none focus:border-primary/70";
const chip = "rounded-full border px-2 py-0.5 text-[11px]";
const textButton = "text-xs text-zinc-300 hover:text-white disabled:opacity-50";
const primary = "h-10 shrink-0 rounded-lg bg-brand px-4 text-sm font-medium text-on-brand transition hover:brightness-110 disabled:opacity-50";

/** Saves a file the server sent (a CSV or JSON download) under the name it gave. */
async function download(url: string, fallback: string): Promise<{ included: number; total: number }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error();
  const name = res.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? fallback;
  const [included, total] = (res.headers.get("x-flash-truncated") ?? "").split("/").map(Number);
  const href = URL.createObjectURL(await res.blob());
  Object.assign(document.createElement("a"), { href, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
  return { included: included || 0, total: total || 0 };
}

/** Whether they agreed to news, or unsubscribed since, as a small label. */
function NewsChip({ c, t }: { c: Contact; t: T }) {
  if (c.subscribed) return <span className={`${chip} border-primary/40 text-primary-soft`}>{t("Agreed to news")}</span>;
  if (c.unsubscribedAt) return <span className={`${chip} border-gold/40 text-gold-soft`}>{t("Unsubscribed")}</span>;
  return null;
}

/**
 * An app's contacts: everyone who sent its forms, signed up or paid, as a board of the owner's own
 * stages (or a list), with search, each person's details, notes and tags, and downloads. onCount
 * tells My websites & apps how many there are now.
 */
export function ContactsView({ slug, onCount }: { slug: string; onCount: (count: number) => void }) {
  const t = useT();
  const [mode, setMode] = useState<Mode>(() => {
    try {
      return typeof window !== "undefined" && localStorage.getItem(MODE_KEY) === "list" ? "list" : "board";
    } catch {
      return "board";
    }
  });
  const [list, setList] = useState<List | null>(null);
  const [q, setQ] = useState("");
  // What the server found for the search, when the list is too big to search here.
  const [found, setFound] = useState<{ q: string; contacts: Contact[]; matched: number } | null>(null);
  const [screen, setScreen] = useState<Screen>({ kind: "all" });
  const [phoneStage, setPhoneStage] = useState("");
  const [dropOn, setDropOn] = useState("");
  const [error, setError] = useState("");
  const [cut, setCut] = useState("");
  const loads = useRef(0);
  const onCountRef = useRef(onCount);
  useEffect(() => {
    onCountRef.current = onCount;
  }, [onCount]);

  /** Loads the list again (the board or the list, when it's too big to come at once). Only the latest load shows. */
  function load(how: Mode = mode) {
    const asked = ++loads.current;
    return api<List>(`/api/sites/${slug}/contacts?mode=${how}`).then(
      (loaded) => {
        if (asked !== loads.current) return;
        setList(loaded);
        setError("");
        onCountRef.current(loaded.total);
      },
      (err) => {
        if (asked === loads.current) setError(err instanceof Error && err.message ? err.message : t("Couldn't load the contacts. Please try again."));
      },
    );
  }

  useEffect(() => {
    void load();
    // Loaded once for this app; the board/list switch and changes load again themselves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  // A big list is searched by the server, a moment after typing stops.
  const words = q.trim();
  const serverSearch = Boolean(list && !list.everything && words);
  useEffect(() => {
    if (!serverSearch) return;
    const timer = setTimeout(async () => {
      try {
        const result = await api<List>(`/api/sites/${slug}/contacts?q=${encodeURIComponent(words)}`);
        setFound({ q: words, contacts: result.contacts, matched: result.matched ?? result.contacts.length });
      } catch (err) {
        setError(err instanceof Error && err.message ? err.message : t("Couldn't load the contacts. Please try again."));
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [serverSearch, words, slug, t]);

  function chooseMode(next: Mode) {
    setMode(next);
    try {
      localStorage.setItem(MODE_KEY, next);
    } catch {}
    if (list && !list.everything) void load(next);
  }

  /** Changes one contact everywhere it's shown. */
  function changeShown(id: string, change: (c: Contact) => Contact) {
    setList((l) => l && { ...l, contacts: l.contacts.map((c) => (c.id === id ? change(c) : c)) });
    setFound((f) => f && { ...f, contacts: f.contacts.map((c) => (c.id === id ? change(c) : c)) });
  }

  /** Moves someone to another stage: at once on screen, and back if it can't be saved. */
  async function move(id: string, stage: string) {
    const c = list?.contacts.find((x) => x.id === id) ?? found?.contacts.find((x) => x.id === id);
    if (!c || c.stage === stage) return;
    const from = c.stage;
    const shift = (l: List, a: string, b: string) => ({ ...l, byStage: { ...l.byStage, [a]: (l.byStage[a] ?? 1) - 1, [b]: (l.byStage[b] ?? 0) + 1 } });
    changeShown(id, (x) => ({ ...x, stage }));
    setList((l) => l && shift(l, from, stage));
    try {
      await api(`/api/sites/${slug}/contacts`, { method: "PATCH", json: { id, stage } });
    } catch {
      changeShown(id, (x) => ({ ...x, stage: from }));
      setList((l) => l && shift(l, stage, from));
      setError(t("Couldn't save that contact. Please try again."));
    }
  }

  async function downloadAll() {
    setError("");
    try {
      const { included, total } = await download(`/api/sites/${slug}/contacts?format=csv`, "contacts.csv");
      setCut(
        total
          ? t("Your download has the newest {included} of {total} contacts (the file limit is 4 MB).", {
              included: included.toLocaleString(t.locale),
              total: total.toLocaleString(t.locale),
            })
          : "",
      );
    } catch {
      setError(t("Couldn't load the contacts. Please try again."));
    }
  }

  const back = () => {
    setScreen({ kind: "all" });
    void load();
  };

  if (!list) return error ? <p role="alert" className="text-sm text-red-400">{error}</p> : <p className="text-sm text-zinc-500">{t("Loading…")}</p>;
  const { stages } = list;
  const stageName = (id: string) => stages.find((s) => s.id === id)?.name ?? stages[0].name;
  const alert = error && <p role="alert" className="mb-3 text-sm text-red-400">{error}</p>;

  if (screen.kind === "detail") {
    return (
      <>
        {alert}
        <ContactDetails
          key={screen.id}
          slug={slug}
          id={screen.id}
          stages={stages}
          onBack={back}
          onSaved={(c) => changeShown(c.id, () => c)}
          onError={setError}
        />
      </>
    );
  }
  if (screen.kind === "add") {
    return (
      <>
        {alert}
        <AddContact slug={slug} onCancel={() => setScreen({ kind: "all" })} onAdded={(id) => setScreen({ kind: "detail", id })} />
      </>
    );
  }
  if (screen.kind === "stages") {
    return (
      <>
        {alert}
        <StageEditor
          slug={slug}
          stages={stages}
          onCancel={() => setScreen({ kind: "all" })}
          onSaved={() => {
            setPhoneStage("");
            back();
          }}
        />
      </>
    );
  }

  const searching = words !== "";
  const shown = !searching ? list.contacts : list.everything ? list.contacts.filter((c) => contactMatches(c, words)) : found?.q === words ? found.contacts : null;
  const matched = !searching ? list.total : list.everything ? (shown?.length ?? 0) : found?.q === words ? found.matched : null;
  const chosenStage = stages.some((s) => s.id === phoneStage) ? phoneStage : stages[0].id;
  const inStage = (id: string) => (shown ?? []).filter((c) => c.stage === id);
  const stageCount = (id: string) => (searching ? inStage(id).length : (list.byStage[id] ?? 0));
  const open = (id: string) => setScreen({ kind: "detail", id });

  const card = (c: Contact) => (
    <li
      key={c.id}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", c.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragEnd={() => setDropOn("")}
      className="rounded-xl border border-white/8 bg-white/[0.02] px-3 py-2 text-sm"
    >
      <button onClick={() => open(c.id)} className="block w-full min-w-0 text-start">
        <span className="block truncate text-zinc-100" dir="auto">
          {shownName(c)}
        </span>
        <span className="mt-0.5 block truncate text-xs text-zinc-500">
          {sourceLabel(c.source, t)} · {t("Last seen {date}", { date: dayLabel(c.lastSeen, t.locale) })}
        </span>
      </button>
      {(c.tags.length > 0 || c.subscribed || c.unsubscribedAt > 0) && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {c.tags.slice(0, 3).map((tag) => (
            <span key={tag} className={`${chip} max-w-full truncate border-white/10 text-zinc-300`}>
              {tag}
            </span>
          ))}
          <NewsChip c={c} t={t} />
        </div>
      )}
      <select
        value={c.stage}
        onChange={(e) => move(c.id, e.target.value)}
        aria-label={t("Stage")}
        className="mt-2 h-8 w-full rounded-md border border-white/10 bg-zinc-900 px-1.5 text-xs text-zinc-300 outline-none focus:border-primary/70"
      >
        {stages.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </li>
  );

  return (
    <div className="space-y-3">
      {alert}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-full border border-white/10 p-0.5 text-xs" role="group">
          {(["board", "list"] as const).map((m) => (
            <button
              key={m}
              onClick={() => chooseMode(m)}
              aria-pressed={mode === m}
              className={`rounded-full px-3 py-1 ${mode === m ? "bg-white/10 text-zinc-100" : "text-zinc-400 hover:text-zinc-100"}`}
            >
              {m === "board" ? t("Board") : t("List")}
            </button>
          ))}
        </div>
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          maxLength={80}
          placeholder={t("Search name, email, phone, tags or notes")}
          aria-label={t("Search name, email, phone, tags or notes")}
          className={`${input} h-9 min-w-0 flex-1 basis-full sm:basis-auto`}
        />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <button onClick={() => setScreen({ kind: "add" })} className={textButton}>
            + {t("Add contact")}
          </button>
          <button onClick={() => setScreen({ kind: "stages" })} className={textButton}>
            {t("Edit stages")}
          </button>
          {list.total > 0 && (
            <button onClick={downloadAll} className="text-xs text-primary-soft hover:underline">
              ⬇ {t("Download all (CSV)")}
            </button>
          )}
        </div>
      </div>
      {cut && <p className="text-xs text-gold-soft">{cut}</p>}
      <p className="text-xs text-zinc-500">
        {searching
          ? matched === null
            ? t("Loading…")
            : t("{shown} of {count} contacts match", { shown: matched.toLocaleString(t.locale), count: list.total.toLocaleString(t.locale) })
          : list.total === 1
            ? t("1 contact")
            : t("{count} contacts", { count: list.total.toLocaleString(t.locale) })}
      </p>
      {list.total >= list.max && (
        <p className="text-xs text-gold-soft">
          {t("This app has {count} contacts, the most it can keep. New people aren't added until you delete some.", { count: list.max.toLocaleString(t.locale) })}
        </p>
      )}
      {list.total === 0 ? (
        <p className="mx-auto mt-12 max-w-sm text-center text-sm text-zinc-500">
          {t("No contacts yet. People who send a form, sign up or pay on this app show up here.")}
        </p>
      ) : shown === null ? null : mode === "list" ? (
        <ul className="space-y-2">
          {shown.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-white/8 bg-white/[0.02] px-4 py-3 text-sm">
              <button onClick={() => open(c.id)} className="min-w-0 flex-[1_1_12rem] text-start">
                <span className="block truncate text-zinc-100" dir="auto">
                  {shownName(c)}
                </span>
                {c.name && <span className="block truncate text-xs text-zinc-500">{c.email || c.phone}</span>}
              </button>
              <span className={`${chip} border-white/10 bg-white/[0.06] text-zinc-200`}>{stageName(c.stage)}</span>
              {c.tags.slice(0, 3).map((tag) => (
                <button key={tag} onClick={() => setQ(tag)} className={`${chip} max-w-[10rem] truncate border-white/10 text-zinc-400 hover:text-zinc-100`}>
                  {tag}
                </button>
              ))}
              <NewsChip c={c} t={t} />
              <span className="text-xs text-zinc-500">{t("Last seen {date}", { date: dayLabel(c.lastSeen, t.locale) })}</span>
            </li>
          ))}
        </ul>
      ) : (
        <>
          <div className="flex flex-wrap gap-2 sm:hidden">
            {stages.map((s) => (
              <button
                key={s.id}
                onClick={() => setPhoneStage(s.id)}
                aria-pressed={s.id === chosenStage}
                className={`rounded-full border border-white/10 px-2.5 py-1 text-xs ${s.id === chosenStage ? "bg-white/10 text-zinc-100" : "text-zinc-400"}`}
              >
                {s.name} · {stageCount(s.id).toLocaleString(t.locale)}
              </button>
            ))}
          </div>
          <p className="hidden text-xs text-zinc-500 sm:block">{t("Drag a card to another stage, or pick its stage on the card.")}</p>
          <div className="sm:flex sm:gap-3 sm:overflow-x-auto sm:pb-2">
            {stages.map((s) => {
              const cards = inStage(s.id);
              const more = searching ? 0 : stageCount(s.id) - cards.length;
              return (
                <section
                  key={s.id}
                  aria-label={s.name}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDropOn(s.id);
                  }}
                  onDragLeave={() => setDropOn((d) => (d === s.id ? "" : d))}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDropOn("");
                    const id = e.dataTransfer.getData("text/plain");
                    if (id) void move(id, s.id);
                  }}
                  className={`${s.id === chosenStage ? "" : "hidden"} min-w-0 sm:block sm:max-w-80 sm:min-w-56 sm:flex-1 sm:basis-0 sm:rounded-xl sm:p-2 ${dropOn === s.id ? "sm:bg-white/[0.05] sm:ring-1 sm:ring-primary/50" : "sm:bg-white/[0.015]"}`}
                >
                  <h3 className="mb-2 hidden items-center gap-2 px-1 text-xs font-medium text-zinc-300 sm:flex">
                    <span className="min-w-0 flex-1 truncate">{s.name}</span>
                    <span className="tabular-nums text-zinc-500">{stageCount(s.id).toLocaleString(t.locale)}</span>
                  </h3>
                  <ul className="space-y-2">{cards.map(card)}</ul>
                  {more > 0 && <p className="mt-2 px-1 text-xs text-zinc-500">{t("{count} more. Search to find them.", { count: more.toLocaleString(t.locale) })}</p>}
                </section>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/** One person: how to reach them, what Flash knows, the owner's own name, stage, tags and notes, and their export or deletion. */
function ContactDetails({
  slug,
  id,
  stages,
  onBack,
  onSaved,
  onError,
}: {
  slug: string;
  id: string;
  stages: Stage[];
  onBack: () => void;
  onSaved: (c: Contact) => void;
  onError: (error: string) => void;
}) {
  const t = useT();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [form, setForm] = useState({ name: "", stage: "", tags: "", notes: "" });
  const [saving, setSaving] = useState<"" | "saving" | "saved">("");
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api<Detail>(`/api/sites/${slug}/contacts?id=${encodeURIComponent(id)}`)
      .then((d) => {
        if (!live) return;
        setDetail(d);
        setForm({ name: d.contact.name, stage: d.contact.stage, tags: d.contact.tags.join(", "), notes: d.contact.notes });
      })
      .catch((err) => live && onError(err instanceof Error && err.message ? err.message : t("Couldn't load the contacts. Please try again.")));
    return () => {
      live = false;
    };
  }, [slug, id, t, onError]);

  const backButton = (
    <button onClick={onBack} className="text-xs text-zinc-400 hover:text-zinc-100">
      <span className="inline-block rtl:-scale-x-100" aria-hidden>
        ←
      </span>{" "}
      {t("All contacts")}
    </button>
  );
  if (!detail) return <div className="space-y-3">{backButton}<p className="text-sm text-zinc-500">{t("Loading…")}</p></div>;
  const c = detail.contact;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving("saving");
    onError("");
    // Cleaned as the server cleans them, so what shows is what was saved.
    const tags = cleanTags(form.tags);
    try {
      await api(`/api/sites/${slug}/contacts`, { method: "PATCH", json: { id, name: form.name, stage: form.stage, tags, notes: form.notes } });
      const saved = { ...c, name: cleanName(form.name), stage: form.stage, tags, notes: form.notes.trim() };
      setForm((f) => ({ ...f, name: saved.name, tags: tags.join(", "), notes: saved.notes }));
      setDetail((d) => d && { ...d, contact: saved });
      onSaved(saved);
      setSaving("saved");
    } catch (err) {
      setSaving("");
      onError(err instanceof Error && err.message ? err.message : t("Couldn't save that contact. Please try again."));
    }
  }

  async function remove() {
    setBusy(true);
    onError("");
    try {
      await api(`/api/sites/${slug}/contacts?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      onBack();
    } catch {
      setBusy(false);
      onError(t("Couldn't delete that contact. Please try again."));
    }
  }

  async function exportOne() {
    onError("");
    try {
      await download(`/api/sites/${slug}/contacts?id=${encodeURIComponent(id)}&format=json`, "contact.json");
    } catch {
      onError(t("Couldn't load the contacts. Please try again."));
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(detail!.unsubscribeLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt(t("Copy unsubscribe link"), detail!.unsubscribeLink);
    }
  }

  const field = "block text-xs text-zinc-400";
  const fact = "text-xs text-zinc-500";
  return (
    <div className="space-y-5">
      {backButton}
      <div className="min-w-0">
        <h3 className="break-words text-lg font-medium text-zinc-100" dir="auto">
          {shownName(c)}
        </h3>
        <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {c.email && (
            <a href={`mailto:${c.email}`} className="min-w-0 break-all text-primary-soft hover:underline">
              {c.email}
            </a>
          )}
          {c.phone && (
            <a href={`tel:${c.phone}`} className="text-primary-soft hover:underline">
              {c.phone}
            </a>
          )}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className={`${chip} border-white/10 text-zinc-300`}>{sourceLabel(c.source, t)}</span>
          <span className={fact}>{t("First seen {date}", { date: dateLabel(c.firstSeen, t.locale) })}</span>
          <span className={fact}>{t("Last seen {date}", { date: dateLabel(c.lastSeen, t.locale) })}</span>
          {detail.member && <span className={fact}>{t("Joined {date}", { date: dateLabel(detail.member.joined, t.locale) })}</span>}
        </div>
        <div className="mt-2 space-y-1 text-xs">
          {c.consent ? (
            <>
              <p className="text-zinc-300">{t("Agreed to news by email on {date}", { date: dateLabel(c.consent.at, t.locale) })}</p>
              <p className="break-words text-zinc-500">{t.node("Wording they saw: {text}", { text: <q><bdi>{c.consent.text}</bdi></q> })}</p>
            </>
          ) : (
            <p className="text-zinc-500">{t("Hasn't agreed to news")}</p>
          )}
          {c.unsubscribedAt > 0 && !c.subscribed && (
            <p className="text-gold-soft">{t("Unsubscribed on {date}: don't send them news or offers.", { date: dateLabel(c.unsubscribedAt, t.locale) })}</p>
          )}
        </div>
      </div>

      <form onSubmit={save} className="space-y-3 rounded-xl border border-white/8 bg-white/[0.02] p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={field}>
            {t("Name")}
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              maxLength={MAX_NAME}
              className={`${input} mt-1 w-full`}
            />
          </label>
          <label className={field}>
            {t("Stage")}
            <select
              value={form.stage}
              onChange={(e) => setForm({ ...form, stage: e.target.value })}
              className="mt-1 h-10 w-full rounded-lg border border-white/10 bg-zinc-900 px-2 text-sm text-zinc-200 outline-none focus:border-primary/70"
            >
              {stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className={field}>
          {t("Tags")}
          <input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} maxLength={400} className={`${input} mt-1 w-full`} />
          <span className="mt-1 block text-zinc-500">{t("Separate tags with commas")}</span>
        </label>
        <label className={field}>
          {t("Notes")}
          <textarea
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            maxLength={MAX_NOTES}
            rows={4}
            className="mt-1 block w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-zinc-200 outline-none focus:border-primary/70"
          />
        </label>
        <div className="flex items-center gap-3">
          <button disabled={saving === "saving"} className={primary}>
            {saving === "saving" ? t("Saving…") : t("Save")}
          </button>
          {saving === "saved" && (
            <span role="status" className="text-xs text-primary-soft">
              ✓ {t("Saved")}
            </span>
          )}
        </div>
      </form>

      {detail.messages.length > 0 && (
        <section>
          <h4 className="mb-2 text-sm font-medium text-zinc-200">
            {t("Messages")}
            {detail.messageCount > detail.messages.length && (
              <span className="ms-2 text-xs font-normal text-zinc-500">{t("{count} more", { count: detail.messageCount - detail.messages.length })}</span>
            )}
          </h4>
          <ul className="space-y-2">
            {detail.messages.map((m) => (
              <li key={m.id} className="rounded-xl border border-white/8 bg-white/[0.02] p-3">
                <div className="mb-1.5 flex items-center gap-2 text-xs text-zinc-500">
                  <span className={`${chip} border-white/10 text-zinc-300`}>{m.form}</span>
                  <span className="ms-auto">{dateLabel(m.createdAt, t.locale)}</span>
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                  {Object.entries(m.data).map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-zinc-500">{k}</dt>
                      <dd dir="auto" className="min-w-0 whitespace-pre-wrap break-words text-zinc-200">
                        {fieldText(v)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
        </section>
      )}

      {detail.orders.length > 0 && (
        <section>
          <h4 className="mb-2 text-sm font-medium text-zinc-200">
            {t("Orders")}
            {detail.orderCount > detail.orders.length && (
              <span className="ms-2 text-xs font-normal text-zinc-500">{t("{count} more", { count: detail.orderCount - detail.orders.length })}</span>
            )}
          </h4>
          <ul className="divide-y divide-white/6 rounded-xl border border-white/8">
            {detail.orders.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                <span className="min-w-0 flex-1 truncate text-zinc-100">
                  {o.quantity} × {o.item}
                </span>
                <span className="tabular-nums text-primary-soft">{o.total}</span>
                <span className="text-xs text-zinc-500">{dateLabel(o.createdAt, t.locale)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {detail.unsubscribeLink && (
        <section className="rounded-xl border border-white/8 bg-white/[0.02] px-4 py-3 text-sm">
          <button onClick={copy} className="text-primary-soft hover:underline">
            {copied ? <>✓ {t("Copied")}</> : t("Copy unsubscribe link")}
          </button>
          <p className="mt-1 text-xs text-zinc-500">{t("Put this link in emails you send them. If they use it, they show as unsubscribed here.")}</p>
        </section>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-white/6 pt-4 text-xs">
        <button onClick={exportOne} className="text-primary-soft hover:underline">
          ⬇ {t("Export (JSON)")}
        </button>
        {confirming ? (
          <div className="basis-full space-y-2 rounded-xl border border-red-400/30 p-3">
            <p className="text-zinc-300">
              {t(
                "Delete {name}? Their messages, member account and private data go too. Their orders stay for your records without their name, email or address (Stripe keeps its own copy).",
                { name: shownName(c) },
              )}
            </p>
            <div className="flex gap-4">
              <button onClick={remove} disabled={busy} className="text-red-400 hover:text-red-300 disabled:opacity-50">
                {t("Delete")}
              </button>
              <button onClick={() => setConfirming(false)} className="text-zinc-400 hover:text-zinc-100">
                {t("Cancel")}
              </button>
            </div>
          </div>
        ) : (
          <button onClick={() => setConfirming(true)} className="text-zinc-500 hover:text-red-400">
            {t("Delete contact")}
          </button>
        )}
      </div>
    </div>
  );
}

/** The owner adds someone by hand. Someone already on the list opens as themselves. */
function AddContact({ slug, onCancel, onAdded }: { slug: string; onCancel: () => void; onAdded: (id: string) => void }) {
  const t = useT();
  const [form, setForm] = useState({ name: "", email: "", phone: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { id } = await api<{ id: string }>(`/api/sites/${slug}/contacts`, { method: "POST", json: form });
      onAdded(id);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t("Couldn't save that contact. Please try again."));
      setBusy(false);
    }
  }
  return (
    <form onSubmit={add} className="space-y-3">
      <h3 className="text-sm font-medium text-zinc-200">{t("Add contact")}</h3>
      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        {(
          [
            ["name", t("Name"), "text", "name"],
            ["email", t("Email"), "email", "email"],
            ["phone", t("Phone"), "tel", "tel"],
          ] as const
        ).map(([key, label, type, auto]) => (
          <label key={key} className="block text-xs text-zinc-400">
            {label}
            <input
              type={type}
              autoComplete={auto}
              value={form[key]}
              onChange={(e) => setForm({ ...form, [key]: e.target.value })}
              maxLength={key === "name" ? MAX_NAME : key === "email" ? 160 : 40}
              className={`${input} mt-1 w-full`}
            />
          </label>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <button disabled={busy || (!form.email.trim() && !form.phone.trim())} className={primary}>
          {t("Add")}
        </button>
        <button type="button" onClick={onCancel} className="text-sm text-zinc-400 hover:text-zinc-100">
          {t("Cancel")}
        </button>
      </div>
    </form>
  );
}

/** The owner renames, adds, removes and reorders their stages. */
function StageEditor({ slug, stages, onCancel, onSaved }: { slug: string; stages: Stage[]; onCancel: () => void; onSaved: () => void }) {
  const t = useT();
  const next = useRef(stages.length);
  const [draft, setDraft] = useState<DraftStage[]>(() => stages.map((s, key) => ({ key, id: s.id, name: s.name })));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const swap = (i: number, j: number) =>
    setDraft((d) => {
      const copy = [...d];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (draft.some((s) => !s.name.trim())) return setError(t("Give each stage a name."));
    setBusy(true);
    setError("");
    try {
      await api(`/api/sites/${slug}/contacts`, { method: "PUT", json: { stages: draft.map((s) => ({ ...(s.id && { id: s.id }), name: s.name })) } });
      onSaved();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t("Couldn't save the stages. Please try again."));
      setBusy(false);
    }
  }
  const small = "h-9 w-9 shrink-0 rounded-lg border border-white/10 text-sm text-zinc-300 hover:text-white disabled:opacity-30";
  return (
    <form onSubmit={save} className="space-y-3">
      <h3 className="text-sm font-medium text-zinc-200">{t("Edit stages")}</h3>
      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
      <ul className="space-y-2">
        {draft.map((s, i) => (
          <li key={s.key} className="flex items-center gap-2">
            <input
              value={s.name}
              onChange={(e) => setDraft((d) => d.map((x) => (x.key === s.key ? { ...x, name: e.target.value } : x)))}
              maxLength={MAX_STAGE_NAME}
              aria-label={t("Stage name")}
              className={`${input} h-9 flex-1`}
            />
            <button type="button" onClick={() => swap(i, i - 1)} disabled={i === 0} className={small} aria-label={t("Move up")} title={t("Move up")}>
              ↑
            </button>
            <button
              type="button"
              onClick={() => swap(i, i + 1)}
              disabled={i === draft.length - 1}
              className={small}
              aria-label={t("Move down")}
              title={t("Move down")}
            >
              ↓
            </button>
            <button
              type="button"
              onClick={() => setDraft((d) => d.filter((x) => x.key !== s.key))}
              disabled={draft.length === 1}
              className={`${small} hover:text-red-400`}
              aria-label={t("Remove")}
              title={t("Remove")}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => setDraft((d) => [...d, { key: next.current++, id: "", name: "" }])}
        disabled={draft.length >= MAX_STAGES}
        className={textButton}
      >
        + {t("Add a stage")}
      </button>
      <p className="text-xs text-zinc-500">{t("New people start in the first stage, and people in a removed stage move there.")}</p>
      <div className="flex items-center gap-3">
        <button disabled={busy} className={primary}>
          {busy ? t("Saving…") : t("Save")}
        </button>
        <button type="button" onClick={onCancel} className="text-sm text-zinc-400 hover:text-zinc-100">
          {t("Cancel")}
        </button>
      </div>
    </form>
  );
}
