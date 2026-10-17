import { one, now, run } from "./db.ts";

/*
 * Google's page speed test (Lighthouse) opening a published app, told apart from people, so it never
 * spends the app's AI (see the ai route) and isn't counted as a visitor (see visits.ts). Its phone has
 * a user agent of its own. Its computer's is any Mac's, so that one is known only while Google is
 * testing the app: during Flash's own check (runLock) or one the owner opened on Google's site
 * (outsideLock). Which agent Google's servers send wasn't checked against Google itself: these are
 * Lighthouse's own (core/config/constants.js).
 */

/** Held (in rate_limits) while Flash's check of an app with Google runs: one check at a time. */
export const runLock = (slug: string) => `pagespeed-run:${slug}`;
/** Held for a while after the owner opens Google's own report for an app, which runs the test there. */
export const outsideLock = (slug: string) => `pagespeed-outside:${slug}`;
/** How long Google takes at most for both halves of a test on its site. */
export const OUTSIDE_MS = 2 * 60_000;

/**
 * Lighthouse's own phone. Up to version 9 it said Chrome-Lighthouse; from 10 on it's an Android 11
 * moto g power (2022) with nothing after Safari (Chrome on a real phone names no model since 110).
 */
const PHONE = /Chrome-Lighthouse|^Mozilla\/5\.0 \(Linux; Android 11; moto g power \(2022\)\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/[\d.]+ Mobile Safari\/537\.36$/i;
/** Lighthouse's computer from version 10 on: Chrome on a Mac, as every Mac's Chrome says it. */
const COMPUTER = /^Mozilla\/5\.0 \(Macintosh; Intel Mac OS X 10_15_7\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/[\d.]+ Safari\/537\.36$/;

/** Whether a user agent is Lighthouse's own phone (any time it's seen, it's Google's test). */
export const isLighthousePhone = (agent: string) => PHONE.test(agent);

/** Whether a user agent could be Lighthouse's computer: then it's Google's test only while one runs. */
export const mayBeLighthouseComputer = (agent: string) => COMPUTER.test(agent);

/** The owner opened Google's own report for an app, which runs the test there: it's held for OUTSIDE_MS from now. */
export async function openedOutside(slug: string): Promise<void> {
  await run("INSERT INTO rate_limits (key, count, reset_at) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = 1, reset_at = MAX(reset_at, excluded.reset_at)", [
    outsideLock(slug),
    now() + OUTSIDE_MS,
  ]);
}

/** Whether Google is testing the app now: Flash's own check, or one the owner opened on Google's site. */
export async function googleTesting(slug: string): Promise<boolean> {
  return !!(await one("SELECT 1 AS held FROM rate_limits WHERE key IN (?, ?) AND reset_at >= ? AND count > 0 LIMIT 1", [runLock(slug), outsideLock(slug), now()]));
}
