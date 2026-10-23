/**
 * A tiny database API that every app built by Flash can use: window.flashDB.
 * Published apps store records on the Flash server (shared by everyone who uses the app);
 * the preview inside Flash keeps them in memory so trying an app never touches real data.
 */
import { UNSEEN } from "./contacts.ts";
import { MAX_TRACKED, RESERVED_STEPS, STEP_ID, STEP_NAME } from "./traffic.ts";
import { COMMON, STRENGTH_WORDS, SUGGEST_LETTERS, SUGGEST_WORDS } from "./password.ts";

/**
 * flashDB.send(form, fields, { news: checkbox }): what the person agreed to by ticking a box, for the
 * app's contact list (see server/contacts.ts). It counts only when they ticked it themselves (a
 * click, a tap or the space bar; a box ticked by code, or by code clicking it, doesn't), when it
 * didn't start ticked, and with the words of its <label>, which Flash then finds among the words a
 * visitor sees on the app's published page (written in its HTML, not put there by a script).
 * Shared by the preview and the published shim, so both judge a box the same way. Pages with no
 * document (tests, downloads run elsewhere) just never find a tick.
 */
const NEWS = `
  const newsTicks = new WeakMap();
  let scriptedClick = false;
  if (typeof document === "object" && document && typeof document.addEventListener === "function") {
    // A click made by code (el.click(), label.click(), dispatchEvent) is untrusted, while the change
    // it causes isn't, so the change that follows it in the same task doesn't count.
    document.addEventListener("click", function (e) {
      if (e && !e.isTrusted) { scriptedClick = true; Promise.resolve().then(function () { scriptedClick = false; }); }
    }, true);
    document.addEventListener("change", function (e) {
      const el = e && e.target;
      if (el && el.type === "checkbox") newsTicks.set(el, Boolean(e.isTrusted && !scriptedClick && el.checked));
    }, true);
  }
  // A label's words as Flash reads the page (see pageWords in contacts.ts): textContent runs the
  // words of elements next to each other together ("newsletter" and "Email" in two spans, or around
  // a <br>), so a space goes where an element starts or ends between two words, or after a "." or ")" there.
  // What a visitor never reads (an icon's <title>, a <style> or a <script>) isn't in them either.
  const unseenTags = /^(${[...UNSEEN, "template"].join("|")})$/i;
  function labelText(label) {
    let text = "";
    let edge = false;
    (function walk(node) {
      for (let n = node.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3) {
          const part = String(n.nodeValue || "");
          if (edge && part && /[\\p{L}\\p{N}.!?:;,)\\]]$/u.test(text) && /^[\\p{L}\\p{N}]/u.test(part)) text += " ";
          text += part;
          if (part) edge = false;
        } else {
          edge = true;
          if (n.nodeType === 1 && !unseenTags.test(String(n.nodeName || ""))) walk(n);
          edge = true;
        }
      }
    })(label);
    return text.replace(/\\s+/g, " ").trim();
  }
  function newsOf(options) {
    const box = options && options.news;
    if (!box) return null;
    const warn = function (why) { if (typeof console === "object" && console.warn) console.warn("flashDB.send: no agreement to news was kept: " + why); };
    if (box.type !== "checkbox") warn("pass the checkbox itself as news");
    else if (!box.checked) return null;
    else if (box.defaultChecked) warn("a box that starts ticked isn't agreement");
    else if (newsTicks.get(box) !== true) warn("the person didn't tick it themselves");
    else {
      const label = (box.labels && box.labels[0]) || (typeof box.closest === "function" ? box.closest("label") : null);
      const text = label ? labelText(label) : "";
      if (text && text.length <= 300) return { text: text };
      warn("put the box in a <label> of up to 300 characters");
    }
    return null;
  }`;

/**
 * flashDB.track(step): a step a person took in the app, which Flash counts once a day per visitor
 * (see the track route). stepName is the server's own check (stepName in traffic.ts), so a name
 * Flash would refuse is refused in the page too, with the reason in the console.
 */
