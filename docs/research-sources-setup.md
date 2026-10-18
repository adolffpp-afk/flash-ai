# Setting up web search, SEC EDGAR and FRED

Flash's AI can look things up in three free public sources:

- **Web search** through your own SearXNG server on Railway. People who are out of credits get a free
  web search with numbered sources. Paid Research keeps its own web search, as before.
- **SEC EDGAR**: a US-listed company's filings (10-K, 10-Q, 8-K…) and the figures it reported
  (revenue, profit, cash…). It needs no key and nothing to set up.
- **FRED**: US economic data (unemployment, inflation, GDP, interest rates…) from the Federal Reserve
  Bank of St. Louis. It needs a free key.

Each one stays hidden until its settings are in Vercel. In Flash, **/admin** → **By provider** lists
SearXNG, SEC EDGAR and FRED, and says "Missing …" next to anything still to add.

At the end are the steps for **PageSpeed Insights**, which isn't something the AI looks up: it
scores published apps in My websites & apps › SEO, and works (less reliably) without a key.

These steps use Firefox, but any browser works the same way.

## Web search (SearXNG)

You need three things from Railway: the server's address, its user name and its password.

1. Open [Railway](https://railway.com/) and sign in. Open the project with SearXNG in it, and click
   the box called **SearXNG**. (That's the password gate in front of the search. Don't use the box
   called **Engine**: it has no password.)
2. Click **Settings**, then scroll to **Networking**. Under **Public Networking** you see an address
   like `searxng-production-1234.up.railway.app`. Click the copy icon next to it, or select it and
   press **Ctrl+C**. If there is no address yet, click **Generate Domain** first.
   Paste it somewhere for now (a note) and type `https://` in front of it, so it reads like
   `https://searxng-production-1234.up.railway.app`. Nothing after it: no `/` and no `/search`.
3. Click **Variables**. Find **SEARXNG_USERNAME** and **SEARXNG_PASSWORD**. For each, click the eye
   icon to show the value (or the copy icon next to it) and copy it into your note.
4. Open [Vercel](https://vercel.com/) → the **flash-ai** project → **Settings** → **Environment
   Variables**. Add these three, one at a time. For each, choose **Production** only, then click
   **Save**:
   - `SEARXNG_URL`: the address from step 2, starting with `https://`.
   - `SEARXNG_USERNAME`: the user name from step 3.
   - `SEARXNG_PASSWORD`: the password from step 3. Tick **Sensitive** for this one.
5. Click **Deployments** at the top, open the menu (**⋯**) next to the latest one, and click
   **Redeploy**. Wait until it says **Ready**.

Then delete the note with the password in it.

**Check it:** open Flash → **/admin** → **By provider**. SearXNG no longer says "Missing". If it
says "SEARXNG_URL must start with https://", edit `SEARXNG_URL` in Vercel so it starts with
`https://`, and redeploy. Flash never sends the password to an address that isn't https.

**Check that SearXNG answers Flash.** Flash asks SearXNG for its results as data (JSON), which
SearXNG turns off unless it's told to allow it. In Firefox, open your address with
`/search?q=weather&format=json` after it, like
`https://searxng-production-1234.up.railway.app/search?q=weather&format=json`. Firefox asks for a user
name and password: use the ones from step 3.

- You see a page of data with `query` and `results` (Firefox shows it as a tree): it works.
- You see **403 Forbidden**: JSON is off. In Railway, the **Engine** box's settings file
  (`settings.yml`) needs `json` in its list of formats, under `search:`:

  ```yaml
  search:
    formats:
      - html
      - json
  ```

  Then redeploy the Engine box. If you don't see that file, ask whoever set SearXNG up (or Claude) to
  "turn on SearXNG's JSON format".
- You see **429 Too Many Requests**: SearXNG's bot limiter is blocking it. Your password gate already
  keeps strangers out, so set `limiter: false` under `server:` in the same file, and redeploy the
  Engine box.

Flash's log in Vercel (**Logs**) says the same when a search fails: "status 401" (check the user
name and password), "status 403" (JSON is off) or "status 429" (the limiter).

**What people see:** someone out of credits who asks something like "what happened in the news
today?" gets an answer with numbered sources, and the line above it says "Research needs credits, so
a free model answered with a free web search." If the search doesn't work (wrong password, server
down), they still get an answer, and it says it couldn't search the web.

**Limits** (you can change them in Vercel; the defaults are fine):

- 2 searches per answer.
- `FLASH_FREE_DAILY_SEARCHES`: free searches per person per day (default 20).
- `FLASH_SEARXNG_DAILY_REQUESTS`: searches Flash sends your server per day, everyone together
  (default 5,000), so a rush can't run up your Railway bill.

The same search asked again within 10 minutes is answered from Flash's copy, without asking
SearXNG again.

## SEC EDGAR

