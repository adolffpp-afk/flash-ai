"use client";

import { useState, type InputHTMLAttributes } from "react";
import { STRENGTH_WORDS, SUGGEST_WORDS, passwordStrength, strongPassword, type Strength } from "@/lib/password";
import { useT } from "@/lib/use-t";

/*
 * A password (or secret key) box with an eye button that shows what was typed, so it can be checked
 * before it's sent. With suggest (a new password), it also offers a strong password in one tap, shown
 * so it can be read and copied, and says how strong the typed one is. autoComplete="new-password"
 * stays on, so the browser's own password manager still offers to save it.
 */

const TONE: Record<Exclude<Strength, "">, string> = { weak: "text-red-400", okay: "text-amber-300", strong: "text-emerald-300" };

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange"> & {
  value: string;
  onValue: (value: string) => void;
  // A new password: offer a strong one and say how strong the typed one is.
  suggest?: boolean;
  // A key or token rather than a password: the eye says "key".
  secret?: boolean;
  // Classes for the box around the field (margins go here, so the eye stays centred on the field).
  wrapClassName?: string;
};

export function PasswordInput({ value, onValue, suggest, secret, wrapClassName = "", className = "", ...rest }: Props) {
  const t = useT();
  const [shown, setShown] = useState(false);
  const [suggested, setSuggested] = useState("");
  const [copied, setCopied] = useState(false);
  const strength = suggest ? passwordStrength(value) : "";
  const eyeLabel = secret ? (shown ? t("Hide key") : t("Show key")) : shown ? t("Hide password") : t("Show password");

  function pickSuggestion() {
    const password = strongPassword();
    setSuggested(password);
    setCopied(false);
    setShown(true);
    onValue(password);
  }

  return (
    <div className={wrapClassName}>
      {/* The input's own direction too, so the eye sits on the side its padding leaves free. */}
      <div className="relative" dir={rest.dir}>
        <input
          {...rest}
          type={shown ? "text" : "password"}
          value={value}
          onChange={(e) => onValue(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className={`${className} pe-10`}
        />
        <button
          type="button"
          // Keeps the cursor in the field.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setShown((s) => !s)}
          aria-label={eyeLabel}
          aria-pressed={shown}
          title={eyeLabel}
          className="absolute inset-y-0 end-0 flex w-10 items-center justify-center rounded-e-lg text-zinc-400 transition hover:text-zinc-100 focus-visible:text-zinc-100"
        >
          <EyeIcon open={!shown} />
        </button>
      </div>
      {suggest && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          {strength && (
            <span role="status" className={TONE[strength]}>
              {t(STRENGTH_WORDS[strength])}
            </span>
          )}
          <button type="button" onClick={pickSuggestion} className="text-primary-soft hover:underline">
            {t(SUGGEST_WORDS)}
          </button>
          {suggested && suggested === value && (
            <button
              type="button"
              className="text-zinc-400 hover:text-zinc-100"
              onClick={() =>
                navigator.clipboard
                  ?.writeText(value)
                  .then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  })
                  .catch(() => {})
              }
            >
              {copied ? t("Copied") : t("Copy")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** An open eye (press to show) or a crossed-out one (press to hide). */
function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
      {!open && <path d="M3 3l18 18" />}
    </svg>
  );
}
