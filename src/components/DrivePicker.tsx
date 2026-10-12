"use client";

import { useState } from "react";
import { api } from "@/lib/store";
import type { PickedFileView } from "@/lib/connectors";
import { useT } from "@/lib/use-t";

/*
 * The Google Drive files a user picked for Flash (Settings > Connectors, under their Google Drive
 * account): Flash can open these and no others (see google.ts). "Add from Drive" opens Google's own
 * Picker, which shows only Docs, Sheets, Slides, PDFs and text files; its script is loaded from
 * apis.google.com only then, never with the page. What it needs comes from POST
 * /api/connect/google/picker-token: the user's own short-lived Google token, the Picker's API key and
 * the Cloud project's number. They are kept only while the Picker is open, in pick()'s own variables
 * (never in the page's state, an address or storage). The ids picked go to Flash, which asks Google
 * about each one before it keeps it. In development with the stand-in (FLASH_CONNECT_MOCK), a plain
 * list of the stand-in's files takes the Picker's place, and holds the stand-in's token while it shows.
 */

type PickerAccess = { token: string; apiKey: string; appId: string; mock?: string };
type Added = { files: PickedFileView[]; added: number; refused: number };
type MockFile = { id: string; name: string; mimeType: string };

/** What the Picker shows: the types Flash reads (google.ts DRIVE_TYPES). */
const PICKABLE = [
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.spreadsheet",
  "application/vnd.google-apps.presentation",
  "application/pdf",
  "text/plain",
];
const MAX_PICK = 20;

const button = "rounded-lg border border-white/10 px-3.5 py-1.5 text-sm text-zinc-200 transition hover:bg-white/[0.05] disabled:opacity-40";
const small = "rounded-md px-2 py-1 text-xs text-zinc-400 transition hover:bg-white/[0.05] hover:text-zinc-200 disabled:opacity-40";
const hint = "text-xs text-zinc-500";

// The parts of Google's Picker library this page uses (https://developers.google.com/workspace/drive/picker/reference).
type PickerData = Record<string, unknown>;
type PickerLib = {
  PickerBuilder: new () => PickerBuilder;
  DocsView: new (viewId?: unknown) => DocsView;
  ViewId: { DOCS: unknown };
  DocsViewMode: { LIST: unknown };
  Feature: { MULTISELECT_ENABLED: unknown };
  Action: { PICKED: string; CANCEL: string };
  Response: { ACTION: string; DOCUMENTS: string };
  Document: { ID: string };
};
type DocsView = { setMimeTypes(types: string): DocsView; setIncludeFolders(on: boolean): DocsView; setSelectFolderEnabled(on: boolean): DocsView; setMode(mode: unknown): DocsView };
type PickerBuilder = {
  addView(view: DocsView): PickerBuilder;
  enableFeature(feature: unknown): PickerBuilder;
  setMaxItems(n: number): PickerBuilder;
  setOAuthToken(token: string): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder;
  setAppId(id: string): PickerBuilder;
  setOrigin(origin: string): PickerBuilder;
  setCallback(callback: (data: PickerData) => void): PickerBuilder;
  build(): { setVisible(on: boolean): void; dispose(): void };
};
type GoogleWindow = { gapi?: { load(name: string, done: { callback: () => void; onerror: () => void }): void }; google?: { picker?: PickerLib } };

let loading: Promise<PickerLib> | null = null;

/** Google's Picker library: api.js from apis.google.com, added to the page once, the first time it's needed. */
function pickerLib(): Promise<PickerLib> {
  loading ??= new Promise<PickerLib>((resolve, reject) => {
    const w = window as unknown as GoogleWindow;
    const ready = () =>
      w.gapi!.load("picker", {
        callback: () => (w.google?.picker ? resolve(w.google.picker) : reject(new Error("picker"))),
        onerror: () => reject(new Error("picker")),
      });
    if (w.gapi) return ready();
    const script = document.createElement("script");
    script.src = "https://apis.google.com/js/api.js";
    script.async = true;
    script.onload = ready;
    script.onerror = () => reject(new Error("picker"));
    document.head.appendChild(script);
  }).catch((err) => {
    loading = null;
    throw err;
  });
  return loading;
}

/** Opens Google's Picker with the user's token; the ids they picked, or none when they closed it. */
async function pick(access: PickerAccess): Promise<string[]> {
  const picker = await pickerLib();
  return new Promise((resolve) => {
    // A list, not thumbnails: Google's guide advises it for an app with drive.file only, which isn't granted the thumbnails.
    const view = new picker.DocsView(picker.ViewId.DOCS)
      .setMimeTypes(PICKABLE.join(","))
      .setMode(picker.DocsViewMode.LIST)
      .setIncludeFolders(false)
      .setSelectFolderEnabled(false);
    const shown = new picker.PickerBuilder()
      .addView(view)
      .enableFeature(picker.Feature.MULTISELECT_ENABLED)
      .setMaxItems(MAX_PICK)
      .setOAuthToken(access.token)
      .setDeveloperKey(access.apiKey)
      .setAppId(access.appId)
      .setOrigin(window.location.origin)
      .setCallback((data) => {
        const action = data[picker.Response.ACTION];
        if (action !== picker.Action.PICKED && action !== picker.Action.CANCEL) return;
        const docs = action === picker.Action.PICKED ? data[picker.Response.DOCUMENTS] : [];
        shown.dispose();
        resolve((Array.isArray(docs) ? docs : []).map((d) => String((d as Record<string, unknown>)[picker.Document.ID] ?? "")).filter(Boolean));
      })
      .build();
    shown.setVisible(true);
  });
}

