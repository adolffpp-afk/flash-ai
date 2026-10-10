"use client";

import { FEATURES, FEATURE_GROUPS, featureReady, isInstall, type Feature, type FeatureAction, type FeatureGroup } from "@/lib/features";
import { LEVELS, type Level } from "@/lib/levels";
import type { Me } from "@/lib/store";
import type { Engine } from "@/lib/types";
import { ICONS, Tile, type Hue } from "./Home";
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

/**
 * "Everything Flash can do" on Home: every feature, grouped by kind of work, each opening where
 * it's used. Above them, Flash's five levels of intelligence with their signs; picking one sets it
 * for the next message.
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
  level: Level;
  onLevel: (level: Level) => void;
  onFeature: (action: FeatureAction) => void;
  // False inside the installed app, where there's nothing to install.
  installable: boolean;
}) {
  const t = useT();
  // As the server decides for custom domains and selling: a paid plan of their own, or an admin.
  const free = !me.plan && !me.isAdmin;
  const live = (f: Feature) =>
    featureReady(f, {
      isLive,
      modelLive: (id) => Boolean(me.models.find((m) => m.id === id)?.live),
      payments: me.paymentsEnabled,
      domains: me.domainsEnabled,
    });
  const shown = FEATURES.filter((f) => installable || !isInstall(f));
  const ready = shown.filter(live).length;

  return (
    <section className="@container/all glass relative rounded-3xl p-4 sm:p-6" aria-labelledby="everything-title">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="min-w-0">
          <h3 id="everything-title" className="text-[19px] font-semibold tracking-tight text-white">
            {t("Everything Flash can do")}
          </h3>
          <p className="mt-1 text-sm text-zinc-400">{t("{count} tools in one place. Pick one to start.", { count: ready })}</p>
        </div>
        <div className="min-w-0">
          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.18em] text-zinc-500">{t("Levels of intelligence")}</p>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("Levels of intelligence")}>
            {LEVELS.map((l) => (
              <button
                key={l.id}
                onClick={() => onLevel(l.id)}
                aria-pressed={level === l.id}
                title={t(l.blurb)}
                className={`inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] ring-1 ring-inset transition ${
                  level === l.id ? `${LEVEL_HUES[l.id].tile} font-medium` : "text-zinc-300 ring-white/10 hover:bg-white/[0.05] hover:text-white"
                }`}
              >
                <LevelIcon level={l.id} className={`h-4 w-4 ${LEVEL_HUES[l.id].text}`} />
                {t(l.short)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-5 columns-1 gap-5 @min-[620px]/all:columns-2 @min-[980px]/all:columns-3">
        {FEATURE_GROUPS.map((group) => {
          const items = shown.filter((f) => f.group === group);
          return (
            <div key={group} className="mb-5 break-inside-avoid">
              <h4 className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-500">{t(group)}</h4>
              <ul>
                {items.map((f) => {
                  const on = live(f);
                  return (
                    <li key={f.title}>
                      <button
                        onClick={() => onFeature(f.action)}
                        // A planned feature still opens, to say what's coming; a tool that isn't set up doesn't.
                        disabled={!on && !f.soon}
                        className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition enabled:hover:bg-white/[0.05] disabled:cursor-default"
                      >
                        <span className={on ? "" : "opacity-50"}>
                          <Tile d={ICONS[f.icon]} hue={GROUP_HUES[group]} size="sm" />
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
          );
        })}
      </div>
    </section>
  );
}
