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
  setStages,
  updateContact,
} from "@/lib/server/contacts.ts";
import { MAX_CONTACTS, MAX_STAGES } from "@/lib/contacts.ts";
import { csvName } from "@/lib/csv.ts";

export const dynamic = "force-dynamic";

// My websites & apps › Contacts: one list per app of the people it heard from, for its owner only,
// signed in to Flash (team members and admins see no other owner's list, as for messages and
// orders). Custom domains can't reach this (see site-host.ts), so every link it makes uses Flash's own address.

const MINUTE = 60_000;
const MAX_BODY = 16 * 1024;

type Ctx = RouteContext<"/api/sites/[slug]/contacts">;
type Owner = { user: User; t: ServerT; slug: string };

/** The signed-in owner of the app, or the answer to send instead. */
async function owner(request: Request, ctx: Ctx): Promise<Owner | Response> {
  const user = await getUser(request);
  if (!user) return unauthorized();
  const t = await translatorFor(request, user.language);
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
 * first). The first time, the people the app had before contacts existed are copied in.
 */
export async function GET(request: Request, ctx: Ctx) {
  const who = await owner(request, ctx);
  if (who instanceof Response) return who;
  const { t, slug } = who;
  const params = new URL(request.url).searchParams;
  const q = (params.get("q") ?? "").trim();
  if (q && (await overLimit(`contacts-search:${who.user.id}`, 60, MINUTE))) {
    return Response.json({ error: t("Too many searches. Please wait a minute.") }, { status: 429 });
  }
  await fillContacts(slug);
  const base = appUrl(request);
  const id = params.get("id");
  const format = params.get("format");
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

/** The owner changes a contact: { id, name?, stage?, tags?, notes? }. */
export async function PATCH(request: Request, ctx: Ctx) {
  const who = await owner(request, ctx);
  if (who instanceof Response) return who;
  const { t, slug } = who;
  const limited = await tooMany(who);
  if (limited) return limited;
  const body = await bodyOf(request, t("Couldn't save that contact. Please try again."));
  if (body instanceof Response) return body;
  const stages = await contactStages(slug, t);
  const result = typeof body.id === "string" && stages ? await updateContact(slug, stages, body.id, body) : "missing";
  if (result === "ok") return Response.json({ ok: true });
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
