/**
 * A tiny database API that every app built by Flash can use: window.flashDB.
 * Published apps store records on the Flash server (shared by everyone who uses the app);
 * the preview inside Flash keeps them in memory so trying an app never touches real data.
 */

/** flashDB kept in memory: for trying an app in Flash's preview, or running a downloaded app anywhere. */
export const MEMORY_DB = `
  const store = {};
  const id = () => Math.random().toString(36).slice(2, 12);
  const col = (c) => (store[c] = store[c] || []);
  const clone = (x) => JSON.parse(JSON.stringify(x));
  window.flashDB = {
    async list(collection) { return clone(col(collection)); },
    async add(collection, data) { const r = { ...clone(data), id: id(), createdAt: Date.now() }; col(collection).push(r); return clone(r); },
    async update(collection, rid, data) { const r = col(collection).find((x) => x.id === rid); if (!r) throw new Error("Record not found"); Object.assign(r, clone(data), { id: rid }); return clone(r); },
    async remove(collection, rid) { store[collection] = col(collection).filter((x) => x.id !== rid); },
    async send(form, data) { console.info("flashDB.send: nothing was really sent (this is a stand-in)", form, clone(data)); return true; },
    paid: false,
    async items() { return []; },
    async buy() { throw new Error("Payments work once the site is published and its owner sets the prices in Flash."); },
  };
  window.flashDB.mine = {
    async list(collection) { return clone(col("mine:" + collection)); },
    async add(collection, data) { return window.flashDB.add("mine:" + collection, data); },
    async update(collection, rid, data) { return window.flashDB.update("mine:" + collection, rid, data); },
    async remove(collection, rid) { return window.flashDB.remove("mine:" + collection, rid); },
  };
  // Signing in works once the app is published; here it pretends, so the screens can be tried out.
  window.flashAuth = {
    user: null,
    signedIn: false,
    error: "",
    signedOut: false,
    async signUp(email, password, name) { return window.flashAuth.signIn(email, password, name); },
    async signIn(email, password, name) {
      window.flashAuth.user = { id: "preview-user", email: String(email || "you@example.com"), name: String(name || "") };
      window.flashAuth.signedIn = true;
      console.info("flashAuth: pretend sign-in (this works for real once the app is published)");
      return true;
    },
    async signOut() { window.flashAuth.user = null; window.flashAuth.signedIn = false; return true; },
  };`;

/** The person signed in to a published app right now, and the key this page's requests carry. */
export type Visitor = { user: { id: string; email: string; name: string }; token: string } | null;

