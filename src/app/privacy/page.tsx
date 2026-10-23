import type { Metadata } from "next";
import { COMPANY, CONTACT, LegalPage } from "@/components/LegalPage";
import { FRED_NOTICE } from "@/lib/research.ts";
import { PRODUCT_NAME } from "@/lib/product";

export const metadata: Metadata = { title: "Privacy Policy" };

export default function Privacy() {
  return (
    <LegalPage title="Privacy Policy" updated="October 20, 2026">
      <p>
        {PRODUCT_NAME} is operated by {COMPANY} (&quot;we&quot;), which is responsible for the personal information described
        here. This policy explains what we collect when you use {PRODUCT_NAME}, why, and the choices you have.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li><strong>Account details:</strong> your name, email address and a scrambled (hashed) version of your password.</li>
        <li><strong>Your content:</strong> the messages, files and memory notes you send, and what Flash makes for you, saved in your projects.</li>
        <li><strong>Approximate location:</strong> with each chat message, Flash reads the approximate city, country and coordinates of your internet connection, and your device&apos;s time zone, so answers can use your date, local time and weather. These aren&apos;t saved to your account.</li>
        <li><strong>Published apps:</strong> the apps you publish and the data their users save in them. If your app has sign-in, Flash keeps each member&apos;s email address, their name if they give one, a scrambled (hashed) version of their password and the data they save in your app. You can see your members, remove them, and download the list in My websites &amp; apps; unpublishing an app deletes them with it. Those accounts belong to your app alone: they are not Flash accounts, and they work on no other app. Each app&apos;s owner also gets one contact list of the people who sent its forms, signed up or paid: their name, email address and phone number if they gave them, where they came from, and the owner&apos;s own stages, tags and notes. When someone ticks a box to get an app&apos;s news, Flash keeps the wording they saw, the time, the form it was on and a scrambled (hashed) version of their internet address. The owner can download or delete each contact, unpublishing an app deletes its contacts, and anyone can stop an app&apos;s news with the unsubscribe link the owner puts in their emails. After that, for as long as they&apos;re on the app&apos;s contact list, a box ticked on a form doesn&apos;t sign them up again, not even with a +tag (or, for Gmail, dots) added to their address: only the owner can record that they asked for the news again, with a note saying how. If the owner deletes them, Flash keeps no record that they unsubscribed.</li>
        <li><strong>Visits to published apps:</strong> Flash counts visits to the apps people publish without cookies and without storing anything on the visitor&apos;s device. For each visit it keeps the day, the website the visitor came from (only its name, like google.com), the link tags in the address (utm_source, utm_medium, utm_campaign or ref, and whether it came from a Google or Microsoft ad; tags that look like an email address (also written in base64), a phone number, or a long code such as an ID are left out), and a code made from the visitor&apos;s internet address and browser with a key that changes every day. The code and its key are deleted after 2 days, so a person is counted once a day and can&apos;t be recognised on another day or in another app. While the code exists, Flash notes which steps that person took in the app: sending a form, signing up, starting a checkout, and steps the app itself reports. What the app&apos;s owner sees are daily totals: how many people came from where and took each step, and how much was paid per source. While a checkout is open (at most 14 days, as some payments go through days later), Flash keeps where its buyer came from with it; after that, only in the day&apos;s total. An order never keeps where its buyer came from, and nothing about it goes to Stripe. On a day or range with only one or a few forms, sign-ups or orders, though, a source&apos;s or campaign&apos;s numbers can show the owner which contact, member or order came from it. Robots, and the owner&apos;s own visits while signed in to Flash or in owner view, aren&apos;t counted. To stop one connection from filling an app&apos;s daily count, each Flash server also notes, in memory only and only for that day, how many new people came through one internet connection, under a code made with the day&apos;s key. On the free plan, how many of an app&apos;s own steps one connection reported to it in the last minute is also kept in the database, under a code made with that day&apos;s key for that app, until the next daily cleanup. None of this goes on an app&apos;s contact list, where &ldquo;where they came from&rdquo; means the form, sign-up or order.</li>
        <li><strong>Shared chats:</strong> when you share a chat, a copy of it (with its pictures, videos and audio) is visible to anyone with the link until you stop sharing it.</li>
        <li><strong>Connected apps:</strong> when you connect Flash to another app (like Claude or ChatGPT), that app sends Flash the requests it makes for you, and Flash keeps what it makes in your account. Each file gets a hard-to-guess link that the app, and anyone it is shared with, can open. The app can&apos;t see your chats or projects, and you can disconnect it at any time.</li>
        <li><strong>Your connected accounts (connectors):</strong> when you connect an account of yours (like GitHub, Notion, Linear or Airtable) or a server you add yourself in Settings &gt; Connectors, Flash keeps its address, the list of its tools and the key or token you give it. When you connect by signing in at the service, you type your password there, never in Flash, and Flash keeps the access the service gives it (its tokens, which it renews as they run out) instead of a key. For GitHub, Flash also keeps your GitHub login and account number, and the numbers of its GitHub App&apos;s installations your GitHub account can use (yours, or one an organization of yours made), which say which repositories it may use. Flash doesn&apos;t copy your repositories, but what a GitHub tool reads (a file, an issue or a pull request) is, like any tool&apos;s result, saved as described below. For Google Drive, see Google user data below. Keys and tokens are stored encrypted, are only ever sent to that service, and are never shown again, not even to you; for a key, Flash shows only its last 4 characters. Flash reads from or acts in that account only in a chat where you turned it on, and anything that sends or changes something runs only after you approve it. What a tool sent and returned is saved in the chat with the reply. An approval Flash waits on keeps what you approved and, once it ran, what the tool returned, so that Continue and Retry can use it; it is deleted 24 hours after it ends.</li>
        <li><strong>Voice conversations:</strong> when you talk with Flash, what you say is turned into text and saved in the chat like a typed message, and answers are read aloud by your device. In Chrome, Edge and Safari your browser turns speech into text (using its maker&apos;s speech service); in other browsers Flash sends each recorded turn to its transcription provider and keeps only the text. If you turn on &ldquo;Hey Flash&rdquo;, your browser listens while Flash is open, and Flash only gets what you say after &ldquo;Hey Flash&rdquo;.</li>
        <li><strong>Alerts:</strong> if you turn on alerts when Flash is closed (Settings &gt; General &gt; Notifications), Flash keeps the address your browser&apos;s push service gave that browser, and the keys that encrypt each alert so only that browser can read it. Your browser maker&apos;s push service carries the alerts (Google for Chrome and Android, Mozilla for Firefox, Apple for Safari, Microsoft for Edge on Windows). Logging out of Flash in that browser, or out of all devices, deletes them.</li>
        <li><strong>Usage and billing:</strong> which tools you use, credits spent, and purchases. When paid plans are available, card payments are handled by Stripe; we never see your full card number.</li>
        <li><strong>Technical data:</strong> sign-in cookies that keep you logged in to each account you add on a device, and standard server logs.</li>
        <li><strong>Reports:</strong> when you report a page or an app, we keep its address, the reason, any details and email address you give, and a scrambled (hashed) version of your internet address, so our team can review the report (new reports are emailed to them through Resend), reply if you asked, and stop repeated or abusive reports; none of it is shown to the person who made the page.</li>
      </ul>

      <h2>How we use it</h2>
      <ul>
        <li>to run Flash: answer requests, save your projects, publish your apps and manage credits;</li>
        <li>to keep the Service secure and prevent abuse;</li>
        <li>to understand overall usage and costs so we can price and improve Flash; and</li>
        <li>to contact you about your account or important changes.</li>
      </ul>
      <p>We do not sell your personal data, and we do not use your content to train AI models.</p>

      <h2>Who we share it with</h2>
      <p>To answer a request, Flash sends it (including any attached file) to the AI provider that handles it:</p>
      <ul>
        <li>Anthropic (writing, research, code, apps, slides, translation)</li>
        <li>
          Groq, Google (Gemini), OpenRouter, Cloudflare and Mistral (free models, used when you are out of credits, but
          never for a chat that used your connected accounts: see below). Google may
          use messages its free Gemini models answer to improve its products, and its human reviewers may read them, so
          don&apos;t share personal or sensitive information in chats on free models. Free Gemini models never answer
          people in the European Economic Area, the UK or Switzerland. Flash&apos;s Mistral account is set so Mistral
          doesn&apos;t use these messages to train its models.
        </li>
        <li>
          OpenAI (ChatGPT models, for writing, code, translation and documents when you pick one in the Intelligence
          menu, or on Auto when a ChatGPT model answers for far fewer credits or Claude is busy, and images when that
          feature is available)
        </li>
        <li>ElevenLabs (voice, music and transcription, when those features are available)</li>
        <li>fal.ai and the model makers it serves (image, video, music, voice and transcription models, when those features are available)</li>
      </ul>
      <p>
        With each chat request, Flash also tells the AI provider answering it (Anthropic, OpenAI or a free-model
        provider) your approximate city, country and time zone, taken from your internet connection and device, so the
        answer fits your date, time and place. Your coordinates aren&apos;t sent to them.
      </p>
      <p>
        For a ChatGPT answer, Flash turns off OpenAI&apos;s storage of the answer, and sends OpenAI a scrambled number for
        your account instead of your name or email, so OpenAI can spot misuse without knowing who you are. On Auto, a
        ChatGPT model answers only two kinds of request: a quick question in a very long chat, which it reads for far
        fewer credits, and a request Claude can&apos;t take because it is busy or down. The reply&apos;s header
        names the model that answered. To keep every answer on Claude, pick a Flash level in the Intelligence menu.
      </p>
      <p>
        When a chat has your connected accounts turned on, Flash sends Claude&apos;s requests (what it searches for, or
        what it creates or changes) to those services with your key, and sends what they return to Anthropic to write
        the answer. Nothing goes to an account you haven&apos;t turned on in that chat, and Anthropic doesn&apos;t use it
        to train its models. What they return, and the answers Claude writes with it, go to no other AI provider: a chat
        with a reply that used your connected accounts is never answered by the free models or by ChatGPT, even after you
        turn the accounts off (start a new chat for those), and Flash&apos;s companion (Ask Flash) isn&apos;t shown that
        chat&apos;s messages. You can turn an account off in any chat, or remove it in Settings &gt; Connectors, which
        deletes the key and its tools from Flash. Removing it doesn&apos;t cancel a key at the service itself: do that
        in your account there if you no longer want it to work. For an account you connected by signing in, Flash also
        asks the service to cancel the access you gave it, where the service offers a way to; where it doesn&apos;t,
        Settings says so, and you cancel it in your account there. You can always check or cancel it there too.
      </p>
      <p>
        For weather questions, Flash&apos;s server asks MET Norway (the Norwegian Meteorological Institute, api.met.no) for
        the forecast. It sends only the place&apos;s coordinates, rounded to about 1 km: no account, name, IP address or
        other personal data. Flash keeps each forecast for up to 2 days, stored by place and not by person, and anyone
        asking about the same place gets the same copy.
      </p>
      <p>
        Some answers look things up in public sources, from Flash&apos;s server and without your account, name, email or
        IP address. For questions about current events, Flash searches the web through its own search server (SearXNG),
        which passes the search on to public search engines: it sends the search words written for your question,
        which can include words from your message, and your language. For a listed company&apos;s filings or reported
        figures, Flash asks the U.S. Securities and Exchange Commission&apos;s SEC EDGAR (sec.gov), sending only the
        company&apos;s ticker, name or SEC number. For economic data, Flash asks FRED&reg; (the Federal Reserve Bank of
        St. Louis&apos;s economic data, api.stlouisfed.org), sending only the series or the words searched for. Flash
        keeps what they return for a short time (web results for 10 minutes, company and economic data for up to a
        day), stored by request and not by person, and anyone asking the same thing gets the same copy. To apply the
        daily limit on free web searches, Flash counts how many each account makes in a day, but not what they were.{" "}
        {FRED_NOTICE}
      </p>
      <p>
        We also use Stripe for payments (when paid plans are available), Resend to send account emails (email confirmation and password reset), and a database and hosting provider to store your data. Each provider processes
        data under its own terms and privacy policy. Some are based in the United States, so your data may be processed
        outside your country.
      </p>

      <h2 id="google">Google user data</h2>
      <p>
        When you connect Google Drive in Settings &gt; Connectors, you sign in at Google, never in Flash, and Google asks
        whether Flash may see your email address and use the Google Drive files you pick with Flash (Google calls this
        the drive.file permission). Here is exactly what Flash does with it:
      </p>
      <ul>
        <li>
          <strong>Only the files you pick.</strong> Flash can open only the files you choose with Google&apos;s own file
          picker (&ldquo;Add from Drive&rdquo;), and the Docs, Sheets and Slides it creates for you. It can&apos;t see,
          list or search anything else in your Drive. Settings &gt; Connectors lists every file it can open.
        </li>
        <li>
          <strong>Only when you ask.</strong> Flash reads one of these files only to answer you in a chat where you
          turned Google Drive on. It creates a Doc, Sheet or Slides deck, adds rows to a Sheet or adds text to a Doc,
          only after you approve a card that shows exactly what will be written.
        </li>
        <li>
          <strong>Sent only to write your answer.</strong> The text of a file Flash reads is sent to Anthropic only so
          Claude can write the answer to your request. Anthropic doesn&apos;t use it to train its models. The answers
          Claude writes with it go to no other AI provider either: a chat that used Google Drive is never answered by
          Flash&apos;s free models, even after you turn Google Drive off, and Flash&apos;s companion isn&apos;t shown
          it. Flash gives it to nobody else, and nobody else sees it unless you share that chat yourself.
        </li>
        <li>
          <strong>Never for training or ads.</strong> Flash doesn&apos;t use your Google data to develop, improve or
          train AI or machine-learning models, its own or anyone else&apos;s. It doesn&apos;t sell it, use it for
          advertising, or give it to data brokers. No person at Flash reads it, unless you ask us to look at a specific
          file, it&apos;s needed for security (such as investigating abuse), or the law requires it.
        </li>
        <li>
          <strong>No copy of your Drive.</strong> Flash doesn&apos;t copy your files: it reads a file from Google each
          time it uses it. What it read from a file to answer you is, like any tool&apos;s result, saved in that chat
          with the reply, and with an approval as described under &ldquo;Your connected accounts&rdquo; above. Flash
          also keeps your Google account&apos;s email address (to show which account is connected), the name, type and
          ID of each file you picked or it created for you, and the access Google gave it (its tokens, stored encrypted).
        </li>
        <li>
          <strong>Removing access.</strong> Forget a file in Settings &gt; Connectors and Flash can&apos;t open it in
          chat any more. Remove Google Drive there and Flash asks Google to cancel all the access you gave it, and
          deletes its tokens and your list of files. You can also remove Flash AI at any time from your Google
          Account, under{" "}
          <a href="https://myaccount.google.com/connections" target="_blank" rel="noreferrer">
            Third-party apps &amp; services
          </a>
          .
        </li>
      </ul>
      <p>
        Flash AI&apos;s use and transfer to any other app of information received from Google APIs will adhere to the{" "}
        <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noreferrer">
          Google API Services User Data Policy
        </a>
        , including the Limited Use requirements, and to the{" "}
        <a href="https://developers.google.com/workspace/workspace-api-user-data-developer-policy" target="_blank" rel="noreferrer">
          Google Workspace user data and developer policy
        </a>
        .
      </p>

      <h2 id="figma-canva">Figma and Canva</h2>
      <p>
        When you connect Figma or Canva in Settings &gt; Connectors, you sign in there, never in Flash. Flash keeps
        the access they give it (stored encrypted) and the account&apos;s email or name, to show which account is
        connected. In Figma, Flash only reads the files and frames you link to in a chat where Figma is on, and
        can&apos;t change anything. In Canva, Flash finds, reads and exports your designs when you ask in a chat where
        Canva is on, and adds a picture to your Canva uploads and starts a design with it only when you press Open in
        Canva. What Flash reads is sent to Anthropic only so Claude can write your answer, is never used to train AI
        models, and is given to nobody else. Remove Figma or Canva in Settings &gt; Connectors to delete Flash&apos;s
        access (Flash also asks Canva to cancel it; in Figma, remove Flash AI from your connected apps too).
      </p>

      <h2>How long we keep it</h2>
      <p>
        We keep your account and projects until you delete them or ask us to delete your account. Billing records are
        kept as long as tax law requires. Weather forecasts are kept for up to 2 days, web search results for 10 minutes,
        and company and economic data for up to a day.
        Visit codes, and the keys that make them, are deleted after 2 days. Daily totals of visits, steps and sales by
        source are kept for 100 days.
      </p>

      <h2>Your choices and rights</h2>
      <p>
        You can edit or delete projects and your memory note in the app. Depending on where you live, you may have the
        right to access, correct, export or delete your personal data, or to object to how we use it. Email{" "}
        <a href={`mailto:${CONTACT}`}>{CONTACT}</a> and we&apos;ll respond within 30 days.
      </p>

      <h2>Cookies</h2>
      <p>
        Flash uses essential cookies to keep you signed in to your accounts. We don&apos;t use advertising or tracking cookies.
        Counting visits to published apps uses no cookies.
      </p>

      <h2>Children</h2>
      <p>Flash is only for people aged 18 and over, and we don&apos;t knowingly collect data from anyone younger.</p>

      <h2>Changes</h2>
      <p>We&apos;ll post updates here and tell you about important changes by email or in the app.</p>

      <h2>Contact</h2>
      <p>
        Privacy questions: <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
      </p>
    </LegalPage>
  );
}
