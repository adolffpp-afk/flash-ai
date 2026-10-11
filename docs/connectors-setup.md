# Setting up connectors

Connectors let people use their own accounts (GitHub, Notion, Linear, Airtable, Klaviyo, Firecrawl,
Perplexity, Resend, Brevo, or any MCP server they add themselves) in a chat. Some sign in with one
click at the service; the others take an API key. Flash stores each person's key, or the tokens a
sign-in gives it, encrypted with one key of your own, `CONNECTOR_KEYS`. Until it is set, nobody sees connectors, and
only you (the emails in `FLASH_ADMIN_EMAILS`) see a line in Settings > Connectors saying a key is
needed.

## Turn connectors on

1. Sign in to Flash with your owner account and open **/admin** → **By provider**.
2. Under **Connectors**, click **Make a connector key**. Your browser makes 32 random bytes and shows
   them once, like `{"v1":"…"}`. The value never leaves your browser: Flash's server never sees it.
3. Click **Copy**.
4. Open [Vercel](https://vercel.com/) → the **flash-ai** project → **Settings** → **Environment
   Variables**.
5. Add `CONNECTOR_KEYS`, paste the copied value, tick **Sensitive**, choose **Production** only, and
   save.
6. Go to **Deployments**, open the latest one, and click **Redeploy**.

When the deploy is done, **By provider** no longer lists "Missing CONNECTOR_KEYS", and everyone sees
Settings > Connectors.

Keep the value somewhere safe (a password manager). While Flash doesn't have the key that sealed an
account (the value was lost, replaced by mistake, or an older deployment is back), that account shows
as "needs to be connected again" and isn't used. This isn't stored: put the right key back and
redeploy, and every account works again. Only if the key is lost for good do people have to remove
their accounts and add them again. (An account whose own service refuses its key is marked for good.)

## Sign-in (one click)

Notion, Linear, Airtable and Klaviyo connect with **Connect**: the person signs in at the service
and comes back to Flash, which never sees their password. (Linear and Airtable can still take a key
under "Use a key instead".) A server someone adds themselves signs in the same way when it asks for
it, and waits for them to look at its tools before it is added. It can only do that if its sign-in
service says which service it is when it sends people back (the `iss` of RFC 9207); one that doesn't
is refused, because Flash couldn't tell its sign-in from another service's (a "mix-up").

There is nothing to set up and no new environment variable:

- Flash introduces itself to each service with a public page,
  `<your address>/oauth/mcp-client.json` (its Client ID Metadata Document), or, when the service
  doesn't take that, by registering itself there (Dynamic Client Registration). Either way it does
  this once per service and keeps it for everyone. Usually no secret is involved; if a service gives
  Flash one when it registers, it is kept encrypted with `CONNECTOR_KEYS`.
- The service sends people back to `<your address>/api/connect/mcp/callback`. "Your address" is
  `FLASH_APP_URL` (already set for email links), else the address the page was opened at. People
  must be signed in to Flash at that same address for the sign-in to finish.
- A few servers don't let Flash register itself. Then the person makes a client in that server's
  settings with the callback address shown under **Advanced**, and types its client ID (and secret,
  if it has one) there. Those are kept encrypted, for that person only.

Flash renews a sign-in's access as it runs out, one renewal at a time per account. If the service
refuses (the person cancelled Flash's access there, or the sign-in was revoked), the account shows
**Reconnect** and isn't used until they sign in again. Removing a signed-in account in Settings also
asks the service to cancel Flash's access, where the service offers a way to (a revocation
endpoint). Where it doesn't, Settings tells the person to cancel it in their account there. Signing
in, renewing and removing cost no credits.

## GitHub

GitHub works through a GitHub App that you make once, for everyone. People connect it with
**Connect**: GitHub asks them whether Flash may act for them and, the first time, which of their
repositories Flash may use (it installs the app there). In a chat Flash can then list their repositories, read files, search code, and read
issues and pull requests by itself. Creating an issue or opening a pull request (from a branch that
already exists) always waits on a card for **Approve**, showing the repository, title, text and
branches. Nothing costs credits except the chat itself.

GitHub stays hidden from everyone until all three of its variables below are set (and
`CONNECTOR_KEYS`). Until then, /admin → **By provider** → **Connectors** shows a **GitHub** line
with the missing names. The "Continue with GitHub" sign-in button is a different app
(`GITHUB_CLIENT_ID`, see docs/sign-in-setup.md): leave it as it is.

### Make the GitHub App (about 10 minutes, in Firefox or any browser)

1. Sign in to [GitHub](https://github.com/) with the account that should own the app.
2. Click your picture (top right) → **Settings**.
3. At the bottom of the left menu, click **Developer settings** → **GitHub Apps** → **New GitHub
   App**. (GitHub may ask for your password or a code again.)
4. Fill in the form from top to bottom:
   - **GitHub App name**: `Flash AI`. If GitHub says the name is taken, try `Flash AI Chat`.
   - **Homepage URL**: `https://www.flash-app.dev`
   - Under **Identifying and authorizing users**:
     - **Callback URL**: `https://www.flash-app.dev/api/connect/github/callback`
     - **Expire user authorization tokens**: ticked (it usually is already).
     - **Request user authorization (OAuth) during installation**: ticked.
     - **Enable Device Flow**: not ticked.
   - Under **Post installation**: leave **Setup URL** empty.
   - Under **Webhook**: untick **Active**. (The Webhook URL box then disappears.)
   - Under **Permissions** → **Repository permissions**, set these four and leave the rest at
     "No access":
     - **Contents**: Read and write
     - **Issues**: Read and write
     - **Metadata**: Read-only (GitHub sets this one by itself)
     - **Pull requests**: Read and write
   - Leave **Organization permissions** and **Account permissions** at "No access".
   - **Where can this GitHub App be installed?**: **Any account** (so everyone can use it, not
     only you).
5. Click **Create GitHub App**. You land on the app's **General** page.
6. Copy these three things into a note for a minute:
   - **Client ID**, near the top (it looks like `Iv23li…`). This is `GITHUB_APP_CLIENT_ID`.
     (Not the "App ID", which is only digits.)
   - Under **Client secrets**, click **Generate a new client secret** and copy it right away:
     GitHub shows it only once. This is `GITHUB_APP_CLIENT_SECRET`.
   - The **slug**: the app's own address, shown as **Public link**, ends with it. For
     `https://github.com/apps/flash-ai` the slug is `flash-ai`. This is `GITHUB_APP_SLUG`.
   You don't need a private key: Flash only acts for the person, with what they gave it.

### Put them in Vercel

1. Open [Vercel](https://vercel.com/) → the **flash-ai** project → **Settings** → **Environment
   Variables**.
2. Add `GITHUB_APP_CLIENT_ID` with the Client ID. Choose **Production** only, and save.
3. Add `GITHUB_APP_SLUG` with the slug. Choose **Production** only, and save.
4. Add `GITHUB_APP_CLIENT_SECRET` with the client secret, tick **Sensitive**, choose
   **Production** only, and save.
5. Go to **Deployments**, open the latest one, and click **Redeploy**.

When the deploy is done, /admin → **By provider** → **Connectors** says GitHub is set, and GitHub
shows in everyone's Settings > Connectors. Delete the note with the secret.

To make a new secret later: on the app's **General** page, generate a new one, put it in Vercel in
place of the old one, redeploy, and then delete the old secret on GitHub.

### What people see

- **Connect** opens GitHub, where they say yes to Flash. The first time, GitHub then shows the app's
  install page, where they pick the repositories (all, or only some) and click **Install**. They
  come back to Flash, connected. Flash asks GitHub which installations they really have, and never
  takes the installation number from the address the browser comes back with.
- Flash keeps their access for 8 hours and renews it by itself (one renewal at a time). After about
  6 months without use, or if they cancel Flash at GitHub, the account shows **Reconnect**.
- **Remove** in Settings > Connectors also cancels Flash's access at GitHub. The app stays installed
  on their repositories, doing nothing, until they uninstall it on GitHub: their picture →
  **Settings** → **Applications** → **Installed GitHub Apps** → **Configure** → **Uninstall**.
  To give Flash more or fewer repositories, they change them on that same page.

## Change the key (rotation)

Every stored key or token says which version sealed it, so old ones keep working while new ones use
the newest version.

1. On /admin → **By provider** → **Connectors**, click **Make a new key version** and copy it.
2. In Vercel, edit `CONNECTOR_KEYS` and add the new key beside the old one with the next number:
   `{"v1":"<old>","v2":"<new key>"}`. Redeploy.
   Then check /admin → **By provider** → **Connectors**: it says which version seals new keys
   ("New keys are sealed with v2"), and lists any entry it can't read (a name like `V2`, or a key
   that isn't 32 bytes) so you can fix it. Flash's logs say the same, by name, never the value.
3. Only drop `v1` once nothing uses it. /admin → **By provider** → **Connectors** lists what is
   "Still sealed with v1" (accounts, and Flash's registrations at sign-in services); it must be gone.
   In the database, both of these must be 0:
   `SELECT COUNT(*) FROM connections WHERE key_version = 'v1';`
   `SELECT COUNT(*) FROM mcp_client_registrations WHERE key_version = 'v1';`
   Opening /admin after the redeploy moves every one of Flash's registrations, and every client ID
   someone typed in, to the new version at once, used or not, so they leave that list then. A
   signed-in account moves to the new version by itself the next time its access is renewed while
   it is used. One with a key, or a server added by address, keeps `v1` until it is removed and
   added again. An account sealed with a dropped version shows as "needs to be connected again" and
   stops working until its owner removes it and adds it again, or the version is put back.
   If `v1` was dropped too soon, a registration it sealed stays listed. A client ID someone typed in
   is asked for again when they next connect. Flash's own registration at a service refuses sign-ins
   there ("Flash can't open its sign-in details for that server right now") until `v1` is put back
   and /admin opened again; or delete that row from `mcp_client_registrations`, and Flash registers
   again at the next sign-in there (accounts that signed in through it then need Reconnect).

## Try it without real accounts

1. In one terminal: `node --experimental-strip-types scripts/mock-connectors.ts`
   (it prints its pid; stop it with `kill <pid>`).
2. In another: set a test `CONNECTOR_KEYS` in `.env.local`, then
   `FLASH_CONNECT_MOCK=http://127.0.0.1:7788 npm run dev`. Every preset now talks to the mock, and
   you can add `http://127.0.0.1:7788/mcp` as your own connector. The flag is ignored on Vercel.
3. Connect a preset with any key, turn it on in a chat with the plug button, and ask Flash to "echo
   hello" (a read: it runs by itself) or "send a note to Sam" (a write: a card waits for Approve).
   The mock's terminal prints every call it gets.
4. Notion, Klaviyo (and Linear or Airtable with **Connect**) sign in at the mock's stand-in
   authorization server, which says yes at once. Add `http://127.0.0.1:7788/oauth/mcp` as your own
   connector to try a server that asks for a sign-in. Start the mock with `MOCK_ACCESS_TTL=65` to
   have its access run out after 65 seconds and see Flash renew it.
5. GitHub: also put `GITHUB_APP_CLIENT_ID=mock-github-client`,
   `GITHUB_APP_CLIENT_SECRET=mock-github-secret` and `GITHUB_APP_SLUG=flash-ai-test` in
   `.env.local`. **Connect** on GitHub "installs" the app at once on the mock's two repositories
   (`octo/hello` and `octo/site`) and comes back to `http://localhost:3000`; start the mock with
   `MOCK_GITHUB_CALLBACK=<your address>/api/connect/github/callback` if Flash runs elsewhere. Ask
   Flash to "read README.md in octo/hello" (a read) or "open an issue in octo/hello" (a card).
   `MOCK_ACCESS_TTL=65` makes GitHub's access run out after 65 seconds too.

## Deleting someone's account by hand

If they can still sign in, have them remove their accounts in Settings > Connectors first: for an
account that signed in, that also asks the service to cancel Flash's access, where the service
offers a way to. Deleting rows by hand doesn't.

Their connector rows go with them when foreign keys are on. To be sure, delete them yourself first:

```sql
DELETE FROM pending_actions WHERE user_id = '<user id>';
DELETE FROM connection_tools WHERE connection_id IN (SELECT id FROM connections WHERE user_id = '<user id>');
DELETE FROM connections WHERE user_id = '<user id>';
DELETE FROM connect_flows WHERE user_id = '<user id>';
DELETE FROM mcp_client_registrations WHERE owner_user_id = '<user id>';
```

This removes the keys and tokens from Flash only. It doesn't cancel them at GitHub, Linear,
Airtable and the rest; the person does that in their account there (for GitHub: their picture →
**Settings** → **Applications** → **Authorized GitHub Apps** → **Revoke**, and **Installed GitHub
Apps** → **Configure** → **Uninstall**).