Nothing to do: it works as soon as this update is deployed. The SEC asks every app to say who it is,
so Flash sends "Flash AI" and the email in `FLASH_CONTACT_EMAIL` with each request (or
support@flash-app.dev when that isn't set). If you haven't set `FLASH_CONTACT_EMAIL`, add it in Vercel
(**Settings** → **Environment Variables**, **Production**) with an email you read, and redeploy.

Flash asks the SEC at most about 5 times a second, everyone together (the SEC allows 10), and keeps
what it gets for up to a day.

## FRED

1. Open [fredaccount.stlouisfed.org](https://fredaccount.stlouisfed.org/) and create a free account
   (**Sign in** → **Create New Account**). Confirm your email if it asks you to.
2. Signed in, click **API Keys** (under **My Account**), then **Request API Key**. In the box that
   asks what the key is for, write something like: "Flash AI is an AI assistant. It uses FRED data
   to answer people's questions about the US economy, shows where each figure came from, and shows
   FRED's notice." Accept the terms and submit. Your key appears: 32 letters and numbers. Copy it.
3. In Vercel → the **flash-ai** project → **Settings** → **Environment Variables**, add
   `FRED_API_KEY` with the key, tick **Sensitive**, choose **Production** only, and click **Save**.
   Then go to **Deployments**, open the menu (**⋯**) next to the latest one, and click **Redeploy**.

**Check it:** **/admin** → **By provider** no longer says "Missing FRED_API_KEY" next to FRED.

**What people see:** an answer that used FRED lists the series it used (with a link to it on FRED),
and ends with "This product uses the FRED® API but is not endorsed or certified by the Federal
Reserve Bank of St. Louis." and a link to FRED's API Terms of Use. The Terms of Service and Privacy
Policy say the same. Flash refuses FRED series that are someone else's copyright, as FRED's terms
ask. Don't use the Federal Reserve's logo or say FRED endorses Flash anywhere else (the website,
ads, the app store).

## PageSpeed Insights (scores for published apps, not an AI tool)

**My websites & apps** → **SEO** → **Check with Google** asks Google's free PageSpeed Insights to load
an app's live page on a phone and on a computer, and shows Google's speed, accessibility, best
practices and SEO scores. It works without a key, but Google usually refuses keyless checks (every
keyless caller shares one quota, which can be 0), so add one. It's free: the API has no paid tier, and
the project never needs billing.

1. Open [console.cloud.google.com](https://console.cloud.google.com/) and pick the existing
   **Flash AI Connectors** project in the project list at the top (the one Google Drive in chat uses,
   see docs/connectors-setup.md). Check its name shows at the top before each step. Never turn on
   billing for it: nothing here needs it, and if a page asks for a billing account, stop and close it.
2. **APIs & Services** → **Library**, search for **PageSpeed Insights API**, open it and click
   **Enable**.
3. **APIs & Services** → **Credentials** → **Create credentials** → **API key**. Google shows a key of
   39 characters that starts with `AIza`. Copy it.
4. Click the new key (or **Edit API key**). Under **API restrictions**, choose **Restrict key**, tick
   only **PageSpeed Insights API**, and click **Save**. Leave **Application restrictions** at None:
   Flash's server calls it, not a browser.
5. **APIs & Services** → **PageSpeed Insights API** → **Quotas**: check the queries per day (about
   25,000) and per 100 seconds. Flash sends at most `FLASH_PAGESPEED_DAILY_REQUESTS` a day (5,000 with
   a key), 2 for each check.
6. In Vercel → the **flash-ai** project → **Settings** → **Environment Variables**, add
   `PAGESPEED_API_KEY` with the key, tick **Sensitive**, choose **Production** only, and click
   **Save**.
7. Go to **Deployments**, open the menu (**⋯**) next to the latest one, and click **Redeploy**.

**Check it:** **/admin** → **By provider** shows PageSpeed Insights with no problem next to it, and
its uses grow after someone presses **Check with Google**. A key of the wrong shape shows "PAGESPEED_API_KEY
must be the 39-character key Google Cloud shows".

**What people see:** each owner can check their apps a few times an hour: with a key 10 an hour and
30 a day; without one 3 an hour and 5 a day, as every owner shares the 200 keyless requests a day. A
check of the same version at the same address is kept for a day, so pressing it again doesn't ask
Google or count. When Google refuses, the button hides for a while and Flash's own search check still
works. Google's test opens the app like a visitor: when it can be told apart (`Chrome-Lighthouse` in
its user agent, Lighthouse's own phone, or Lighthouse's computer from an address on Google's list of
its fetchers, see src/lib/server/lighthouse.ts), an app whose AI it would ask gets "not available",
so it doesn't spend the owner's credits, and it isn't counted as a visitor. Real visitors are
answered and counted as always, even while Google tests the app.

## Prices

None of this changes a price. On paid answers, each round of these tools is priced and checked the
same way as the weather forecast's, within the credits held for the answer, and only when the
question asked for that kind of data. On the free lane they cost Flash nothing.