/** A file's type as the list shows it (Google's product names stay as they are). */
function typeName(mime: string, t: ReturnType<typeof useT>) {
  if (mime === "application/vnd.google-apps.document") return "Google Docs";
  if (mime === "application/vnd.google-apps.spreadsheet") return "Google Sheets";
  if (mime === "application/vnd.google-apps.presentation") return "Google Slides";
  if (mime === "application/pdf") return "PDF";
  return mime === "text/plain" ? t("Text file") : mime;
}

export function DriveFiles({
  connectionId,
  files,
  usable,
  busy,
  onFiles,
}: {
  connectionId: string;
  files: PickedFileView[];
  // The account is signed in (not waiting for Reconnect).
  usable: boolean;
  busy: boolean;
  onFiles: (files: PickedFileView[]) => void;
}) {
  const t = useT();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  // Development only: the stand-in's files, listed in place of Google's Picker, and the access to send them with.
  const [mock, setMock] = useState<{ access: PickerAccess; files: MockFile[]; chosen: string[] } | null>(null);

  async function run(work: () => Promise<void>) {
    setWorking(true);
    setError("");
    setNote("");
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error && e.message !== "picker" ? e.message : t("Google's file picker couldn't open. Try again."));
    }
    setWorking(false);
  }

  async function keep(ids: string[]) {
    if (!ids.length) return;
    const done = await api<Added>("/api/connect/google/files", { method: "POST", json: { connectionId, ids } });
    onFiles(done.files);
    setNote(
      done.refused
        ? t("Files added: {added} of {count}. Flash can open only Docs, Sheets, Slides, PDFs and text files that Google lets it open.", { added: done.added, count: done.added + done.refused })
        : t("Files added: {count}.", { count: done.added }),
    );
  }

  const addFromDrive = () =>
    run(async () => {
      const access = await api<PickerAccess>("/api/connect/google/picker-token", { method: "POST", json: { connectionId } });
      if (access.mock) {
        const res = await fetch(`${access.mock}/files`, { headers: { authorization: `Bearer ${access.token}` } });
        const listed = (await res.json().catch(() => ({}))) as { files?: MockFile[] };
        setMock({ access, files: listed.files ?? [], chosen: [] });
        return;
      }
      await keep(await pick(access));
    });

  const addMock = () =>
    run(async () => {
      if (!mock) return;
      const { access, chosen } = mock;
      // The stand-in gives Flash these files, as Google does for the ones picked in its Picker.
      await fetch(`${access.mock}/pick`, { method: "POST", headers: { authorization: `Bearer ${access.token}`, "content-type": "application/json" }, body: JSON.stringify({ ids: chosen }) });
      setMock(null);
      await keep(chosen);
    });

  const forget = (file: PickedFileView) =>
    run(async () => {
      const done = await api<{ files: PickedFileView[] }>("/api/connect/google/files", { method: "DELETE", json: { connectionId, fileId: file.id } });
      onFiles(done.files);
    });

  return (
    <div className="mt-3 rounded-lg bg-white/[0.03] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex-1 text-sm text-zinc-200">{t("Files Flash can open ({count})", { count: files.length })}</p>
        <button type="button" className={button} disabled={busy || working || !usable || Boolean(mock)} onClick={addFromDrive}>
          {working ? t("Opening…") : t("Add from Drive")}
        </button>
      </div>
      <p className={`mt-1 ${hint}`}>{t("Flash sees only the files you pick here, never the rest of your Drive. Forgetting a file stops Flash from opening it in chat.")}</p>
      {mock && (
        <div className="mt-2 rounded-lg border border-dashed border-zinc-700 p-2.5">
          <p className={hint}>{t("Development stand-in: pick files from its list.")}</p>
          <ul className="mt-1.5 flex flex-col gap-1">
            {mock.files.map((f) => (
              <li key={f.id}>
                <label className="inline-flex items-center gap-2 text-sm text-zinc-200">
                  <input
                    type="checkbox"
                    className="accent-primary"
                    checked={mock.chosen.includes(f.id)}
                    onChange={(e) => setMock({ ...mock, chosen: e.target.checked ? [...mock.chosen, f.id].slice(0, MAX_PICK) : mock.chosen.filter((id) => id !== f.id) })}
                  />
                  <span dir="auto">{f.name}</span> <span className={hint}>· {typeName(f.mimeType, t)}</span>
                </label>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex gap-2">
            <button type="button" className={button} disabled={working || !mock.chosen.length} onClick={addMock}>
              {t("Add")}
            </button>
            <button type="button" className={button} onClick={() => setMock(null)}>
              {t("Cancel")}
            </button>
          </div>
        </div>
      )}
      {files.length > 0 && (
        <ul className="mt-2 divide-y divide-white/6">
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-2 py-1.5">
              <span dir="auto" className="min-w-0 flex-1 truncate text-sm text-zinc-200">
                {f.name}
              </span>
              <span className={`shrink-0 ${hint}`}>{typeName(f.mime, t)}</span>
              <button type="button" className={small} disabled={busy || working} onClick={() => forget(f)} aria-label={t("Forget {name}", { name: f.name })}>
                {t("Forget")}
              </button>
            </li>
          ))}
        </ul>
      )}
      {note && (
        <p role="status" className="mt-2 text-xs text-emerald-300">
          {note}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
