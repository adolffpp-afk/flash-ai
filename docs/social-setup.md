# Setting up the Social hub

The Social hub lets people post to their own social accounts from Flash, all at once or at a planned
time, and answer comments, mentions, messages and reviews in one place. Everything (accounts, posts,
the inbox) is kept in Flash's own database, and each account's tokens are sealed with
`CONNECTOR_KEYS` like connectors' (see docs/connectors-setup.md).

Ten networks:

| Network | How people connect | What you set up |
| --- | --- | --- |
| Bluesky | handle + app password | nothing |
| Mastodon | their server + access token | nothing |
| Telegram | their bot's token + channel | nothing |
| X | sign in at X | an X developer app, and X's pay-per-use credit |
| YouTube | sign in with Google | one Google Cloud project (shared with Business Profile) |
| Google Business Profile | sign in with Google | the same project, plus Google's access form |
| Pinterest | sign in at Pinterest | a Pinterest app |
| Facebook Pages | sign in with Facebook | one Meta app (its own keys) |
| Instagram | sign in with Instagram | the same Meta app (Instagram's keys) |
| Threads | sign in with Threads | the same Meta app (Threads' keys) |

Until `FLASH_SOCIAL_OPEN` is `true`, only the owners (`FLASH_ADMIN_EMAILS`) see **Social hub** in the
menu. /admin → **By provider** → **Social hub** lists what each network still needs.

Planned posts go out on Vercel Cron's `/api/cron/social`, every minute, which needs `CRON_SECRET`
(docs/automations-setup.md). Without it, "Post now" still works.

Every sign-in network sends people back to the same address. Wherever a step asks for a
**redirect URI** or **callback URL**, paste exactly:

```
https://www.flash-app.dev/api/social/callback
```

After adding any variable in Vercel, redeploy (Deployments → latest → **Redeploy**).

## X

X charges for its API by use. Flash charges people credits for each X post (more with a link) and for
checking X mentions, at least 2.5 times X's price, so X can't run at a loss. Flash doesn't read X
mentions on its own; people press **Check now** in the Inbox.

1. Go to [console.x.com](https://console.x.com) and sign in with the X account that will own the app
   (Flash's own X account is best).
2. Accept the developer terms if asked.
3. Open **Billing** (or **Credits**), add a card and buy a small amount of credit, like $10. Posts
   stop with "The network refused this post" when the credit runs out.
4. Open **Apps** → **Create app**. Name it **Flash**.
5. In the app, open **User authentication settings** → **Set up**:
   - **App permissions**: **Read and write**.
   - **Type of App**: **Web App, Automated App or Bot** (a confidential client).
   - **Callback URI / Redirect URL**: the address above.
   - **Website URL**: `https://www.flash-app.dev`
   - **Terms of service**: `https://www.flash-app.dev/terms`, **Privacy policy**:
     `https://www.flash-app.dev/privacy`
   - Save.
6. Open **Keys and tokens**. Under **OAuth 2.0 Client ID and Client Secret**, click **Regenerate** (or
   **Generate**). Copy both. The secret is shown once.
7. In Vercel → **flash-ai** → **Settings** → **Environment Variables**, add `SOCIAL_X_CLIENT_ID` and
   `SOCIAL_X_CLIENT_SECRET` (tick **Sensitive** for the secret), Production only, and redeploy.

Flash asks X for: read and write posts, read the user's profile, upload media, and stay signed in.

## YouTube and Google Business Profile

One Google Cloud project serves both. Use a new project, not the Google sign-in one or "Flash AI
Connectors", so Google's reviews of these powerful permissions don't hold the others up.

1. Go to [console.cloud.google.com](https://console.cloud.google.com), click the project picker at the
   top → **New project**. Name it **Flash Social**, click **Create**, and pick it.
2. **APIs & Services** → **Library**. Search for and **Enable** each of:
   - **YouTube Data API v3**
   - **My Business Account Management API**
   - **My Business Business Information API**
   - **Google My Business API** (the v4 API, for posts and reviews)
3. **Google Auth Platform** (or **OAuth consent screen**) → **Get started**:
   - App name **Flash**, support email `support@flash-app.dev`.
   - Audience: **External**.
   - Contact email: yours. Accept, **Create**.
4. **Branding**: add the logo, home page `https://www.flash-app.dev`, privacy policy
   `https://www.flash-app.dev/privacy`, terms `https://www.flash-app.dev/terms`, and under
   **Authorized domains** add `flash-app.dev`. Save.
5. **Data access** → **Add or remove scopes**. Paste these three in **Manually add scopes**, then
   **Add to table** → **Update** → **Save**:
   - `https://www.googleapis.com/auth/youtube.upload`
   - `https://www.googleapis.com/auth/youtube.force-ssl`
   - `https://www.googleapis.com/auth/business.manage`
6. **Clients** → **Create client**: type **Web application**, name **Flash Social**. Under
   **Authorized redirect URIs** click **Add URI** and paste the address above. **Create**, and copy the
   **Client ID** and **Client secret**.
7. In Vercel add `SOCIAL_GOOGLE_CLIENT_ID` and `SOCIAL_GOOGLE_CLIENT_SECRET` (Sensitive), Production
   only, and redeploy.
8. While the app is in **Testing**, only people you add under **Audience** → **Test users** can sign
   in (up to 100). Add your own Google account to try it.

What Google still has to approve (it can take weeks; Flash works for test users meanwhile):

- **Verification**: **Audience** → **Publish app**, then **Verification Center** → **Prepare for
  verification**. Google asks for a short video showing the sign-in and what Flash does with
  YouTube and Business Profile. The YouTube permissions are "sensitive", so this is required.
- **YouTube audit**: until Google audits the project, videos Flash uploads are locked as **private**.
  Ask for it at the [YouTube API audit form](https://support.google.com/youtube/contact/yt_api_form)
  (choose "API compliance audit"). After it passes, uploads go out public.
- **Business Profile API access**: until Google opens it, connecting a business says "Google hasn't
  opened its Business Profile API to Flash yet." Ask for it at the
  [Business Profile API access form](https://developers.google.com/my-business/content/prereqs)
  ("Request access to the API"), with the project number from the Cloud console **Dashboard**. You
  need a verified Business Profile of your own that has been active for 60+ days.

## Pinterest

1. Go to [developers.pinterest.com](https://developers.pinterest.com) and sign in with a Pinterest
   **business** account (convert one for free in Pinterest's settings if needed).
2. **My apps** → **Connect app**. Fill in name **Flash**, description, website
   `https://www.flash-app.dev`, privacy policy `https://www.flash-app.dev/privacy`, and submit.
3. Pinterest gives **Trial access** first: it works for your own account, and pins can be seen only
   by you. In the app, under **Redirect URIs**, add the address above and save.
4. Copy the **App ID** and **App secret key**.
5. In Vercel add `SOCIAL_PINTEREST_CLIENT_ID` (the App ID) and `SOCIAL_PINTEREST_CLIENT_SECRET`
   (Sensitive), Production only, and redeploy.
6. To let everyone use it, ask for **Standard access** in the app's page. Pinterest wants a short
   video of a pin being made from Flash; record it once trial access works.

## Facebook, Instagram and Threads (one Meta app)

One Meta app at [developers.facebook.com/apps](https://developers.facebook.com/apps), with the use
cases **Manage everything on your Page**, **Manage messaging & content on Instagram** and **Access
the Threads API**, owned by a verified business portfolio. It has three pairs of keys:

| Variable | Where it is |
| --- | --- |
| `SOCIAL_META_APP_ID` / `SOCIAL_META_APP_SECRET` | App settings → Basic |
| `SOCIAL_META_CONFIG_ID` (optional) | Facebook Login for Business → Configurations |
| `SOCIAL_INSTAGRAM_APP_ID` / `SOCIAL_INSTAGRAM_APP_SECRET` | Instagram use case → API setup with Instagram login |
| `SOCIAL_THREADS_APP_ID` / `SOCIAL_THREADS_APP_SECRET` | Threads use case → Settings |

Every sign-in sends people back to the redirect address above; paste it in Facebook Login for
Business's **Valid OAuth Redirect URIs**, Instagram's **OAuth redirect URIs** and Threads'
**Redirect Callback URLs**. Meta's own calls go to:

- Deauthorize / uninstall: `https://www.flash-app.dev/api/social/meta/deauthorize` (the accounts
  are marked "needs to be connected again")
- Data deletion: `https://www.flash-app.dev/api/social/meta/delete` (the accounts are deleted, with
  their posts and inbox)

Both take only requests signed with one of the three secrets.

How each works:

- **Facebook**: the person picks Pages at sign-in; Flash keeps only each Page's own token (it
  doesn't run out), never the person's. Posts (words with a link, a picture or a video), comments
  on the Page picked in Accounts (Messenger messages too, once the app has pages_messaging: Meta's
  Page use case doesn't offer it, so Flash doesn't ask for it yet).
- **Instagram**: professional (Business or Creator) accounts only. Every post needs a picture
  (JPG only) or a video (posted as a Reel). Instagram fetches the file from Flash: a public
  `/f/<id>` address made for that one post and removed right after. That needs `FLASH_APP_URL`.
- **Threads**: words (with a link), a picture or a video; replies to the latest posts in the Inbox.
- Instagram's and Threads' tokens last 60 days and are renewed in their last week.

Facebook asks for `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`,
`pages_read_user_content` and `pages_manage_engagement`. All five must be added to the Page use case
(Use cases → Manage everything on your Page → Customize), or Facebook stops with "Invalid Scopes".

Until Meta's **App Review** gives each permission Advanced access, only people with a role on the
app (App roles → Roles) can connect. Meta asks for a screen recording of Flash using each permission.
After review, switch the app to **Live**. Step-by-step for the owner:
/mnt/project-files/flash-ai/guides/meta-setup.md.

## Bluesky, Mastodon and Telegram

Nothing to set up. Each person brings their own:

- **Bluesky**: their handle and an app password (Bluesky → Settings → Privacy and security → App
  passwords).
- **Mastodon**: their server and an access token (their server → Preferences → Development → New
  application).
- **Telegram**: a bot from @BotFather, added to their channel or group as an administrator that can
  post.

## Open it to everyone

When you've tried it, add `FLASH_SOCIAL_OPEN` = `true` in Vercel and redeploy. Networks whose keys
aren't set stay hidden.
