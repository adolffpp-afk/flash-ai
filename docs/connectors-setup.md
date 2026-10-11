# Setting up connectors

Connectors let people use their own accounts (Linear, Airtable, Firecrawl, Perplexity, Resend,
Brevo, or any MCP server they add themselves) in a chat. Flash stores each person's API key or token
encrypted with one key of your own, `CONNECTOR_KEYS`. Until it is set, nobody sees connectors, and
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

Keep the value somewhere safe (a password manager). If it is lost, every connected account stops
working, and people have to remove and add their accounts again.

## Change the key (rotation)

Every stored key or token says which version sealed it, so old ones keep working while new ones use
the newest version.

1. On /admin → **By provider** → **Connectors**, click **Make a new key version** and copy it.
2. In Vercel, edit `CONNECTOR_KEYS` and add the new key beside the old one with the next number:
   `{"v1":"<old>","v2":"<new key>"}`. Redeploy.
3. Only drop `v1` once nothing uses it. In the database:
   `SELECT COUNT(*) FROM connections WHERE key_version = 'v1';` must be 0. An account sealed with a
   dropped version stops working until its owner removes it and adds it again.

## Try it without real accounts

1. In one terminal: `node --experimental-strip-types scripts/mock-connectors.ts`
   (it prints its pid; stop it with `kill <pid>`).
2. In another: set a test `CONNECTOR_KEYS` in `.env.local`, then
   `FLASH_CONNECT_MOCK=http://127.0.0.1:7788 npm run dev`. Every preset now talks to the mock, and
   you can add `http://127.0.0.1:7788/mcp` as your own connector. The flag is ignored on Vercel.
3. Connect a preset with any key, turn it on in a chat with the plug button, and ask Flash to "echo
   hello" (a read: it runs by itself) or "send a note to Sam" (a write: a card waits for Approve).
   The mock's terminal prints every call it gets.

## Deleting someone's account by hand

Their connector rows go with them when foreign keys are on. To be sure, delete them yourself first:

```sql
DELETE FROM pending_actions WHERE user_id = '<user id>';
DELETE FROM connection_tools WHERE connection_id IN (SELECT id FROM connections WHERE user_id = '<user id>');
DELETE FROM connections WHERE user_id = '<user id>';
```

This removes the keys from Flash only. It doesn't cancel them at Linear, Airtable and the rest;
the person does that in their account there.