const TRACK = `
  function stepName(step) {
    const name = typeof step === "string" ? step.trim().toLowerCase() : "";
    const warn = function (why) { if (typeof console === "object" && console.warn) console.warn("flashDB.track: " + JSON.stringify(String(step)) + " isn't counted: " + why); };
    if (!${STEP_NAME}.test(name)) warn("use a fixed name of lowercase letters, digits, - or _ (up to 40)");
    else if (${STEP_ID}.test(name)) warn("a step name can't carry a number or an ID");
    else if (${JSON.stringify(RESERVED_STEPS)}.indexOf(name) !== -1) warn("Flash counts this one itself");
    else return name;
    return "";
  }`;

/**
 * Every password box in an app Flash built gets an eye button that shows what was typed, and a box
 * for a new password (autocomplete="new-password", or named like one) offers a strong password in
 * one tap and says how strong the typed one is, while it has the cursor. The app's own markup isn't
 * moved (a React app keeps working): the eye is put right after the box and kept over its end.
 * data-flash-eye="off" on a box leaves it alone. flashAuth.suggestPassword() and
 * flashAuth.passwordStrength(text) give the same to the app's own code. The same rules as
 * password.ts, which Flash's own boxes use (test/password.test.ts checks they agree).
 */
const PASSWORDS = `
  const SUGGEST_LETTERS = ${JSON.stringify(SUGGEST_LETTERS)};
  function strongPassword() {
    const n = SUGGEST_LETTERS.length;
    const limit = 256 - (256 % n);
    for (;;) {
      let out = "";
      while (out.length < 16) {
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        for (let i = 0; i < bytes.length; i++) if (bytes[i] < limit && out.length < 16) out += SUGGEST_LETTERS[bytes[i] % n];
      }
      if (/[a-z]/.test(out) && /[A-Z]/.test(out) && /\\d/.test(out)) return out.match(/.{4}/g).join("-");
    }
  }
  const COMMON_PASSWORDS = ${String(COMMON)};
  function passwordStrength(password) {
    const pw = String(password == null ? "" : password);
    if (!pw) return "";
    if (pw.length < 8 || COMMON_PASSWORDS.test(pw.toLowerCase()) || new Set(pw).size < 5) return "weak";
    const kinds = [/[a-z]/, /[A-Z]/, /\\d/, /[^a-zA-Z\\d]/].filter(function (kind) { return kind.test(pw); }).length;
    if (pw.length >= 16 || (pw.length >= 12 && kinds >= 3)) return "strong";
    if (kinds >= 2 || pw.length >= 12) return "okay";
    return "weak";
  }
  (function () {
    if (typeof document !== "object" || !document || typeof document.querySelectorAll !== "function" || typeof MutationObserver !== "function" || typeof HTMLInputElement !== "function") return;
    const WORDS = ${JSON.stringify(STRENGTH_WORDS)};
    const TONES = { weak: "#dc2626", okay: "#b45309", strong: "#047857" };
    const EYE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
    const EYE_OFF = EYE.replace("</svg>", '<path d="M3 3l18 18"/></svg>');
    const boxes = [];
    const seen = new WeakSet();
    function isNew(input) {
      const auto = (input.getAttribute("autocomplete") || "").toLowerCase();
      if (auto.indexOf("new-password") !== -1) return true;
      if (auto.indexOf("current-password") !== -1) return false;
      return /new|confirm|repeat|sign-?up|register|create/i.test((input.name || "") + " " + (input.id || ""));
    }
    function setValue(input, value) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    // Moves el so its box sits where (left, top) says on the screen, whatever it's positioned against.
    function moveTo(el, left, top) {
      const at = el.getBoundingClientRect();
      el.style.left = (parseFloat(el.style.left) || 0) + left - at.left + "px";
      el.style.top = (parseFloat(el.style.top) || 0) + top - at.top + "px";
    }
    function place(box) {
      const r = box.input.getBoundingClientRect();
      const showing = box.input.isConnected && r.width > 0 && r.height > 0;
      box.eye.style.display = showing ? "flex" : "none";
      if (!showing) { if (box.panel) box.panel.style.display = "none"; return; }
      const rtl = getComputedStyle(box.input).direction === "rtl";
      moveTo(box.eye, rtl ? r.left + 4 : r.right - 36, r.top + (r.height - 28) / 2);
      if (box.panel && box.panel.style.display !== "none") moveTo(box.panel, r.left, r.bottom + 4);
    }
    function showStrength(box) {
      const strength = passwordStrength(box.input.value);
      box.note.textContent = strength ? WORDS[strength] : "";
      box.note.style.color = strength ? TONES[strength] : "";
      box.note.style.display = strength ? "block" : "none";
      box.copy.style.display = box.suggested && box.input.value === box.suggested ? "inline" : "none";
    }
    function add(input) {
      if (seen.has(input) || input.getAttribute("data-flash-eye") === "off") return;
      seen.add(input);
      const style = getComputedStyle(input);
      const eye = document.createElement("button");
      eye.type = "button";
      eye.setAttribute("data-flash-eye", "");
      eye.style.cssText = "position:absolute;left:0;top:0;width:32px;height:28px;margin:0;padding:0;border:0;background:transparent;display:flex;align-items:center;justify-content:center;cursor:pointer;opacity:.65;z-index:2;color:" + style.color;
      const label = function () {
        const hidden = input.type === "password";
        eye.innerHTML = hidden ? EYE : EYE_OFF;
        eye.setAttribute("aria-label", hidden ? "Show password" : "Hide password");
        eye.setAttribute("aria-pressed", hidden ? "false" : "true");
        eye.title = eye.getAttribute("aria-label");
      };
      label();
      eye.addEventListener("mousedown", function (e) { e.preventDefault(); });
      eye.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        input.type = input.type === "password" ? "text" : "password";
        label();
      });
      // Room for the eye, so the text doesn't run under it.
      if (style.boxSizing === "border-box") {
        const side = style.direction === "rtl" ? "paddingLeft" : "paddingRight";
        if ((parseFloat(style[side]) || 0) < 36) input.style[side] = "36px";
      }
      input.insertAdjacentElement("afterend", eye);
      const box = { input: input, eye: eye, label: label, panel: null, note: null, copy: null, suggested: "" };
      if (isNew(input)) {
        const panel = document.createElement("div");
        panel.setAttribute("data-flash-eye", "");
        panel.style.cssText = "position:absolute;left:0;top:0;display:none;z-index:2147483646;max-width:320px;padding:8px 10px;border-radius:10px;background:#fff;color:#111827;border:1px solid rgba(0,0,0,.12);box-shadow:0 8px 24px rgba(0,0,0,.15);font:500 13px/1.4 system-ui,sans-serif;text-align:start";
        panel.addEventListener("mousedown", function (e) { e.preventDefault(); });
        const note = document.createElement("div");
        note.setAttribute("role", "status");
        note.style.cssText = "display:none;margin-bottom:6px";
        const suggest = document.createElement("button");
        suggest.type = "button";
        suggest.textContent = ${JSON.stringify(SUGGEST_WORDS)};
        suggest.style.cssText = "margin:0;padding:0;border:0;background:transparent;color:#4f46e5;font:inherit;cursor:pointer;text-decoration:underline";
        const copy = document.createElement("button");
        copy.type = "button";
        copy.textContent = "Copy";
        copy.style.cssText = "display:none;margin:0 0 0 12px;padding:0;border:0;background:transparent;color:#374151;font:inherit;cursor:pointer";
        suggest.addEventListener("click", function () {
          const password = strongPassword();
          box.suggested = password;
          // A "type it again" box for a new password in the same form gets it too, shown like this one.
          boxes.forEach(function (b) {
            if (b !== box && !(b.panel && input.form && b.input.form === input.form)) return;
            b.input.type = "text";
            b.label();
            setValue(b.input, password);
          });
          copy.textContent = "Copy";
          showStrength(box);
          input.focus();
        });
        copy.addEventListener("click", function () {
          if (navigator.clipboard) navigator.clipboard.writeText(input.value).then(function () { copy.textContent = "Copied"; }).catch(function () {});
        });
        panel.appendChild(note);
        panel.appendChild(suggest);
        panel.appendChild(copy);
        eye.insertAdjacentElement("afterend", panel);
        box.panel = panel;
        box.note = note;
        box.copy = copy;
        input.addEventListener("focus", function () { panel.style.display = "block"; showStrength(box); place(box); });
        input.addEventListener("blur", function () { panel.style.display = "none"; });
        input.addEventListener("input", function () { showStrength(box); });
      }
      boxes.push(box);
      place(box);
    }
    let queued = false;
    function refresh() {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () {
        queued = false;
        Array.prototype.forEach.call(document.querySelectorAll('input[type="password"]'), add);
        for (let i = boxes.length - 1; i >= 0; i--) {
          const box = boxes[i];
          // A box the app removed takes its eye with it.
          if (!box.input.isConnected) {
            box.eye.remove();
            if (box.panel) box.panel.remove();
            boxes.splice(i, 1);
          } else place(box);
        }
      });
    }
    function start() {
      refresh();
      new MutationObserver(function (changes) {
        // Changes Flash made itself (the eye, the panel) don't count.
        for (let i = 0; i < changes.length; i++) if (!(changes[i].target.hasAttribute && changes[i].target.hasAttribute("data-flash-eye"))) return refresh();
      }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden", "type"] });
      addEventListener("resize", refresh);
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
  })();`;

