/** Rows as a CSV file that Excel, Numbers and Google Sheets open, with a header row first. */
export function toCsv(rows: unknown[][]): string {
  const cell = (value: unknown) => {
    let text = value === null || value === undefined ? "" : typeof value === "string" ? value : String(value);
    // A cell starting like a formula could run in a spreadsheet when opened, so it's kept as text.
    // A real number (like -3) always prints as a plain number, which can't be a formula.
    if (typeof value !== "number" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  // The byte-order mark makes Excel read accents (Montréal) correctly.
  return "﻿" + rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}

/** A file name from a site's title, like "golden-crumb-orders.csv". */
export const csvName = (title: string, what: string) =>
  `${title.toLowerCase().replace(/^home\s*[·|:–—-]\s*/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "site"}-${what}.csv`;
