"use client";

import { useEffect, useRef, useState } from "react";
import type { Engine } from "@/lib/types";
import { api } from "@/lib/store";
import {
  CATEGORIES,
  TEMPLATES,
  billMarkdown,
  defaultValues,
  formatMinor,
  missingField,
  modelTemplateCents,
  nextNumber,
  templateById,
  workOutBill,
  writingCredits,
  type Field,
  type LineItem,
  type Template,
  type TemplateValues,
} from "@/lib/templates";

// Field values worth offering again (business name, address, taxes), and the last invoice and quote
// numbers, kept per account so whoever signs in next on this browser never sees them.
const memoryKey = (userId: string) => `flash:template-memory:${userId}`;

function recall(userId: string): Record<string, string> {
  try {
    const saved = JSON.parse(localStorage.getItem(memoryKey(userId)) ?? "{}");
    return saved && typeof saved === "object" ? saved : {};
  } catch {
    return {};
  }
}

function remember(userId: string, t: Template, v: TemplateValues) {
  try {
    const memory = recall(userId);
    for (const f of t.fields) if (f.remember && v.text[f.key]?.trim()) memory[f.key] = v.text[f.key].trim();
    if (t.engine === "local" && v.text.number?.trim()) memory[`number:${t.id}`] = v.text.number.trim();
    localStorage.setItem(memoryKey(userId), JSON.stringify(memory));
  } catch {
    // Storage blocked: the form simply starts empty next time.
  }
}

