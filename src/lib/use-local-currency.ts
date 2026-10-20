/*
 * The visitor's currency for price tags (see local-currency.ts), asked of the server once per page
 * load and shared by every component that shows a price. null until it's known, and when the visitor
 * pays in US dollars.
 */
import { useEffect, useState } from "react";
import type { LocalCurrency } from "./local-currency.ts";

let asked: Promise<LocalCurrency | null> | null = null;

const ask = () =>
  (asked ??= fetch("/api/pricing/local")
    .then((res) => (res.ok ? (res.json() as Promise<LocalCurrency | null>) : null))
    .catch(() => null));

export function useLocalCurrency(): LocalCurrency | null {
  const [local, setLocal] = useState<LocalCurrency | null>(null);
  useEffect(() => {
    let live = true;
    ask().then((value) => live && setLocal(value));
    return () => {
      live = false;
    };
  }, []);
  return local;
}
