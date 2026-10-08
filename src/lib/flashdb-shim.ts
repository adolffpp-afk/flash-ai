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
  };`;

export function flashDbShim(endpoint: string | null, inbox: string | null = null, shop: string | null = null, fillPrices = false): string {
  const remote = `
  const base = ${JSON.stringify(endpoint)};
  const inbox = ${JSON.stringify(inbox)};
  const shop = ${JSON.stringify(shop)};
  let paid = false;
  try {
    const url = new URL(location.href);
    paid = url.searchParams.get("flash_paid") === "1";
    if (paid) { url.searchParams.delete("flash_paid"); history.replaceState(null, "", url.toString()); }
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