/** A date as yyyy-mm-dd on the user's own calendar, some days from today. */
function dayFromToday(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const EMPTY_ITEM: LineItem = { description: "", quantity: "1", price: "" };

/** A template's form, filled with what the user typed last time and sensible defaults. */
function startValues(userId: string, t: Template, brandName: string): TemplateValues {
  const memory = recall(userId);
  const text: Record<string, string> = {};
  for (const f of t.fields) {
    if (f.type === "select") text[f.key] = f.options?.[0] ?? "";
    if (f.remember && memory[f.key]) text[f.key] = memory[f.key];
  }
  if (!text.business && brandName) text.business = brandName;
  if (t.engine === "local") {
    const last = memory[`number:${t.id}`];
    text.number = last ? nextNumber(last) : t.id === "invoice" ? "INV-001" : "Q-001";
    text.date = dayFromToday(0);
    text.due = dayFromToday(t.id === "invoice" ? 14 : 30);
  }
  return { text, items: [{ ...EMPTY_ITEM }] };
}

const input =
  "mt-1 block w-full rounded-lg border border-white/10 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-primary/60";

/** What making a template costs, as shown on its card: the server's price for written ones when it sent one. */
function priceLabel(t: Template, costs: Partial<Record<Engine, number>>, written?: Record<string, number>, values?: TemplateValues): string {
  if (t.engine === "local") return "Free";
  if (t.model) {
    // A fixed price, or two when a choice in the form (like adding a video) costs more.
    const base = written?.[t.id];
    const dearer = written?.[`${t.id}:with`];
    if (!base) return "";
    if (!dearer) return `${base.toLocaleString("en-US")} credits`;
    if (!values) return `From ${base.toLocaleString("en-US")} credits`;
    const pricier = modelTemplateCents(t, values) > modelTemplateCents(t, defaultValues(t));
    return `${(pricier ? dearer : base).toLocaleString("en-US")} credits`;
  }
  const credits = t.answerTokens ? (written?.[t.id] ?? writingCredits(t.answerTokens)) : costs[t.engine];
  return credits ? `About ${credits.toLocaleString("en-US")} credits` : "";
}

/** Ready-made templates: pick one, fill in a short form, and Flash makes the rest. */
export function Templates({
  userId,
  costs,
  written,
  initialId,
  isLive,
  busy,
  onMake,
  onClose,
}: {
  userId: string;
  costs: Partial<Record<Engine, number>>;
  // Typical credits for each written template, from the server.
  written?: Record<string, number>;
  initialId?: string;
  isLive: (engine: Engine) => boolean;
  // Flash is working in a chat, so only the free documents made right here can start now.
  busy: boolean;
  // A free document made right here comes with its finished text. Resolves true once it's made.
  onMake: (t: Template, values: TemplateValues, document?: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [template, setTemplate] = useState<Template | null>(() => (initialId ? (templateById(initialId) ?? null) : null));
  const [values, setValues] = useState<TemplateValues>(() => {
    const t = initialId ? templateById(initialId) : undefined;
    return t ? startValues(userId, t, "") : { text: {}, items: [] };
  });
  const [making, setMaking] = useState(false);
  const [error, setError] = useState("");
  // The brand kit's business name fills in "Business name" when nothing was typed before.
  const [brandName, setBrandName] = useState("");
  const closeRef = useRef<HTMLButtonElement>(null);

  // The template picked right now, for the brand kit's name arriving after it was picked.
  const templateNow = useRef(template);
  const pick = (t: Template | null) => {
    templateNow.current = t;
    setTemplate(t);
  };

  useEffect(() => {
    api<{ brand: { name: string } }>("/api/brand")
      .then(({ brand }) => {
        const name = brand.name.trim();
        setBrandName(name);
        if (name && templateNow.current?.fields.some((f) => f.key === "business")) {
          setValues((v) => (v.text.business ? v : { ...v, text: { ...v.text, business: name } }));
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function open(t: Template) {
    pick(t);
    setValues(startValues(userId, t, brandName));
    setError("");
  }

  const set = (key: string, value: string) => setValues((v) => ({ ...v, text: { ...v.text, [key]: value } }));
  const setItem = (i: number, change: Partial<LineItem>) =>
    setValues((v) => ({ ...v, items: v.items.map((item, at) => (at === i ? { ...item, ...change } : item)) }));

  async function make() {
    if (!template || making) return;
    const missing = missingField(template, values);
    if (missing) return setError(`Fill in "${missing}" first.`);
    let document: string | undefined;
    if (template.engine === "local") {
      const made = billMarkdown(template.id === "invoice" ? "invoice" : "quote", values);
      if (typeof made !== "string") return setError(made.error);
      document = made;
    } else if (busy) {
      // The form stays as it is, so nothing typed is lost.
      return setError("Flash is still working on something. Make this when it finishes; your details stay here.");
    }
    setError("");
    setMaking(true);
    const made = await onMake(template, values, document).catch(() => false);
    setMaking(false);
    // Remembered (and the invoice number used up) only once it was really made.
    if (made) remember(userId, template, values);
    else setError("Couldn't make it. Please try again.");
  }

  // A live total while an invoice or quote is filled in, so mistakes show before it's made.
  let total = "";
  if (template?.engine === "local") {
    const t = values.text;
    const bill = workOutBill(values.items, t.currency || "CAD", [
      { name: t.tax1Name ?? "", rate: t.tax1Rate ?? "" },
      { name: t.tax2Name ?? "", rate: t.tax2Rate ?? "" },
    ]);
    total = "error" in bill ? "" : `${t.currency || "CAD"} ${formatMinor(bill.totalMinor, bill.decimals)}`;
  }

  const field = (f: Field) => {
    const id = `tpl-${f.key}`;
    const value = values.text[f.key] ?? "";
    if (f.type === "items") {
      return (
        <fieldset key={f.key} className="sm:col-span-2">
          <legend className="text-xs font-medium text-zinc-400">{f.label}</legend>
          <div className="mt-1 space-y-2">
            {values.items.map((item, i) => (
              <div key={i} className="grid grid-cols-[1fr_4.5rem_6rem_auto] items-center gap-2">
                <input
                  className={input + " mt-0"}
                  value={item.description}
                  maxLength={200}
                  placeholder="Description"
                  aria-label={`Item ${i + 1} description`}
                  onChange={(e) => setItem(i, { description: e.target.value })}
                />
                <input
                  className={input + " mt-0"}
                  value={item.quantity}
                  inputMode="decimal"
                  maxLength={12}
                  placeholder="Qty"
                  aria-label={`Item ${i + 1} quantity`}
                  onChange={(e) => setItem(i, { quantity: e.target.value })}
                />
                <input
                  className={input + " mt-0"}
                  value={item.price}
                  inputMode="decimal"
                  maxLength={16}
                  placeholder="Price"
                  aria-label={`Item ${i + 1} price`}
                  onChange={(e) => setItem(i, { price: e.target.value })}
                />
                <button
                  type="button"
                  onClick={() => setValues((v) => ({ ...v, items: v.items.length > 1 ? v.items.filter((_, at) => at !== i) : [{ ...EMPTY_ITEM }] }))}
                  aria-label={`Remove item ${i + 1}`}
                  className="px-1 text-zinc-500 hover:text-red-400"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          {values.items.length < 50 && (
            <button
              type="button"
              onClick={() => setValues((v) => ({ ...v, items: [...v.items, { ...EMPTY_ITEM }] }))}
              className="mt-2 text-sm text-primary-soft hover:text-white"
            >
              + Add item
            </button>
          )}
        </fieldset>
      );
    }
    const wide = f.type === "textarea";
    return (
      <label key={f.key} htmlFor={id} className={`block text-xs font-medium text-zinc-400 ${wide ? "sm:col-span-2" : ""}`}>
        {f.label}
        {f.required && <span className="text-primary-soft"> *</span>}
        {f.type === "textarea" ? (
          <textarea id={id} className={`${input} resize-y`} rows={f.max && f.max > 1000 ? 5 : 3} maxLength={f.max} placeholder={f.placeholder} value={value} onChange={(e) => set(f.key, e.target.value)} />
        ) : f.type === "select" ? (
          <select id={id} className={input} value={value} onChange={(e) => set(f.key, e.target.value)}>
            {f.options?.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        ) : (
          <input id={id} className={input} type={f.type === "date" ? "date" : "text"} maxLength={f.max} placeholder={f.placeholder} value={value} onChange={(e) => set(f.key, e.target.value)} />
        )}
      </label>
    );
  };

  return (
    <div className="fixed inset-0 z-40 flex items-stretch justify-center bg-black/60 backdrop-blur-sm sm:items-center sm:p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Templates"
        className="flex h-full w-full max-w-4xl flex-col bg-zinc-950 text-zinc-100 sm:h-[85vh] sm:rounded-2xl sm:border sm:border-white/8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-white/6 px-5 py-4">
          {template && (
            <button onClick={() => pick(null)} className="rounded-full p-1.5 text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100" aria-label="All templates">
              ←
            </button>
          )}
          <h2 className="min-w-0 flex-1 truncate text-lg font-medium tracking-tight">{template ? `${template.icon} ${template.name}` : "Templates"}</h2>
          <button ref={closeRef} onClick={onClose} className="rounded-full p-2 text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100" aria-label="Close">
            ✕
          </button>
        </div>

        {!template ? (
          <div className="flex-1 space-y-6 overflow-y-auto p-5">
            <p className="text-sm text-zinc-400">Pick one, fill in a few details, and Flash makes the rest in its own chat. Your brand kit is used automatically.</p>
            {CATEGORIES.map((category) => (
              <section key={category}>
                <h3 className="text-xs font-medium uppercase tracking-wider text-zinc-500">{category}</h3>
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {TEMPLATES.filter((t) => t.category === category).map((t) => {
                    const live = t.engine === "local" || isLive(t.engine);
                    return (
                      <button
                        key={t.id}
                        onClick={() => open(t)}
                        disabled={!live}
                        className="rounded-xl border border-white/6 bg-white/[0.02] p-3.5 text-left transition hover:border-white/12 hover:bg-white/[0.04] disabled:opacity-40"
                      >
                        <span className="flex items-center gap-2 text-sm font-medium text-zinc-100">
                          <span aria-hidden>{t.icon}</span>
                          {t.name}
                        </span>
                        <span className="mt-1 block text-xs leading-snug text-zinc-400">{t.blurb}</span>
                        <span className="mt-2 block text-xs text-zinc-500">{live ? priceLabel(t, costs, written) : "Coming soon"}</span>
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(e) => {
              e.preventDefault();
              make();
            }}
          >
            <div className="flex-1 overflow-y-auto p-5">
              <p className="mb-4 text-sm text-zinc-400">{template.blurb}</p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{template.fields.map(field)}</div>
            </div>
            <div className="flex flex-wrap items-center gap-3 border-t border-white/6 px-5 py-3">
              {error ? (
                <p role="alert" className="min-w-0 flex-1 text-sm text-red-400">
                  {error}
                </p>
              ) : (
                <p className="min-w-0 flex-1 text-xs text-zinc-500">
                  {total ? `Total ${total} · ` : ""}
                  {priceLabel(template, costs, written, values)} · opens in its own chat
                </p>
              )}
              <button
                type="submit"
                disabled={making}
                className="rounded-full bg-primary px-5 py-2 text-sm font-medium text-white transition hover:brightness-110 disabled:opacity-60"
              >
                {making ? "Making…" : "Make it"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
