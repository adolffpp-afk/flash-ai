# Setting up sign-in options

Flash AI offers these ways to sign in:

| Option | Needs setup? |
| --- | --- |
| Email and password | No |
| Email me a sign-in link | No (uses the Resend email you already set up) |
| Continue with Google | Yes, steps below |
| Continue with GitHub | Yes, steps below |
| Continue with Microsoft | Yes, steps below |

Each "Continue with …" button appears on its own as soon as its two Vercel variables are set and
the site is redeployed. You can set up one, two or all three.

People who use the same email on several options end up in the same Flash account. If Google,
GitHub or Microsoft hasn't confirmed someone's email, Flash won't attach it to an existing account.

Make sure `FLASH_APP_URL` is set in Vercel to `https://www.flash-app.dev`, because the addresses
below must match it exactly.

---

## Google

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and sign in.
2. At the top, pick a project or click **New project**, name it "Flash AI" and create it.
3. Open the menu ☰ → **APIs & Services** → **OAuth consent screen**.
   - Click **Get started** (or **Configure consent screen**).
   - App name: **Flash AI**. Support email: your email.
   - Audience: **External**.
   - Contact email: your email. Agree and click **Create**.
   - Under **Branding**, add the app home page `https://www.flash-app.dev`, privacy policy
     `https://www.flash-app.dev/privacy` and terms `https://www.flash-app.dev/terms`.
   - Under **Audience**, click **Publish app** so anyone can sign in (not just test users).
4. Go to **APIs & Services** → **Credentials** → **Create credentials** → **OAuth client ID**.
   - Application type: **Web application**. Name: "Flash AI".
   - Under **Authorized redirect URIs** click **Add URI** and paste:
     `https://www.flash-app.dev/api/auth/oauth/google/callback`
   - Click **Create**.
5. Copy the **Client ID** and **Client secret** shown.

Vercel variables: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.

## GitHub

1. On GitHub, click your picture (top right) → **Settings**.
2. At the bottom of the left menu: **Developer settings** → **OAuth Apps** → **New OAuth App**.
   - Application name: **Flash AI**
   - Homepage URL: `https://www.flash-app.dev`
   - Authorization callback URL: `https://www.flash-app.dev/api/auth/oauth/github/callback`
   - Click **Register application**.
3. Copy the **Client ID**.
4. Click **Generate a new client secret** and copy it right away (GitHub shows it only once).

Vercel variables: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`.

## Microsoft (personal and work accounts)

1. Go to the [Microsoft Entra admin center](https://entra.microsoft.com/) (or the Azure portal)
   and sign in. A free Microsoft account works.
2. Open **Identity** → **Applications** → **App registrations** → **New registration**.
   - Name: **Flash AI**
   - Supported account types: **Accounts in any organizational directory and personal
     Microsoft accounts**
   - Redirect URI: choose **Web** and paste
     `https://www.flash-app.dev/api/auth/oauth/microsoft/callback`
   - Click **Register**.
3. On the app's **Overview** page, copy the **Application (client) ID**.
4. Open **Certificates & secrets** → **Client secrets** → **New client secret**. Pick the longest
   expiry (24 months), click **Add**, and copy the **Value** (not the Secret ID) right away.
   Put a reminder in your calendar to make a new one before it expires.
5. Optional, for work and school accounts: open **Token configuration** → **Add optional claim**
   → **ID** → tick **xms_edov** → **Add**. This tells Flash when a company has confirmed the
   email, so those people can also use the Flash account they already made with their password.
   Without it, work accounts still work but only for new Flash accounts. Personal Microsoft
   accounts (Outlook, Hotmail, Live) work either way.

Vercel variables: `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`.

---

## Adding the variables in Vercel

1. Open your project on [vercel.com](https://vercel.com) → **Settings** → **Environment Variables**.
2. For each variable: type the name exactly as above, paste the value, tick **Production**
   (and **Preview** if you want it there too) and set the type to **Secret** (or tick
   **Sensitive**). Click **Save**.
3. Go to **Deployments**, open the latest one's **⋯** menu and click **Redeploy**, so the new
   variables take effect.
4. Open https://www.flash-app.dev, click **Sign in**, and try each button.

| Variable | Where it comes from |
| --- | --- |
| `GOOGLE_CLIENT_ID` | Google → Credentials → your OAuth client → Client ID |
| `GOOGLE_CLIENT_SECRET` | Google → Credentials → your OAuth client → Client secret |
| `GITHUB_CLIENT_ID` | GitHub → OAuth Apps → Flash AI → Client ID |
| `GITHUB_CLIENT_SECRET` | GitHub → OAuth Apps → Flash AI → Generate a new client secret |
| `MICROSOFT_CLIENT_ID` | Entra → App registrations → Flash AI → Application (client) ID |
| `MICROSOFT_CLIENT_SECRET` | Entra → Certificates & secrets → client secret Value |

The email sign-in link needs nothing new: it uses `RESEND_API_KEY` and `FLASH_APP_URL`, which are
already set.

## If something goes wrong

- **"redirect_uri_mismatch"** or similar: the redirect address in the provider's console must be
  exactly the one above, with `https://www.` and no slash at the end, and `FLASH_APP_URL` must be
  `https://www.flash-app.dev`.
- **A button doesn't show**: check both variables for that provider are set, then redeploy.
- **Sign-in fails**: Vercel → your project → **Logs**, search for "sign-in failed". The message
  says what went wrong (never the secret).

## Not included: Sign in with Apple

Apple sign-in needs a paid Apple Developer account ($99 a year), so it isn't included. It can be
added later the same way if you sign up for one.
