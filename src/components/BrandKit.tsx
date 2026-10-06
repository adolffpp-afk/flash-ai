"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/store";
import { EMPTY_BRAND, LOGO_TYPES, MAX_COLORS, MAX_LOGO_BYTES, type BrandKit as Kit } from "@/lib/brand";

const field =
  "mt-1 block w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-primary/60";
const label = "block text-xs font-medium text-zinc-400";

/** The brand kit form (in Settings): saved once, used by Flash for sites, decks, posts and pictures. */
export function BrandKitForm({ onSaved }: { onSaved: (message: string) => void }) {
  const [kit, setKit] = useState<Kit | null>(null);
  // A new logo to upload, "remove", or null to keep the saved one.
  const [logo, setLogo] = useState<{ mediaType: string; data: string; preview: string } | "remove" | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ brand: Kit }>("/api/brand")
      .then(({ brand }) => setKit(brand))
      .catch(() => setKit(EMPTY_BRAND));
  }, []);

  function pickLogo(file: File | undefined) {
    if (!file) return;
    if (!LOGO_TYPES.includes(file.type)) return setError("The logo must be a PNG, JPEG or WebP picture.");
    if (file.size > MAX_LOGO_BYTES) return setError("The logo must be 1 MB or smaller.");
    setError("");
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      setLogo({ mediaType: file.type, data: url.slice(url.indexOf(",") + 1), preview: url });
    };
    reader.readAsDataURL(file);
  }

  async function save() {
    if (!kit) return;
    setSaving(true);
    setError("");
    try {
      const body = {
        ...kit,
        ...(logo === "remove" ? { logo: null } : logo ? { logo: { mediaType: logo.mediaType, data: logo.data } } : { logo: undefined }),
      };
      const { brand } = await api<{ brand: Kit }>("/api/brand", { method: "PUT", json: body });
      setKit(brand);
      setLogo(null);
      onSaved("Brand kit saved. Flash will use it for your websites, slides, posts and pictures.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save. Please try again.");
    }
    setSaving(false);
  }

  const set = (part: Partial<Kit>) => setKit((k) => (k ? { ...k, ...part } : k));
  const logoSrc = logo === "remove" ? "" : logo ? logo.preview : kit?.logo;

  return (
    <div>
      <div>
        <p className="text-sm text-zinc-400">Save your business&apos;s look once. Flash uses it for your websites, slides, posts, flyers and pictures.</p>
        {!kit ? (
          <p className="mt-6 text-sm text-zinc-500">Loading…</p>
        ) : (
          <div className="mt-5 flex flex-col gap-4">
            <div>
              <span className={label}>Logo</span>
              <div className="mt-1 flex items-center gap-3">
                <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-white">
                  {logoSrc ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={logoSrc} alt="Your logo" className="max-h-full max-w-full object-contain" />
                  ) : (
                    <span className="text-xs text-zinc-500">None</span>
                  )}
                </div>
                <label className="cursor-pointer rounded-full border border-white/10 px-3 py-1.5 text-xs text-zinc-200 transition hover:bg-white/[0.05]">
                  {logoSrc ? "Change" : "Upload logo"}
                  <input type="file" accept={LOGO_TYPES.join(",")} hidden onChange={(e) => pickLogo(e.target.files?.[0])} />
                </label>
                {logoSrc && (
                  <button type="button" onClick={() => setLogo("remove")} className="text-xs text-zinc-400 hover:text-zinc-100">
                    Remove
                  </button>
                )}
              </div>
              <span className="mt-1 block text-xs text-zinc-500">PNG, JPEG or WebP, up to 1 MB. Websites Flash makes show it.</span>
            </div>
            <label className={label}>
              Business name
              <input className={field} value={kit.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} placeholder="Golden Crumb Bakery" />
            </label>
            <label className={label}>
              Tagline
              <input className={field} value={kit.tagline} maxLength={140} onChange={(e) => set({ tagline: e.target.value })} placeholder="Fresh bread every morning in Montréal" />
            </label>
            <div>
              <span className={label}>Colours (main colour first)</span>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {kit.colors.map((c, i) => (
                  <span key={i} className="inline-flex items-center gap-1 rounded-full border border-white/10 py-1 pl-1 pr-2">
                    <input
                      type="color"
                      value={c}
                      onChange={(e) => set({ colors: kit.colors.map((x, j) => (j === i ? e.target.value : x)) })}
                      className="h-6 w-6 cursor-pointer rounded-full border-0 bg-transparent p-0"
                      aria-label={`Colour ${i + 1}`}
                    />
                    <span className="font-mono text-xs text-zinc-300">{c}</span>
                    <button type="button" onClick={() => set({ colors: kit.colors.filter((_, j) => j !== i) })} className="text-xs text-zinc-500 hover:text-zinc-100" aria-label={`Remove colour ${c}`}>
                      ✕
                    </button>
                  </span>
                ))}
                {kit.colors.length < MAX_COLORS && (
                  <button
                    type="button"
                    onClick={() => set({ colors: [...kit.colors, ["#c8102e", "#f2c14e", "#1f2933", "#ffffff", "#2a9d8f"][kit.colors.length]] })}
                    className="rounded-full border border-dashed border-white/15 px-3 py-1 text-xs text-zinc-400 hover:text-zinc-100"
                  >
                    + Add colour
                  </button>
                )}
              </div>
            </div>
            <label className={label}>
              Tone of voice
              <textarea
                className={`${field} resize-y`}
                rows={3}
                maxLength={600}
                value={kit.voice}
                onChange={(e) => set({ voice: e.target.value })}
                placeholder="Warm and friendly, a little playful. Short sentences. Never pushy."
              />
            </label>
          </div>
        )}
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
        <div className="mt-6 flex justify-end">
          <button
            onClick={save}
            disabled={!kit || saving}
            className="rounded-full bg-primary px-5 py-2 text-sm font-medium text-white transition hover:brightness-110 disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
