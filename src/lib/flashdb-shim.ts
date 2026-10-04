/**
 * A tiny database API that every app built by Flash can use: window.flashDB.
 * Published apps store records on the Flash server (shared by everyone who uses the app);
 * the preview inside Flash keeps them in memory so trying an app never touches real data.
 */
export function flashDbShim(endpoint: string | null, inbox: string | null = null): string {
  const remote = `
  const base = ${JSON.stringify(endpoint)};
  const inbox = ${JSON.stringify(inbox)};
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
  };`;
  const memory = `
  const store = {};
  const id = () => Math.random().toString(36).slice(2, 12);
  const col = (c) => (store[c] = store[c] || []);
  const clone = (x) => JSON.parse(JSON.stringify(x));
  window.flashDB = {
    async list(collection) { return clone(col(collection)); },
    async add(collection, data) { const r = { ...clone(data), id: id(), createdAt: Date.now() }; col(collection).push(r); return clone(r); },
    async update(collection, rid, data) { const r = col(collection).find((x) => x.id === rid); if (!r) throw new Error("Record not found"); Object.assign(r, clone(data), { id: rid }); return clone(r); },
    async remove(collection, rid) { store[collection] = col(collection).filter((x) => x.id !== rid); },
    async send(form, data) { console.info("flashDB.send (preview: not sent)", form, clone(data)); return true; },
  };`;
  return `<script>(function(){${endpoint ? remote : memory}})();</script>`;
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
