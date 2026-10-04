"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/store";
import { MAX_INSTRUCTIONS } from "@/lib/project-instructions";

const EXAMPLES = [
  "You are the marketer for my bakery, Golden Crumb, in Montréal. Write warm, short posts.",
  "Answer in French. Use simple words.",
  "This project is my novel. Keep the characters and story consistent.",
];

/** Instructions Flash follows for every answer in one project. */
export function ProjectInstructions({
  project,
  onSaved,
  onClose,
}: {
  project: { id: string; name: string; instructions?: string };
  onSaved: (instructions: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(project.instructions ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const boxRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    boxRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function save(value: string) {
    setSaving(true);
    setError("");
    try {
      const instructions = value.trim();
      await api(`/api/projects/${project.id}`, { method: "PUT", json: { instructions } });
      onSaved(instructions);
      onClose();
    } catch {
      setError("Couldn't save. Please try again.");
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 p-0 backdrop-blur-sm sm:items-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Project instructions"
        className="w-full max-w-lg rounded-t-2xl border border-white/8 bg-zinc-950 p-6 text-zinc-100 sm:rounded-2xl sm:p-7"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-start justify-between gap-3">
          <h2 className="min-w-0 text-lg font-medium tracking-tight">Instructions for “{project.name}”</h2>
          <button onClick={onClose} className="rounded-full p-2 text-zinc-400 transition hover:bg-white/[0.06] hover:text-zinc-100" aria-label="Close">
            ✕
          </button>
        </div>
        <p className="text-sm text-zinc-400">Flash follows these in every answer in this project. Your other projects aren’t affected.</p>
        <textarea
          ref={boxRef}
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, MAX_INSTRUCTIONS))}
          rows={6}
          placeholder={EXAMPLES[0]}
          className="mt-4 block w-full resize-y rounded-xl border border-white/10 bg-zinc-900 px-3 py-2.5 text-sm outline-none placeholder:text-zinc-600 focus:border-primary/60"
          aria-label="Instructions"
        />
        <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
          <span>
            {text.length.toLocaleString()} / {MAX_INSTRUCTIONS.toLocaleString()}
          </span>
          {!text && (
            <span className="flex flex-wrap gap-1.5">
              {EXAMPLES.slice(1).map((e) => (
                <button key={e} type="button" onClick={() => setText(e)} className="rounded-full border border-white/10 px-2.5 py-0.5 text-zinc-400 hover:text-zinc-100">
                  {e.split(".")[0]}
                </button>
              ))}
            </span>
          )}
        </div>
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          {project.instructions && (
            <button onClick={() => save("")} disabled={saving} className="rounded-full px-4 py-2 text-sm text-zinc-400 hover:text-zinc-100 disabled:opacity-40">
              Remove
            </button>
          )}
          <button
            onClick={() => save(text)}
            disabled={saving || text.trim() === (project.instructions ?? "")}
            className="rounded-full bg-primary px-5 py-2 text-sm font-medium text-white transition hover:brightness-110 disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
