# Automations setup

Automations are tasks Flash runs on a schedule: an AI step (Write, Research or Quick research at a
level the user picks) and a notice with its result. Vercel Cron calls `/api/cron/tick` every
minute; the tick finds what is due and starts each run in its own call to `/api/cron/work`.

At first only admins can use them, from **/admin** > **Automations** (the burn-in). Nobody else sees
them, and every automation route answers 404 to everyone else, until an admin presses **Open to
everyone** on that tab. Then everyone with a confirmed email gets the Automations panel (Home, the
menu and the bell). They run only on production
(`VERCEL_ENV=production`): a Preview deployment never ticks or runs anything, even with the
production database.

## Money

- An AI step costs exactly what chat costs at its level; Research costs what chat Research costs.
- Before each AI call its most possible cost is held. It is charged once, at most the hold, and
  never takes the balance below zero or below the user's auto top-up level. Automations never buy
  credits.
- Missed, late and skipped runs are free. A run that never reached the AI costs nothing.
- A run that fails because of Flash (Claude failing, or Flash's server stopping part way) gives back
  everything it was charged, by itself, when it ends. Its receipt says how much came back, and on
  /admin its requests count as refunded (their cost is Flash's).
- Each step writes to the database at most 50 times, its heartbeats included, so a long step can't
  run up the Turso bill.
- The default limits (per run: its worst case; per month: the larger of that and a typical run x
  its runs in 30 days x 1.5) are in `src/lib/automation-pricing.ts`.

## 1. Before it deploys

All of these go in the Vercel project `flash-ai` > **Settings** > **Environment Variables**,
**Production**, marked **Sensitive** where it says so. A variable only takes effect in a new
deployment.

1. **`CRON_SECRET`** (Sensitive): at least 32 random characters, for example the output of
   `openssl rand -hex 32` in a terminal. Vercel sends it to the tick by itself. Until it is set, the
   tick answers 503 every minute and nothing runs.
2. **The automations workspace** (recommended now, required before automations open to everyone):
   - Anthropic Console > **Workspaces**: create a workspace named "Flash automations".
   - In its **Limits**, set the rate limits for the models Flash uses to about 30% of the
     organisation's, so automations can never use up chat's. (The default workspace, where chat
     runs, can't be limited; the organisation limit still applies to both.)
   - Optionally add a monthly spend limit there as a backstop.
   - Create an API key in that workspace and add it in Vercel as
     **`ANTHROPIC_AUTOMATIONS_API_KEY`** (Sensitive).
   - Send the input-token limit you set in your next message, so `AUTOMATION_MAX_PAID` (how many
     runs call the model at once) can be set to match it, about the limit ÷ 50,000. With no limit
     on the workspace (as on 2026-10-21), automations share the organisation's limit with chat, so
     Flash keeps it at 10.

   Until it is set, AI steps use chat's key (`ANTHROPIC_API_KEY`) with at most 2 runs calling the
   model at once. /admin > Automations says which key is in use.
3. **`FLASH_APP_URL`**: check that it is `https://www.flash-app.dev` for Production. The tick calls
   the app's own address to start each run.
4. **Redeploy** (Deployments > the latest one > Redeploy).
5. **Preview**: check that Preview doesn't use the production `DATABASE_URL`. Automations never run
   there anyway, but a shared database is risky for other reasons.
6. **Turso dashboard**: check the plan and this month's rows written, turn on a usage alert, and
   decide on overage. While overage is off, reaching the cap stops all of Flash's writes (sign-ins
   and bought credits included); turning it on, with the alert, is recommended. If the plan's
   included writes aren't 25 million a month, set `AUTOMATION_MONTHLY_WRITES` to them.

## 2. After it deploys

1. Vercel > **Settings** > **Cron Jobs** should list `/api/cron/tick`, every minute. Press **Run**
   once; its log should say 202 or 204.
2. Open **/admin** > **Automations**. **Setup** should be green, with nothing missing, including
   "Anthropic accepts the automations key at every level". If that line isn't green, it shows what
   Anthropic said for each level and what to do: a key pasted wrong (a 401, or a line break inside
   it) means pasting it again in Vercel with nothing before or after it, then redeploying; a 403 or
   404 means the automations workspace isn't allowed that model; busy or not reached (amber) passes
   by itself, so reload in a minute. Until it is green, prices show the most the text could cost.
3. Burn-in, over a few days, from the card's buttons (each shows its price first):
   - **One-off in 3 minutes**, then close the laptop. Later, on your phone, open its run: one
     charge, its hold settled, a fingerprint.
   - **Every day**, and watch **Cron health** (start lag, holds open, losses) for 3 days.
   - **Run once now**, then close the tab: the run still finishes.
   - Pause one and resume it across its time; delete one while it runs.
4. When it all looks right, press **Open to everyone** at the top of the card. It works only once
   Setup is green with automations' own key (`ANTHROPIC_AUTOMATIONS_API_KEY`), so everyone's runs
   never share chat's key. Every server sees the switch within 30 seconds.

## Turning it off

To close automations to everyone but admins, press **Close to everyone but admins** on the card.
Each automation of someone else stops at its next run (charged nothing) and pauses; turned on again
after the switch reopens, it runs as before.

Remove `CRON_SECRET` and redeploy: the tick answers 503, and neither the schedule nor Run once now
starts anything. A step already under way finishes the call it is in; credits still held are
settled once the tick is back.

## Variables

| Name | What it is |
| --- | --- |
| `CRON_SECRET` | The tick's secret (Sensitive) |
| `ANTHROPIC_AUTOMATIONS_API_KEY` | The automations workspace's key (Sensitive) |
| `FLASH_APP_URL` | The app's own address |
| `AUTOMATION_MAX_PAID` | Runs calling the model at once, Flash-wide (10) |
| `AUTOMATION_MAX_OTHER` | Other runs at once, Flash-wide (100) |
| `AUTOMATION_MONTHLY_WRITES` | The Turso plan's included writes a month (25,000,000) |
| `AUTOMATIONS_DEV` | Dev only: `1` lets a local server tick and run automations |
