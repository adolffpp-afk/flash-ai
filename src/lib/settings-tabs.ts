/*
 * Settings' sections, laid out like Claude's: General, Account, Privacy, Billing, Usage,
 * Capabilities and Connectors, plus Flash's own Brand kit.
 */
export type SettingsTab = "general" | "account" | "privacy" | "billing" | "usage" | "capabilities" | "brand" | "connectors";

export const SETTINGS_TABS: [SettingsTab, string][] = [
  ["general", "General"],
  ["account", "Account"],
  ["privacy", "Privacy"],
  ["billing", "Billing"],
  ["usage", "Usage"],
  ["capabilities", "Capabilities"],
  ["brand", "Brand kit"],
  ["connectors", "Connectors"],
];

// Older names for the sections (the companion opens pages by name), so they still land in the right place.
const OLD_NAMES: Record<string, SettingsTab> = {
  settings: "general",
  profile: "general",
  memory: "general",
  plan: "billing",
  credits: "billing",
  preferences: "capabilities",
  apps: "connectors",
};

/** The section for a page name, old or new; General when it isn't one. */
export function settingsTabFor(page: string): SettingsTab {
  return SETTINGS_TABS.some(([id]) => id === page) ? (page as SettingsTab) : (OLD_NAMES[page] ?? "general");
}
