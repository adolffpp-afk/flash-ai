# Setting up connectors

Connectors let people use their own accounts (GitHub, Google Drive, Notion, Linear, Airtable, Klaviyo,
Firecrawl, Perplexity, Resend, Brevo, or any MCP server they add themselves) in a chat. Some sign in with one
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
     - **Contents**: Read-only
     - **Issues**: Read and write
     - **Metadata**: Read-only (GitHub sets this one by itself)
     - **Pull requests**: Read and write

     Contents stays **Read-only**: Flash reads files and opens pull requests from branches that
     already exist, and writes no file. A later "Put this app on GitHub" step will ask for more,
     and GitHub will then ask each person who installed the app to accept it.
   - Leave **Organization permissions** and **Account permissions** at "No access".
   - **Where can this GitHub App be installed?**: **Any account** (so everyone can use it, not
     only you).
5. Click **Create GitHub App**. You land on the app's **General** page.

   If you made the app earlier with **Contents: Read and write**, lower it: on the app's page,
   click **Permissions & events** → **Repository permissions** → **Contents** → **Read-only** →
   **Save changes**. GitHub asks people to accept only permissions that are added, so nobody has to
   do anything.
6. Copy these three things into a note for a minute:
   - **Client ID**, near the top of the **General** page (it looks like `Iv23li…`). This is
     `GITHUB_APP_CLIENT_ID`. (Not the "App ID", which is only digits.)
   - The **slug**: the app's own address, shown as **Public link** on the **General** page, ends
     with it. For `https://github.com/apps/flash-ai` the slug is `flash-ai`. This is `GITHUB_APP_SLUG`.
   - The client secret, which GitHub keeps on a page of its own: in the app's left menu, click
     **Credentials**, then under **Client secrets** click **New secret**, and copy it right away:
     GitHub shows it only once. This is `GITHUB_APP_CLIENT_SECRET`.
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

To make a new secret later: on the app's **Credentials** page (in its left menu), under **Client
secrets**, click **New secret**, put it in Vercel in place of the old one, redeploy, and then delete
the old secret on that same page.

### What people see

- **Connect** opens GitHub, where they say yes to Flash. The first time, GitHub then shows the app's
  install page, where they pick the repositories (all, or only some) and click **Install**. They
  come back to Flash, connected. Flash asks GitHub which installations they really have, and never
  takes the installation number from the address the browser comes back with.
- Settings > Connectors shows the account as **GitHub · their login**, and every **Approve** card
  says which GitHub account it is for. Connecting again while signed in to GitHub as someone else
  replaces the account, and whatever was still waiting for **Approve** on the old one is removed.
- **Add repositories on GitHub**, on the connected account in Settings > Connectors, opens the app's
  install page: they can install it on their own account or on an organization (whose owner may
  have to approve it), or pick more repositories, and they come back to Flash. Flash's notes point
  there when GitHub says it can't find or reach a repository. If the app is already installed on
  the account they pick, GitHub shows that installation's settings instead; after **Save** they go
  back to Flash themselves.
- Flash keeps their access for 8 hours and renews it by itself (one renewal at a time). After about
  6 months without use, or if they cancel Flash at GitHub, the account shows **Reconnect**.
- **Remove** in Settings > Connectors also cancels Flash's access at GitHub. The app stays installed
  on their repositories, doing nothing, until they uninstall it on GitHub: their picture →
  **Settings** → **Applications** → **Installed GitHub Apps** → **Configure** → **Uninstall**.
  To give Flash fewer repositories, they change them on that same page.

## Google Drive

