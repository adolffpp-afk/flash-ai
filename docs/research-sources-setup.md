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

## Prices

None of this changes a price. On paid answers, each round of these tools is priced and checked the
same way as the weather forecast's, within the credits held for the answer, and only when the
question asked for that kind of data. On the free lane they cost Flash nothing.