/** flashDB kept in memory: for trying an app in Flash's preview, or running a downloaded app anywhere. */
export const MEMORY_DB = `${NEWS}${TRACK}${PASSWORDS}
  const store = {};
  const id = () => Math.random().toString(36).slice(2, 12);
  const col = (c) => (store[c] = store[c] || []);
  const clone = (x) => JSON.parse(JSON.stringify(x));
  window.flashDB = {
    async list(collection) { return clone(col(collection)); },
    // Here the person trying the app is its owner, and added everything.
    isOwner: true,
    async add(collection, data) { const r = { ...clone(data), id: id(), createdAt: Date.now(), byYou: true }; col(collection).push(r); return clone(r); },
    async update(collection, rid, data) { const r = col(collection).find((x) => x.id === rid); if (!r) throw new Error("Record not found"); Object.assign(r, clone(data), { id: rid }); return clone(r); },
    async remove(collection, rid) { store[collection] = col(collection).filter((x) => x.id !== rid); },
    async send(form, data, options) {
      const news = newsOf(options);
      console.info("flashDB.send: nothing was really sent (this is a stand-in)", form, clone(data));
      if (news) console.info("flashDB.send: once published, Flash records that they agreed to: " + news.text);
      return true;
    },
    // In the preview the file stays in this page, so file screens can be tried before publishing.
    async upload(file) { return { url: URL.createObjectURL(file), name: file.name, size: file.size }; },
    paid: false,
    async items() { return []; },
    async buy() { throw new Error("Payments work once the site is published and its owner sets the prices in Flash."); },
    async track(step) { const name = stepName(step); if (name) console.info("flashDB.track: counted once the app is published", name); return Boolean(name); },
  };
  window.flashDB.mine = {
    async list(collection) { return clone(col("mine:" + collection)); },
    async add(collection, data) { return window.flashDB.add("mine:" + collection, data); },
    async update(collection, rid, data) { return window.flashDB.update("mine:" + collection, rid, data); },
    async remove(collection, rid) { return window.flashDB.remove("mine:" + collection, rid); },
  };
  // The real AI answers once the app is published and its owner turns it on.
  window.flashAI = {
    async ask(prompt) {
      console.info("flashAI.ask (preview)", prompt);
      return "This is an example answer. Once this app is published and its owner turns the AI on in Flash, a real answer appears here.";
    },
  };
  // Signing in works once the app is published; here it pretends, so the screens can be tried out.
  window.flashAuth = {
    user: null,
    signedIn: false,
    error: "",
    signedOut: false,
    async signUp(email, password, name) { return window.flashAuth.signIn(email, password, name); },
    async signIn(email, password, name) {
      // A manager here, so the owner sees every screen the app has while trying it out.
      window.flashAuth.user = { id: "preview-user", email: String(email || "you@example.com"), name: String(name || ""), role: "manager" };
      window.flashAuth.signedIn = true;
      console.info("flashAuth: pretend sign-in (this works for real once the app is published)");
      return true;
    },
    async signOut() { window.flashAuth.user = null; window.flashAuth.signedIn = false; return true; },
    suggestPassword: strongPassword,
    passwordStrength: passwordStrength,
  };`;