export function flashDbShim(
  endpoint: string | null,
  inbox: string | null = null,
  shop: string | null = null,
  fillPrices = false,
  auth: string | null = null,
  mine: string | null = null,
  visitor: Visitor = null,
): string {
  const remote = `
  const base = ${JSON.stringify(endpoint)};
  const inbox = ${JSON.stringify(inbox)};
  const shop = ${JSON.stringify(shop)};
  const authUrl = ${JSON.stringify(auth)};
  const mineUrl = ${JSON.stringify(mine)};
  const me = ${JSON.stringify(visitor?.user ?? null)};
  const key = ${JSON.stringify(visitor?.token ?? "")};
  let paid = false;
  let authResult = "";
  try {
    const url = new URL(location.href);
    paid = url.searchParams.get("flash_paid") === "1";
    authResult = url.searchParams.get("flash_auth") || "";
    if (paid || authResult) {
      url.searchParams.delete("flash_paid");
      url.searchParams.delete("flash_auth");
      history.replaceState(null, "", url.toString());
    }
  } catch (e) {}
  async function call(method, query, body) {
    const res = await fetch(base + (query ? "?" + new URLSearchParams(query) : ""), {
      method, headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || "flashDB request failed");
    return json;
  }
  window.flashDB = {
    async list(collection) {
      // The server answers in pages of up to 2 MB; follow the cursor to get every record.
      let page = await call("GET", { collection });
      const records = page.records;
      for (let i = 0; page.more && page.cursor && i < 50; i++) {
        page = await call("GET", { collection, cursor: page.cursor });
        records.push(...page.records);
      }
      return records;
    },
    async add(collection, data) { return (await call("POST", null, { collection, data })).record; },
    async update(collection, id, data) { return (await call("PATCH", null, { collection, id, data })).record; },
    async remove(collection, id) { await call("DELETE", { collection, id }); },
    // Sends a form privately to the site's owner, who reads it in Flash and gets an email.
    async send(form, data) {
      const res = await fetch(inbox, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ form, data }) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Sending failed");
      return true;
    },
    // True when the visitor just came back from paying on this site.
    paid,
    // What the site sells, with prices set by its owner in Flash: [{ name, price }].
    async items() {
      const res = await fetch(shop);
      const json = await res.json().catch(() => ({}));
      return res.ok ? json.items || [] : [];
    },
    // Opens a secure Stripe checkout for an item the owner priced in Flash.
    async buy(item, options) {
      const res = await fetch(shop, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item, quantity: (options && options.quantity) || 1, page: location.href }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.url) throw new Error(json.error || "Couldn't start the payment. Please try again.");
      location.href = json.url;
      return new Promise(() => {});
    },
  };
  // Each signed-in person's own records: nobody else, not even the app's other users, can read them.
  async function mineCall(method, query, body) {
    if (!me) throw new Error("Sign in first to use your own data.");
    const headers = { Authorization: "Bearer " + key };
    if (body) headers["Content-Type"] = "application/json";
    const res = await fetch(mineUrl + (query ? "?" + new URLSearchParams(query) : ""), { method, headers, body: body ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || "flashDB request failed");
    return json;
  }
  window.flashDB.mine = {
    async list(collection) {
      let page = await mineCall("GET", { collection });
      const records = page.records;
      for (let i = 0; page.more && page.cursor && i < 50; i++) {
        page = await mineCall("GET", { collection, cursor: page.cursor });
        records.push(...page.records);
      }
      return records;
    },
    async add(collection, data) { return (await mineCall("POST", null, { collection, data })).record; },
    async update(collection, id, data) { return (await mineCall("PATCH", null, { collection, id, data })).record; },
    async remove(collection, id) { await mineCall("DELETE", { collection, id }); },
  };

  // Signing in sends an ordinary form, because an app can't keep a cookie any other way. The page
  // reloads signed in, or with flashAuth.error set.
  const REASONS = {
    "bad-email": "Please enter a real email address.",
    "short-password": "Your password needs at least 8 characters.",
    "long-password": "That password is too long.",
    taken: "That email already has an account here. Sign in instead.",
    wrong: "That email and password don't match.",
    "too-many": "Too many tries. Please wait a few minutes.",
    full: "This app can't take more sign-ups.",
    "no-app": "This app isn't published any more.",
    unknown: "Something went wrong. Please try again.",
  };
  function go(action, fields) {
    const form = document.createElement("form");
    form.method = "POST";
    form.action = authUrl;
    form.style.display = "none";
    const add = (name, value) => {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      input.value = value == null ? "" : String(value);
      form.appendChild(input);
    };
    add("action", action);
    for (const name in fields) add(name, fields[name]);
    document.body.appendChild(form);
    form.submit();
    // The page is leaving; nothing after this runs.
    return new Promise(function () {});
  }
  window.flashAuth = {
    // The person using the app right now, or null: { id, email, name }.
    user: me,
    signedIn: Boolean(me),
    // Why the last try didn't work, in words you can show. Empty when all is well.
    error: authResult && authResult !== "ok" && authResult !== "signed-out" ? (REASONS[authResult] || REASONS.unknown) : "",
    signedOut: authResult === "signed-out",
    signUp(email, password, name) { return go("signup", { email: email, password: password, name: name }); },
    signIn(email, password) { return go("signin", { email: email, password: password }); },
    signOut() { return go("signout", {}); },
  };

  function ready(fn) { if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn); else fn(); }
  if (paid || ${fillPrices}) ready(function () {
    if (paid) {
      const note = document.createElement("div");
      note.setAttribute("role", "status");
      note.textContent = "\u2713 Payment received. Thank you! A receipt is on its way to your email.";
      note.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;max-width:calc(100% - 32px);padding:12px 18px;border-radius:12px;background:#065f46;color:#fff;font:500 15px/1.4 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.25);cursor:pointer";
      note.onclick = function () { note.remove(); };
      document.body.appendChild(note);
      setTimeout(function () { note.remove(); }, 10000);
    }
    // Shows the owner's real prices wherever the site marks one with data-flash-price="Item name".
    if (!${fillPrices}) return;
    window.flashDB.items().then(function (items) {
      if (!items.length) return;
      const prices = {};
      items.forEach(function (i) { prices[i.name.toLowerCase()] = i.price; });
      function fill(root) {
        (root.querySelectorAll ? root.querySelectorAll("[data-flash-price]") : []).forEach(function (el) {
          const price = prices[(el.getAttribute("data-flash-price") || "").trim().toLowerCase()];
          if (price && el.textContent !== price) el.textContent = price;
        });
      }
      fill(document);
      new MutationObserver(function () { fill(document); }).observe(document.body, { childList: true, subtree: true });
    }).catch(function () {});
  });`;

  return `<script>(function(){${endpoint ? remote : MEMORY_DB}})();</script>`;
}

/** Puts a script at the top of an HTML document so it runs before the app's own code. */
export function injectHead(html: string, snippet: string): string {
  const head = html.match(/<head[^>]*>/i);
  if (head?.index !== undefined) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + snippet + html.slice(at);
  }
  return snippet + html;
}
