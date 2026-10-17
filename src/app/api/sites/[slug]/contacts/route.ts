import { appUrl, getUser, unauthorized, type User } from "@/lib/server/auth.ts";
import { translatorFor, type ServerT } from "@/lib/server/i18n.ts";
import { ownsSite } from "@/lib/server/inbox.ts";
import { one } from "@/lib/server/db.ts";
import { overLimit } from "@/lib/server/limits.ts";
import {
  addContact,
  contactCsv,
  contactDetail,
  contactStages,
  deleteContact,
  exportContact,
  fillContacts,
  listContacts,
  recordConsent,
  setStages,
  updateContact,
} from "@/lib/server/contacts.ts";
import { syncOrders } from "@/lib/server/shop.ts";
import { MAX_CONTACTS, MAX_STAGES } from "@/lib/contacts.ts";
import { csvName } from "@/lib/csv.ts";

export const dynamic = "force-dynamic";

// My websites & apps › Contacts: one list per app of the people it heard from, for its owner only,
// signed in to Flash (team members and admins see no other owner's list, as for messages and
// orders). Custom domains can't reach this (see site-host.ts), so every link it makes uses Flash's own address.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MAX_BODY = 16 * 1024;
/**
 * How many reads each owner gets, far more than going through a list by hand takes: a search reads
 * the whole list, so does each board or list (it counts every stage), a contact's page reads their
 * messages and orders, and a download or a contact's export reads all of it. Downloads and exports
 * count for each app on its own (perApp), so an owner with many apps can download every list in
 * the same hour; their 20 apps at most still read less than the board allows. Each has the words
 * to say when it's used up.
 */
const READS = {
  search: { max: 60, window: MINUTE, perApp: false, error: (t: ServerT) => t("Too many searches. Please wait a minute.") },
  list: { max: 600, window: HOUR, perApp: false, error: (t: ServerT) => t("Too many requests. Try again in an hour.") },
  contact: { max: 600, window: HOUR, perApp: false, error: (t: ServerT) => t("Too many requests. Try again in an hour.") },
  csv: { max: 10, window: HOUR, perApp: true, error: (t: ServerT) => t("Too many requests. Try again in an hour.") },
  export: { max: 20, window: HOUR, perApp: true, error: (t: ServerT) => t("Too many requests. Try again in an hour.") },
};

type Ctx = RouteContext<"/api/sites/[slug]/contacts">;
type Owner = { user: User; t: ServerT; slug: string };

/**
 * The signed-in owner of the app, or the answer to send instead. A request another site set off is
 * refused before it counts against the owner's limits (the sign-in cookie comes along when another
 * site sends their browser to a download): only Flash's own page ("same-origin"), an address typed
 * in ("none") and browsers too old to say get through.
 */
async function owner(request: Request, ctx: Ctx): Promise<Owner | Response> {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
  const from = request.headers.get("sec-fetch-site");
  if (from && from !== "same-origin" && from !== "none") return Response.json({ error: t("Please use Flash's own page.") }, { status: 403 });
  const { slug } = await ctx.params;
  if (!(await ownsSite(user.id, slug))) return Response.json({ error: t("Not found") }, { status: 404 });
  return { user, t, slug };
}

/** Counts a change against the owner's limit; the answer to send when they're over it. */
async function tooMany({ user, t }: Owner): Promise<Response | null> {
  if (!(await overLimit(`contacts-edit:${user.id}`, 300, 10 * MINUTE))) return null;
  return Response.json({ error: t("Too many changes. Please try again in a few minutes.") }, { status: 429 });
}

/** The request's JSON body (up to 16 KB, far more than the page ever sends), or the answer to send instead, with error. */
async function bodyOf(request: Request, error: string): Promise<Record<string, unknown> | Response> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return Response.json({ error }, { status: 413 });
  const text = await request.text().catch(() => "");
  if (text.length > MAX_BODY) return Response.json({ error }, { status: 413 });
  try {
    const body = JSON.parse(text);
    if (body && typeof body === "object" && !Array.isArray(body)) return body;
  } catch {}
  return Response.json({ error }, { status: 400 });
}

const title = async (slug: string) => (await one<{ title: string }>("SELECT title FROM sites WHERE slug = ?", [slug]))?.title ?? "";

/**
 * The app's contacts (?mode=board or list, ?q= to search), one contact (?id=), one contact's data
 * as a file (?id=&format=json), or everyone as a CSV file (?format=csv, cut before 4 MB, newest
 * first). The first time, the people the app had before contacts existed are copied in, and the
 * board and the list bring in buyers from Stripe that Flash hasn't seen yet.
 */