/** The person signed in to a published app right now, and the key this page's requests carry. */
// role is what the app's owner made them ("member" or "manager"): for showing the right buttons only, as Flash's server checks every change.
export type Visitor = { user: { id: string; email: string; name: string; role?: "member" | "manager" }; token: string } | null;

/**
 * The owner's key for a page opened with Open as owner (see site-owner.ts), with what the page tells
 * them, in their language. key is "" when the one-time code didn't work: the page only says so.
 */
export type OwnerView = { key: string; note: string; ended: string } | null;

/** The address's query parameter carrying the one-time code that opens an app as its owner; the page removes it at once. */
export const OWNER_CODE_PARAM = "flash_owner";

/** A value written into the page's script. "<" is escaped, so a name with </script> in it can't end the script. */
const js = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

export function flashDbShim(
  endpoint: string | null,
  inbox: string | null = null,
  shop: string | null = null,
  fillPrices = false,
  auth: string | null = null,
  mine: string | null = null,
  visitor: Visitor = null,
  ai: string | null = null,
  files: string | null = null,
  // Set only on a page opened with Open as owner in Flash (see site-owner.ts).
  owner: OwnerView = null,
  // The key this browser's sign-in forms carry, matching its form cookie (see serve-site.ts).
  formKey = "",
  // Where flashDB.track sends the steps the app reports.
  track: string | null = null,
): string {
  const remote = `${NEWS}${TRACK}${PASSWORDS}
  // The page's own fetch and tools, kept before the app's code runs, and every address made whole
  // from the page's own address: markup that gets into the page later (a <base> tag, a changed
  // fetch) can't send a request, or the key it carries, anywhere else.
  const send = fetch;
  const Params = URLSearchParams;
  const toJson = JSON.stringify;
  const here = location.href;
  const whole = (path) => (path ? new URL(path, here).href : path);
  const base = whole(${js(endpoint)});
  const inbox = whole(${js(inbox)});
  const shop = whole(${js(shop)});
  const authUrl = whole(${js(auth)});
  const mineUrl = whole(${js(mine)});
  const aiUrl = whole(${js(ai)});
  const filesUrl = whole(${js(files)});
  const trackUrl = whole(${js(track)});
  const me = ${js(visitor?.user ?? null)};
  const key = ${js(visitor?.token ?? "")};
  const ownerKey = ${js(owner?.key ?? "")};
  const ownerNote = ${js(owner?.note ?? "")};
  // The script holding the owner's key leaves the page once it has run, so nothing can read the key
  // from it later. Code that gets into the page can still use flashDB as the owner while this page
  // is open, so the key can't read collections only the owner sees, and it ends within the hour.
  if (ownerKey && document.currentScript) document.currentScript.remove();
  // fetch reads its options by name, which code in the page could watch through Object.prototype,
  // so the options and headers of every request have no prototype at all.
  // keepalive lets a request finish after the page is gone. With no type, a text body goes as text/plain.
  function request(url, method, auth, body, type, keepalive) {
    const headers = { __proto__: null };
    if (type) headers["Content-Type"] = type;
    if (auth) headers.Authorization = "Bearer " + auth;
    const options = { __proto__: null, method: method, headers: headers, body: body };
    if (keepalive) options.keepalive = true;
    return send(url, options);
  }
  // The page's own timers, kept before the app's code runs, like fetch. Pages without them (tests,
  // downloads run elsewhere) send at once.
  const later = typeof setTimeout === "function" ? setTimeout : null;
  const unlater = typeof clearTimeout === "function" ? clearTimeout : null;
  const tracked = new Set();
  const queued = [];
  let trackTimer = 0;
  // Sends the steps waiting, in one request: 5 s after the last flashDB.track call, and at once when
  // the page is hidden or goes away (a phone can discard a hidden tab without telling it).
  function flushSteps() {
    if (trackTimer && unlater) unlater(trackTimer);
    trackTimer = 0;
    if (!trackUrl || !queued.length) return;
    try { request(trackUrl, "POST", "", queued.splice(0).join("\\n"), "", true).catch(function () {}); } catch (e) {}
  }
  let paid = false;
  let authResult = "";
  try {
    const url = new URL(here);
    paid = url.searchParams.get("flash_paid") === "1";
    authResult = url.searchParams.get("flash_auth") || "";
    // The one-time owner code was used up when Flash served this page; it leaves the address too.
    if (paid || authResult || url.searchParams.has(${js(OWNER_CODE_PARAM)})) {
      url.searchParams.delete("flash_paid");
      url.searchParams.delete("flash_auth");
      url.searchParams.delete(${js(OWNER_CODE_PARAM)});
      history.replaceState(null, "", url.toString());
    }
  } catch (e) {}
  // The shared data's rules decide who may do what, so requests carry the owner's key, or the
  // signed-in person's, when there is one.
  async function call(method, query, body) {
    const res = await request(base + (query ? "?" + new Params(query) : ""), method, ownerKey || key, body ? toJson(body) : undefined, body ? "application/json" : "");
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      // The owner's key lasts an hour at most, and ends with their Flash sign-in.
      if (ownerKey && json.ownerEnded) throw new Error(${js(owner?.ended ?? "")});
      throw new Error(json.error || "flashDB request failed");
    }
    return json;
  }
  window.flashDB = {
    // True on a page opened with Open as owner in Flash: show the owner the buttons to change its data.
    isOwner: Boolean(ownerKey),
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
    // Takes a file someone picked in the app and returns { url, name, size }; save the url in a record.
    async upload(file) {
      const body = new FormData();
      body.append("file", file);
      const res = await request(filesUrl, "POST", key, body, "");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "That file couldn't be sent.");
      return json;
    },
    // Sends a form privately to the site's owner, who reads it in Flash and gets an email. With
    // { news: checkbox }, what the person agreed to by ticking it goes too (see NEWS).
    async send(form, data, options) {
      const news = newsOf(options);
      const res = await request(inbox, "POST", "", toJson(news ? { form, data, consent: news } : { form, data }), "application/json");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Sending failed");
      return true;
    },
    // True when the visitor just came back from paying on this site.
    paid,
    // What the site sells, with prices set by its owner in Flash: [{ name, price }].
    async items() {
      const res = await request(shop, "GET", "", undefined, "");
      const json = await res.json().catch(() => ({}));
      return res.ok ? json.items || [] : [];
    },
    // Opens a secure Stripe checkout for an item the owner priced in Flash.
    async buy(item, options) {
      const res = await request(shop, "POST", "", toJson({ item, quantity: (options && options.quantity) || 1, page: location.href }), "application/json");
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.url) throw new Error(json.error || "Couldn't start the payment. Please try again.");
      flushSteps();
      location.href = json.url;
      return new Promise(() => {});
    },
    // Counts a key step a person took in the app (once per page): a fixed name like "booking-started".
    // Never throws; true when it will be sent.
    track(step) {
      const name = stepName(step);
      if (!name || !trackUrl || (!tracked.has(name) && tracked.size >= ${MAX_TRACKED})) return Promise.resolve(false);
      if (!tracked.has(name)) { tracked.add(name); queued.push(name); }
      if (trackTimer && unlater) unlater(trackTimer);
      if (later) trackTimer = later(flushSteps, 5000);
      else flushSteps();
      return Promise.resolve(true);
    },
  };
  if (typeof addEventListener === "function") addEventListener("pagehide", flushSteps);
  if (typeof document === "object" && document && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") flushSteps(); });
  }
  // Each signed-in person's own records: nobody else, not even the app's other users, can read them.
  async function mineCall(method, query, body) {
    if (!me) throw new Error("Sign in first to use your own data.");
    const res = await request(mineUrl + (query ? "?" + new Params(query) : ""), method, key, body ? toJson(body) : undefined, body ? "application/json" : "");
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

  // The app's own assistant. Its owner pays for it with their Flash credits and can switch it off,
  // so an answer may come back as an error with a message to show.
  window.flashAI = {
    async ask(prompt, options) {
      const res = await request(aiUrl, "POST", key, toJson({ prompt: String(prompt == null ? "" : prompt), instructions: (options && options.instructions) || "" }), "application/json");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "The AI couldn't answer that.");
      return json.text;
    },
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
    "invite-only": "This app is only for people its owner invited. Ask them to invite your email address.",
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
    add("form_key", ${js(formKey)});
    add("action", action);
    for (const name in fields) if (name !== "form_key") add(name, fields[name]);
    document.body.appendChild(form);
    flushSteps();
    form.submit();
    // The page is leaving; nothing after this runs.
    return new Promise(function () {});
  }
  window.flashAuth = {
    // The person using the app right now, or null: { id, email, name, role }, role being "member" or "manager".
    user: me,
    signedIn: Boolean(me),
    // Why the last try didn't work, in words you can show. Empty when all is well.
    error: authResult && authResult !== "ok" && authResult !== "signed-out" ? (REASONS[authResult] || REASONS.unknown) : "",
    signedOut: authResult === "signed-out",
    signUp(email, password, name) { return go("signup", { email: email, password: password, name: name }); },
    signIn(email, password) { return go("signin", { email: email, password: password }); },
    signOut() { return go("signout", { page: key }); },
    // A strong password to offer when signing up, and "weak", "okay" or "strong" for a typed one.
    suggestPassword: strongPassword,
    passwordStrength: passwordStrength,
  };

  function ready(fn) { if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn); else fn(); }
  // Says the page is in owner view, or that the owner link didn't work.
  if (ownerNote) ready(function () {
    const note = document.createElement("div");
    note.setAttribute("role", "status");
    note.textContent = ownerNote;
    note.style.cssText = "position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;max-width:min(560px,calc(100% - 32px));padding:12px 18px;border-radius:12px;background:#1e1b4b;color:#fff;font:500 14px/1.45 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.25);cursor:pointer";
    note.onclick = function () { note.remove(); };
    document.body.appendChild(note);
    setTimeout(function () { note.remove(); }, 8000);
  });
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
  // Found without a regex, so no page can make it slow. Not <header>, which can come first in a page with no <head>.
  const lower = html.toLowerCase();
  let at = -1;
  for (let i = lower.indexOf("<head"); i !== -1; i = lower.indexOf("<head", i + 5)) {
    if (!/[\s>]/.test(lower[i + 5] ?? "")) continue;
    const end = html.indexOf(">", i);
    if (end !== -1) at = end + 1;
    break;
  }
  if (at === -1) at = afterDoctype(html);
  return html.slice(0, at) + snippet + html.slice(at);
}

/**
 * Where a page with no <head> can take a script: right after its doctype (and any comments before
 * it), as before it the page would show in the browser's old "quirks" layout; the browser still
 * puts the script in the head it makes up. 0 when there's no doctype. Read without a regex, so no
 * page can make it slow.
 */
function afterDoctype(html: string): number {
  let i = html.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (;;) {
    while (i < html.length && /\s/.test(html[i])) i++;
    if (!html.startsWith("<!--", i)) break;
    const end = html.indexOf("-->", i + 4);
    if (end === -1) return 0;
    i = end + 3;
  }
  if (html.slice(i, i + 9).toLowerCase() !== "<!doctype") return 0;
  return html.indexOf(">", i) + 1;
}