Google Drive works through a Google Cloud project that you make once, for everyone. People connect it
with **Connect**: Google asks whether Flash may see their email address and "see, edit, create and
delete only the specific Google Drive files you use with this app" (the `drive.file` permission).
Then, under their Google Drive account in Settings > Connectors, **Add from Drive** opens Google's own
file picker, showing only Docs, Sheets, Slides, PDFs and text files. Flash can open only the files
they pick there and the files Flash made for them, never the rest of their Drive, and Settings lists
those files, each with **Forget**. In a chat Flash reads a picked file by itself (a Doc or Slides deck
as text, a Sheet as CSV, a PDF's text). Creating a Doc, Sheet or Slides deck, adding rows to a Sheet
or adding text to a Doc always waits on a card for **Approve**, showing the title and everything that
will be written. Nothing costs credits except the chat itself.

Google Drive stays hidden from everyone until all four of its variables below are set (and
`CONNECTOR_KEYS`). Until then, /admin → **By provider** → **Connectors** shows a **Google Drive**
line with the missing names. The "Continue with Google" sign-in button is a different client
(`GOOGLE_CLIENT_ID`, see docs/sign-in-setup.md): leave it as it is. Never turn on billing for this
project: nothing here needs it, and if a page asks for a billing account, stop and close it.

### Make the Google Cloud project (about 30 minutes, in Firefox or any browser)

1. Open [console.cloud.google.com](https://console.cloud.google.com/) and sign in with the Google
   account that should own it. Accept the terms if Google asks.
2. Make the project: click the project list at the top of the page (next to "Google Cloud") →
   **New project**. **Project name**: `Flash AI Connectors`. Leave the rest, click **Create**, and
   wait a few seconds. Open the project list again and click **Flash AI Connectors**. Check that its
   name shows at the top of the page before each step below.
3. Turn on five APIs: click the menu (☰, top left) → **APIs & Services** → **Library**. For each of
   these, type its name in the search box, click it, and click **Enable**:
   **Google Drive API**, **Google Picker API**, **Google Docs API**, **Google Sheets API**,
   **Google Slides API**. (Go back to **Library** between them.)
4. Start the consent screen: ☰ → **APIs & Services** → **OAuth consent screen**. This opens
   **Google Auth Platform**. Click **Get started** and fill in:
   - **App name**: `Flash AI`; **User support email**: your email. **Next**.
   - **Audience**: **External**. **Next**.
   - **Contact information**: your email. **Next**.
   - Tick that you agree to the Google API Services: User Data Policy. **Continue**, then **Create**.
5. In the left menu click **Branding** and fill in:
   - **Application home page**: `https://www.flash-app.dev`
   - **Application privacy policy link**: `https://www.flash-app.dev/privacy`
   - **Application terms of service link**: `https://www.flash-app.dev/terms`
   - **Authorized domains**: click **Add domain** and type `flash-app.dev`.
   - **Developer contact information**: your email.
   - An **App logo** is optional. Click **Save**.
6. In the left menu click **Data Access** → **Add or remove scopes**. Tick exactly these three:
   `openid`, `.../auth/userinfo.email`, and `.../auth/drive.file` ("See, edit, create, and delete
   only the specific Google Drive files you use with this app"). If `drive.file` isn't in the list,
   paste `https://www.googleapis.com/auth/drive.file` into **Manually add scopes** and click **Add to
   table**, then tick it. Click **Update**, then **Save**. Don't add any other scope: `drive.file`
   doesn't need Google's security review, and broader Drive scopes do.
7. In the left menu click **Clients** → **Create client**:
   - **Application type**: **Web application**. **Name**: `Flash AI web`.
   - **Authorized JavaScript origins** → **Add URI**: `https://www.flash-app.dev`
   - **Authorized redirect URIs** → **Add URI**: `https://www.flash-app.dev/api/connect/google/callback`
   - Click **Create**. A window shows the **Client ID** (it ends in `.apps.googleusercontent.com`)
     and the **Client secret**. Copy both into a note right away: Google shows the secret only
     once. The Client ID is `GOOGLE_CONNECT_CLIENT_ID`, the secret `GOOGLE_CONNECT_CLIENT_SECRET`.
8. Make the Picker's API key: ☰ → **APIs & Services** → **Credentials** → **Create credentials** →
   **API key**. Copy the key into your note (this is `GOOGLE_PICKER_API_KEY`), then click **Edit API
   key** (or the key's name in the list) and set:
   - **Name**: `Flash AI Picker`
   - **Application restrictions**: **Websites**. Add two: `https://www.flash-app.dev/*` and
     `https://docs.google.com/*`. Google's picker runs in a frame on docs.google.com, and without
     that second line it says the key is invalid.
   - **API restrictions**: **Restrict key**, and tick only **Google Picker API**.
   - Click **Save**. This key is public by design (it identifies the project, it opens nothing); the
     restrictions stop other sites from using it.
9. Find the project number: ☰ → **Cloud overview** → **Dashboard**. The **Project info** box shows
   **Project number** (only digits, like `123456789012`; not the project ID, which has letters).
   Copy it: this is `GOOGLE_CONNECT_PROJECT_NUMBER`.
10. Publish: ☰ → **APIs & Services** → **OAuth consent screen** → **Audience** → **Publish app** →
    **Confirm**. The status becomes **In production**. (While it says "Testing", only test users can
    connect, and Google ends their access after 7 days.)
11. Brand verification: in the left menu click **Verification Center**. If it asks for verification,
    click **Prepare for verification** (or **Submit**), check the details, and submit. Google may ask
    you to prove you own `flash-app.dev`: it links to Google Search Console, where you add the domain
    and get a TXT record. Add it where `flash-app.dev`'s DNS is kept, which is GoDaddy: **My Products**
    → `flash-app.dev` → **DNS** → **Add New Record** (type `TXT`, name `@`, value as given), then click
    **Verify** in Search Console. Google usually answers
    within a few working days, by email. Connecting works meanwhile; Google may show the web address
    instead of the app's name until it is done.

### Put them in Vercel

1. Open [Vercel](https://vercel.com/) → the **flash-ai** project → **Settings** → **Environment
   Variables**.
2. Add `GOOGLE_CONNECT_CLIENT_ID` with the Client ID. Choose **Production** only, and save.
3. Add `GOOGLE_PICKER_API_KEY` with the API key. Choose **Production** only, and save.
4. Add `GOOGLE_CONNECT_PROJECT_NUMBER` with the project number. Choose **Production** only, and save.
5. Add `GOOGLE_CONNECT_CLIENT_SECRET` with the client secret, tick **Sensitive**, choose
   **Production** only, and save.
6. Add `MALLOC_ARENA_MAX` with the value `2`. Choose **Production** only (it isn't secret), and
   save. Flash reads PDFs from Drive in threads of their own, and without this the server keeps
   memory those threads gave back, a little more each time PDFs are read at the same time, until it
   refuses to read PDFs ("Flash can't read PDFs right now") until Vercel starts a fresh one. It
   works only when it is in the environment as the server starts: setting it any other way (in
   code, say) does nothing.
7. Go to **Deployments**, open the latest one, and click **Redeploy**. Variables added or changed
   reach the server only with a new deploy.

When the deploy is done, /admin → **By provider** → **Connectors** says Google Drive is set, and
Google Drive shows in everyone's Settings > Connectors. Under it, a line says "MALLOC_ARENA_MAX was 2
when this server started". If it says MALLOC_ARENA_MAX wasn't set, check the variable's name and
value, and that it is set for Production, then redeploy. (If it still says so, PDFs are still read
safely, but after many have been read at the same time a server may refuse them for a while, until
Vercel replaces it.) Delete the note with the secret.

To make a new secret later: in **Google Auth Platform** → **Clients** → `Flash AI web`, click **Add
secret**, put the new one in Vercel in place of the old one, redeploy, and then disable and delete
the old secret there.

### What people see

- **Connect** opens Google, where they pick their account and say yes. If they untick access to
  their Drive files, Flash keeps nothing it can use: the account shows **Reconnect** and a note
  asks them to allow it.
- **Add from Drive** opens Google's picker (its script is loaded from Google only then). They pick
  up to 20 files at a time, 100 in all. Flash asks Google about each one and keeps the name and type
  Google gives. **Forget** takes a file off the list; Flash can't open it in chat any more.
- A Doc, Sheet or deck Flash made after **Approve** is added to that list, so a later reply can read
  it or add to it. One call holds at most about 15,000 characters, so a longer Doc or Sheet is
  written in parts: the first card makes it, and after **Continue the answer** each further card
  adds the next part at its end. A deck can't be added to, so its slides are kept short.
- Flash keeps their access for about an hour and renews it by itself (one renewal at a time). If
  they cancel Flash at Google, the account shows **Reconnect**.
- Connecting again as another Google account replaces the account: the files picked in the old one
  and whatever was still waiting for **Approve** on it are removed, and Flash's access to the old one
  is cancelled at Google.
- **Remove** in Settings > Connectors also cancels all of Flash's access at Google and forgets the
  picked files. They can also cancel it themselves at
  [myaccount.google.com/connections](https://myaccount.google.com/connections).

## Figma and Canva

Figma and Canva each work through an app you register once, for everyone, in their developer
settings. Both are free. People connect them with **Connect**, sign in at Figma or Canva and say yes.

- **Figma** only reads. In a chat with Figma on, a person pastes a Figma link and asks, for example,
  "build this screen as an app". Flash reads the file's pages and frames, then the frame as a spec
  (sizes, auto layout, colours, corners, borders, shadows, text styles). Figma counts these reads:
  people on a View or Collab seat get only a few a month (Figma's rule, per app), people on a paid
  Dev or Full seat get many more. When the limit is reached Flash says so and doesn't try again.
  Figma has no way for Flash to cancel its access, so **Remove** says to remove Flash in Figma too.
- **Canva**, in a chat with Canva on: find designs, read one (its title, pages and the words on
  them) and export one as PNG, JPG or PDF download links that last a day. In **My creations**, a
  picture Flash made gets a **Canva** button once Canva is connected: it puts the picture in their
  Canva uploads and opens a new Canva design with it. **Remove** also cancels Flash's access at Canva.

Nothing costs credits except the chat itself; Figma's and Canva's APIs cost Flash nothing.

Until Figma or Canva has reviewed Flash's app, it only works for the account that made it. So each
is shown only to the owners (`FLASH_ADMIN_EMAILS`) until its `..._PUBLIC` variable is `true`. /admin →
**By provider** → **Connectors** shows a line for each: missing variables, set for you only, or open
to everyone.

### Make the Figma app (about 10 minutes)

1. Sign in to Figma in your browser, then open
   [figma.com/developers/apps](https://www.figma.com/developers/apps) and click **Create a new app**.
2. Name: `Flash AI`. Website: `https://www.flash-app.dev`. Pick your team (any team works, a free
   one too), add the Flash logo if it asks, and click **Create app**.
3. Copy the **Client ID** and the **Client secret** into a note. The secret is shown only once.
4. Open **OAuth credentials** and add the redirect URL
   `https://www.flash-app.dev/api/connect/figma/callback`. Save.
5. Open **OAuth scopes** and tick only `current_user:read` and `file_content:read`. Save.
6. Open **Publish**, choose **Public**, and fill in: a short description ("Flash AI reads the Figma
   frames a user links to, so it can build them as an app or as code. It never changes files."),
   the privacy policy `https://www.flash-app.dev/privacy`, the terms `https://www.flash-app.dev/terms`,
   and testing steps ("Sign in at flash-app.dev, Settings > Connectors > Figma > Connect, then in a
   chat with Figma on, paste a Figma frame link and ask Flash to describe it"). Submit it for review.

### Make the Canva integration (about 10 minutes)

1. Canva asks for two-step sign-in first: in Canva, **Settings** → **Login & security** → turn on
   **Multi-factor authentication**.
2. Open [canva.com/developers/integrations/connect-api](https://www.canva.com/developers/integrations/connect-api)
   and click **Create an integration**. Choose **Public**, accept the terms, and click **Create integration**.
3. Name: `Flash AI`. Copy the **Client ID**, click **Generate secret** and copy the secret into a
   note. It is shown only once.
4. Under **Scopes**, tick `profile:read`, `design:meta:read`, `design:content:read`,
   `design:content:write`, `asset:read` and `asset:write`. Nothing else.
5. Under **Authentication**, add the authorized redirect
   `https://www.flash-app.dev/api/connect/canva/callback`. Save.
6. Fill in the listing (description, logo, privacy policy and terms links as for Figma, and why each
   scope is needed: reading designs to answer in chat, exporting them, and adding a Flash picture to
   the user's uploads and starting a design with it when they press Open in Canva). Submit it for review.

### Put them in Vercel

1. [Vercel](https://vercel.com/) → **flash-ai** → **Settings** → **Environment Variables**.
2. Add `FIGMA_CONNECT_CLIENT_ID` and `CANVA_CONNECT_CLIENT_ID` (Production only).
3. Add `FIGMA_CONNECT_CLIENT_SECRET` and `CANVA_CONNECT_CLIENT_SECRET`, tick **Sensitive**,
   Production only.
4. **Deployments** → latest → **Redeploy**.

Figma and Canva now show in your own Settings > Connectors, so you can try them while the reviews
run. When Figma approves the app, add `FIGMA_CONNECT_PUBLIC` with the value `true` and redeploy;
the same with `CANVA_CONNECT_PUBLIC` when Canva approves the integration. Then everyone sees them.
Delete the note with the secrets.

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
6. Google Drive: also put `GOOGLE_CONNECT_CLIENT_ID=mock-google-client.apps.googleusercontent.com`,
   `GOOGLE_CONNECT_CLIENT_SECRET=mock-google-secret`, `GOOGLE_PICKER_API_KEY=mock-key` and
   `GOOGLE_CONNECT_PROJECT_NUMBER=123456789012` in `.env.local`. **Connect** says yes at once and
   comes back to `http://localhost:3000` (start the mock with
   `MOCK_GOOGLE_CALLBACK=<your address>/api/connect/google/callback` if Flash runs elsewhere).
   **Add from Drive** shows a plain list of the mock's files in place of Google's picker. Pick
   "Budget" and ask Flash "what does the hotel cost in my budget?" (a read), or "make a Doc with my
   packing list" (a card). `MOCK_ACCESS_TTL=65` makes Google's access run out after 65 seconds too.

## Deleting someone's account by hand

If they can still sign in, have them remove their accounts in Settings > Connectors first: for an
account that signed in, that also asks the service to cancel Flash's access, where the service
offers a way to. Deleting rows by hand doesn't.

Their connector rows go with them when foreign keys are on. To be sure, delete them yourself first:

```sql
DELETE FROM pending_actions WHERE user_id = '<user id>';
DELETE FROM connection_tools WHERE connection_id IN (SELECT id FROM connections WHERE user_id = '<user id>');
DELETE FROM connection_files WHERE connection_id IN (SELECT id FROM connections WHERE user_id = '<user id>');
DELETE FROM connections WHERE user_id = '<user id>';
DELETE FROM connect_flows WHERE user_id = '<user id>';
DELETE FROM mcp_client_registrations WHERE owner_user_id = '<user id>';
```

Their low-credit email settings (Credits > Top up) don't go with them either while foreign keys are
off, as they are on Turso. Delete them last, once their `users` row and their apps are gone, so a
request of theirs still finishing, or a visitor of one of their apps, can't write the row back in
between (once the `users` row is gone, nothing does). `deleteUserAlerts` in
`src/lib/server/low-balance.ts` does the same:

```sql
DELETE FROM credit_alerts WHERE user_id = '<user id>';
```

This removes the keys and tokens from Flash only. It doesn't cancel them at GitHub, Linear,
Airtable and the rest; the person does that in their account there (for GitHub: their picture →
**Settings** → **Applications** → **Authorized GitHub Apps** → **Revoke**, and **Installed GitHub
Apps** → **Configure** → **Uninstall**; for Google: [myaccount.google.com/connections](https://myaccount.google.com/connections)
→ **Flash AI** → **Delete all connections you have with Flash AI**).
