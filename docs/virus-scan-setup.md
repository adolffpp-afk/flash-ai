# Virus scanning setup

Flash checks every file people upload (chat files, files sent to published apps, brand logos and
photos sent through the Flash connector) with its own ClamAV scanner before it uses or stores them.
An infected file is refused with a clear message. The scanner is the `scanner/` folder of this
repository, run as a small service on Railway.

Until both Vercel variables below are set, Flash works as before and files aren't scanned. If the
scanner is set but can't be reached, files go through unscanned (and Vercel's logs say so), so a
scanner problem never stops people working.

## 1. Railway: run the scanner

1. In Railway, open the project with SearXNG (or a new one) and click **Create** > **GitHub Repo** >
   `adolffpp-afk/flash-ai`.
2. Open the new service's **Settings**:
   - **Source** > **Root Directory**: `scanner`
   - **Source** > **Watch Paths**: `/scanner/**` (so changes to the rest of Flash don't restart it)
3. Open **Variables** and add `SCANNER_KEY`: a long random password of at least 24 characters (make
   one in your password manager). Keep a copy for step 2.
4. Back in **Settings** > **Networking**, click **Generate Domain**. Use port `8080` if it asks.
5. Deploy. The first start downloads the virus definitions and takes a few minutes. It's ready when
   `https://<your scanner domain>/health` shows `{"ready":true}`.

The scanner keeps ClamAV's virus definitions in memory (about 1 to 1.5 GB), which is most of its
Railway cost. It updates the definitions itself every few hours.

## 2. Vercel: tell Flash where it is

In the Vercel project `flash-ai` > **Settings** > **Environment Variables** (Production), add:

| Name | Value |
| --- | --- |
| `VIRUS_SCAN_URL` | `https://<your scanner domain>` |
| `VIRUS_SCAN_KEY` | the same password as `SCANNER_KEY` |

Then redeploy. In Flash's owner dashboard, **/admin** > **By provider** > **Virus scanning** should say
"On. The scanner is answering."

## Checking it

Download the harmless EICAR test file from https://www.eicar.org (made for testing antivirus
software) and attach it in a chat. Flash should say it found a virus and refuse it.
