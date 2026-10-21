"use client";

import { useRef, useState } from "react";
import { FEATURES, FEATURE_GROUPS, featureReady, hiddenUntilReady, isInstall, type Feature, type FeatureAction, type FeatureGroup, type FeatureSetup, type IconName } from "@/lib/features";
import { LEVELS, type Level, type ModelPick } from "@/lib/levels";
import type { Me } from "@/lib/store";
import type { Engine } from "@/lib/types";
import { ICONS, Icon, Tile, type Hue } from "./Home";
import { useT } from "@/lib/use-t";
import { LEVEL_HUES, LevelIcon } from "./LevelIcon";

const GROUP_HUES: Record<FeatureGroup, Hue> = {
  "Chat & research": "blue",
  Create: "orange",
  Build: "violet",
  Files: "pink",
  Voice: "teal",
  Workspace: "rose",
};

const CHEVRON = "m6 9 6 6 6-6";

// The sign on each group's card.
const GROUP_ICONS: Record<FeatureGroup, IconName> = {
  "Chat & research": "chat",
  Create: "image",
  Build: "app",
  Files: "file",
  Voice: "voice",
  Workspace: "star",
};

/**
 * "Everything Flash can do" on Home: a card for each kind of work, with its name and what's in it on
 * one line. Tapping a card shows every feature in it, each opening where it's used, so Home stays
 * short however many features Flash has. Above them, Flash's five levels of intelligence with their
 * signs; picking one sets it for the next message.
 */