export async function GET(request: Request, ctx: Ctx) {
  const who = await owner(request, ctx);
  if (who instanceof Response) return who;
  const { t, slug } = who;
  const params = new URL(request.url).searchParams;
  const q = (params.get("q") ?? "").trim();
  const id = params.get("id");
  const format = params.get("format");
  const read: keyof typeof READS = format === "csv" ? "csv" : id !== null ? (format === "json" ? "export" : "contact") : q ? "search" : "list";
  const limit = READS[read];
  if (await overLimit(`contacts-${read}:${who.user.id}${limit.perApp ? `:${slug}` : ""}`, limit.max, limit.window)) {
    return Response.json({ error: limit.error(t) }, { status: 429 });
  }
  await fillContacts(slug);
  const base = appUrl(request);
  if (format === "csv") {
    const { csv, included, total } = await contactCsv(slug, t, base);
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${csvName(await title(slug), "contacts")}"`,
        "Cache-Control": "no-store",
        ...(included < total && { "X-Flash-Truncated": `${included}/${total}` }),
      },
    });
  }
  if (id !== null) {
    if (format === "json") {
      const data = await exportContact(slug, id, base, t);
      if (!data) return Response.json({ error: t("Not found") }, { status: 404 });
      return new Response(JSON.stringify(data), {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="${csvName(await title(slug), "contact", "json")}"`,
          "Cache-Control": "no-store",
        },
      });
    }
    const detail = await contactDetail(slug, id, base, t);
    return detail ? Response.json(detail) : Response.json({ error: t("Not found") }, { status: 404 });
  }
  // Buyers whose order Flash hasn't seen yet (they closed the page after paying, or paid later) are
  // fetched from Stripe as Orders does, at most once a minute while the owner goes through the list.
  if (!q && !(await overLimit(`contacts-orders:${slug}`, 1, MINUTE))) {
    await syncOrders(who.user.id, slug).catch((err) => console.error("[flash] contact order sync failed", err));
  }
  const list = await listContacts(slug, t, { q: q.slice(0, 80), mode: params.get("mode") === "list" ? "list" : "board" });
  return list ? Response.json(list) : Response.json({ error: t("Not found") }, { status: 404 });
}

/** The owner adds someone by hand: { name, email, phone }. Someone already there comes back as themselves. */
export async function POST(request: Request, ctx: Ctx) {
  const who = await owner(request, ctx);
  if (who instanceof Response) return who;
  const { t, slug } = who;
  const limited = await tooMany(who);
  if (limited) return limited;
  const body = await bodyOf(request, t("Couldn't save that contact. Please try again."));
  if (body instanceof Response) return body;
  await fillContacts(slug);
  const added = await addContact(slug, body);
  if ("id" in added) return Response.json(added);
  const error = {
    none: t("Give an email address or a phone number."),
    email: t("That isn't an email address."),
    phone: t("That isn't a phone number."),
    full: t("This app has {count} contacts, the most it can keep. New people aren't added until you delete some.", {
      count: MAX_CONTACTS.toLocaleString(t.locale),
    }),
  }[added.error];
  return Response.json({ error }, { status: added.error === "full" ? 409 : 400 });
}

/**
 * The owner changes a contact: { id, name?, stage?, tags?, notes?, phone? }, or records that someone
 * who unsubscribed asked for news again: { id, askedAgain: how they asked }.
 */
export async function PATCH(request: Request, ctx: Ctx) {
  const who = await owner(request, ctx);
  if (who instanceof Response) return who;
  const { t, slug } = who;
  const limited = await tooMany(who);
  if (limited) return limited;
  const body = await bodyOf(request, t("Couldn't save that contact. Please try again."));
  if (body instanceof Response) return body;
  const stages = await contactStages(slug, t);
  const result =
    typeof body.id !== "string" || !stages
      ? "missing"
      : body.askedAgain !== undefined
        ? await recordConsent(slug, body.id, body.askedAgain)
        : await updateContact(slug, stages, body.id, body);
  if (result === "ok") return Response.json({ ok: true });
  if (result === "phone") return Response.json({ error: t("That isn't a phone number.") }, { status: 400 });
  if (result === "bad") return Response.json({ error: t("Couldn't save that contact. Please try again.") }, { status: 400 });
  return Response.json({ error: t("Not found") }, { status: 404 });
}

/** The owner saves their stages: { stages: [{ id?, name }] }, in order. */
export async function PUT(request: Request, ctx: Ctx) {
  const who = await owner(request, ctx);
  if (who instanceof Response) return who;
  const { t, slug } = who;
  const limited = await tooMany(who);
  if (limited) return limited;
  const body = await bodyOf(request, t("Couldn't save the stages. Please try again."));
  if (body instanceof Response) return body;
  const saved = await setStages(slug, t, body.stages);
  if (!saved) return Response.json({ error: t("Not found") }, { status: 404 });
  if ("error" in saved) {
    const error = saved.error === "count" ? t("You can have up to {count} stages.", { count: MAX_STAGES }) : t("Give each stage a name.");
    return Response.json({ error }, { status: 400 });
  }
  return Response.json(saved);
}

/** The owner deletes a contact (?id=) with their messages, member account and private data. */
export async function DELETE(request: Request, ctx: Ctx) {
  const who = await owner(request, ctx);
  if (who instanceof Response) return who;
  const limited = await tooMany(who);
  if (limited) return limited;
  return Response.json({ ok: await deleteContact(who.slug, new URL(request.url).searchParams.get("id") ?? "") });
}