export function Everything({
  me,
  isLive,
  level,
  onLevel,
  onFeature,
  installable,
}: {
  me: Me;
  isLive: (e: Engine) => boolean;
  // Auto, a level, or a ChatGPT model picked in the message box's menu (only the levels show here).
  level: ModelPick;
  onLevel: (level: Level) => void;
  onFeature: (action: FeatureAction) => void;
  // False inside the installed app, where there's nothing to install.
  installable: boolean;
}) {
  const t = useT();
  // As the server decides for custom domains and selling: a paid plan of their own, or an admin.
  const free = !me.plan && !me.isAdmin;
  const setup: FeatureSetup = {
    isLive,
    modelLive: (id) => Boolean(me.models.find((m) => m.id === id)?.live),
    payments: me.paymentsEnabled,
    domains: me.domainsEnabled,
    connectors: Boolean(me.connectorsEnabled),
  };
  const live = (f: Feature) => featureReady(f, setup);
  const shown = FEATURES.filter((f) => (installable || !isInstall(f)) && !hiddenUntilReady(f, setup));
  const ready = shown.filter(live).length;
  // The group whose features are shown; none until a card is tapped.
  const [open, setOpen] = useState<FeatureGroup | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const groups = FEATURE_GROUPS.map((group) => ({ group, items: shown.filter((f) => f.group === group) })).filter((g) => g.items.length > 0);
  const openGroup = groups.find((g) => g.group === open);
  const pick = (group: FeatureGroup) => {
    const next = open === group ? null : group;
    setOpen(next);
    // A long list can open below the screen's edge, so it's brought into view.
    if (next) requestAnimationFrame(() => panel.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  };

  return (
    <section className="@container/all glass relative overflow-hidden rounded-3xl p-4 sm:px-6 sm:py-5" aria-labelledby="everything-title">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h3 id="everything-title" className="text-[17px] font-semibold tracking-tight text-white">
            {t("Everything Flash can do")}
          </h3>
          <p className="mt-0.5 text-[13px] text-zinc-400">{t("{count} tools in one place. Pick one to start.", { count: ready })}</p>
        </div>
        <div className="min-w-0 max-w-full">
          <p className="mb-1 text-[10.5px] font-medium uppercase tracking-[0.18em] text-zinc-500">{t("Levels of intelligence")}</p>
          {/* One line on a phone, swiped sideways, so the levels never take two rows. */}
          <div className="flex gap-1.5 overflow-x-auto [scrollbar-width:none] sm:flex-wrap" role="group" aria-label={t("Levels of intelligence")}>
            {LEVELS.map((l) => (
              <button
                key={l.id}
                onClick={() => onLevel(l.id)}
                aria-pressed={level === l.id}
                title={t(l.blurb)}
                className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] ring-1 ring-inset transition ${
                  level === l.id ? `${LEVEL_HUES[l.id].tile} font-medium` : "text-zinc-300 ring-white/10 hover:bg-white/[0.05] hover:text-white"
                }`}
              >
                <LevelIcon level={l.id} className={`h-3.5 w-3.5 ${LEVEL_HUES[l.id].text}`} />
                {t(l.short)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* The kinds of work, small, rolling past on their own like the rows above (they stop while pointed at); a tap opens what's in it under the row. */}
      <div className="flash-roll-strip relative -mx-4 mt-4 overflow-hidden sm:-mx-6">
        <div dir="ltr" className="[mask-image:linear-gradient(to_right,transparent,#000_5%,#000_95%,transparent)]">
          <div className="flash-roll flex w-max gap-2.5 py-1" style={{ ["--roll-time" as string]: `${groups.length * 7}s` }}>
            {[0, 1].map((copy) => (
              // The same cards again so the loop never shows a gap; only the first set is read out, both can be tapped.
              <div key={copy} className="flex gap-2.5" aria-hidden={copy ? true : undefined}>
                {groups.map(({ group, items }) => {
                  const expanded = open === group;
                  const id = GROUP_ICONS[group];
                  return (
                    <button
                      key={group}
                      tabIndex={copy ? -1 : undefined}
                      aria-expanded={copy ? undefined : expanded}
                      aria-controls={copy ? undefined : `group-${id}`}
                      onClick={() => pick(group)}
                      className={`flex w-[210px] shrink-0 items-center gap-2.5 rounded-2xl px-3 py-2.5 text-left ring-1 ring-inset transition sm:w-[240px] ${
                        expanded ? "bg-white/[0.07] ring-white/25 light:bg-black/[0.04] light:ring-black/20" : "bg-white/[0.03] ring-white/10 hover:bg-white/[0.06] light:bg-black/[0.02] light:ring-black/10"
                      }`}
                    >
                      <Tile d={ICONS[id]} hue={GROUP_HUES[group]} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px] font-semibold tracking-tight text-white">{t(group)}</span>
                        <span className="block truncate text-[12px] text-zinc-400">{items.map((f) => t(f.title)).join(" · ")}</span>
                      </span>
                      <Icon d={CHEVRON} className={`h-4 w-4 shrink-0 text-zinc-500 transition ${expanded ? "rotate-180" : ""}`} />
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      {openGroup && (
        <div ref={panel} id={`group-${GROUP_ICONS[openGroup.group]}`} className="mt-3 scroll-mt-24 rounded-2xl bg-white/[0.02] p-2 ring-1 ring-inset ring-white/10 light:bg-black/[0.015] light:ring-black/10">
          <div className="flex items-center justify-between gap-3 px-2 pb-1 pt-1">
            <h4 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-500">{t(openGroup.group)}</h4>
            <button onClick={() => setOpen(null)} className="rounded-full px-2.5 py-1 text-[12.5px] text-zinc-400 transition hover:bg-white/[0.06] hover:text-white">
              {t("Close")}
            </button>
          </div>
          <ul className="grid grid-cols-1 gap-x-4 @min-[620px]/all:grid-cols-2">
            {openGroup.items.map((f) => {
              const on = live(f);
              return (
                <li key={f.title} className="min-w-0">
                  <button
                    onClick={() => onFeature(f.action)}
                    // A planned feature still opens, to say what's coming; a tool that isn't set up doesn't.
                    disabled={!on && !f.soon}
                    className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition enabled:hover:bg-white/[0.05] disabled:cursor-default"
                  >
                    <span className={on ? "" : "opacity-50"}>
                      <Tile d={ICONS[f.icon]} hue={GROUP_HUES[openGroup.group]} size="sm" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate text-[14.5px] font-medium ${on ? "text-zinc-100" : "text-zinc-400"}`}>{t(f.title)}</span>
                      <span className="block truncate text-[12.5px] text-zinc-500" title={t(f.about)}>
                        {t(f.about)}
                      </span>
                    </span>
                    {!on ? (
                      <span className="shrink-0 rounded-full bg-white/[0.07] px-2 py-0.5 text-[11px] font-medium text-zinc-400">{t("Coming soon")}</span>
                    ) : f.paid && free ? (
                      <span className="shrink-0 rounded-full bg-gold/15 px-2 py-0.5 text-[11px] font-medium text-gold-soft light:bg-amber-50">{t("Paid plans")}</span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
