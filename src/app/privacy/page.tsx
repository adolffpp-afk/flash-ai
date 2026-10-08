import type { Metadata } from "next";
import { COMPANY, CONTACT, LegalPage } from "@/components/LegalPage";

export const metadata: Metadata = { title: "Privacy Policy" };

export default function Privacy() {
  return (
    <LegalPage title="Privacy Policy" updated="October 6, 2026">
      <p>
        This policy explains what {COMPANY} collects when you use Flash AI, why, and the choices you have.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li><strong>Account details:</strong> your name, email address and a scrambled (hashed) version of your password.</li>
        <li><strong>Your content:</strong> the messages, files and memory notes you send, and what Flash makes for you, saved in your projects.</li>
        <li><strong>Published apps:</strong> the apps you publish and the data their users save in them.</li>
        <li><strong>Shared chats:</strong> when you share a chat, a copy of it (with its pictures, videos and audio) is visible to anyone with the link until you stop sharing it.</li>
        <li><strong>Connected apps:</strong> when you connect Flash to another app (like Claude or ChatGPT), that app sends Flash the requests it makes for you, and Flash keeps what it makes in your account. Each file gets a hard-to-guess link that the app, and anyone it is shared with, can open. The app can&apos;t see your chats or projects, and you can disconnect it at any time.</li>
        <li><strong>Voice conversations:</strong> when you talk with Flash, what you say is turned into text and saved in the chat like a typed message, and answers are read aloud by your device. In Chrome, Edge and Safari your browser turns speech into text (using its maker&apos;s speech service); in other browsers Flash sends each recorded turn to its transcription provider and keeps only the text. If you turn on &ldquo;Hey Flash&rdquo;, your browser listens while Flash is open, and Flash only gets what you say after &ldquo;Hey Flash&rdquo;.</li>
        <li><strong>Usage and billing:</strong> which tools you use, credits spent, and purchases. When paid plans are available, card payments are handled by Stripe; we never see your full card number.</li>
        <li><strong>Technical data:</strong> a sign-in cookie that keeps you logged in, and standard server logs.</li>
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
        <li>Groq, OpenRouter and Cloudflare (free open-source models, used when you are out of credits)</li>
        <li>OpenAI (images and video, when those features are available)</li>
        <li>ElevenLabs (voice, music and transcription, when those features are available)</li>
        <li>fal.ai and the model makers it serves (image, video, music, voice and transcription models, when those features are available)</li>
      </ul>
      <p>
        We also use Stripe for payments (when paid plans are available), Resend to send account emails (email confirmation and password reset), and a database and hosting provider to store your data. Each provider processes
        data under its own terms and privacy policy. Some are based in the United States, so your data may be processed
        outside your country.
      </p>

      <h2>How long we keep it</h2>
      <p>
        We keep your account and projects until you delete them or ask us to delete your account. Billing records are
        kept as long as tax law requires.
      </p>

      <h2>Your choices and rights</h2>
      <p>
        You can edit or delete projects and your memory note in the app. Depending on where you live, you may have the
        right to access, correct, export or delete your personal data, or to object to how we use it. Email{" "}
        <a href={`mailto:${CONTACT}`}>{CONTACT}</a> and we&apos;ll respond within 30 days.
      </p>

      <h2>Cookies</h2>
      <p>
        Flash uses one essential cookie to keep you signed in. We don&apos;t use advertising or tracking cookies.
      </p>

      <h2>Children</h2>
      <p>Flash is not meant for children under 16, and we don&apos;t knowingly collect their data.</p>

      <h2>Changes</h2>
      <p>We&apos;ll post updates here and tell you about important changes by email or in the app.</p>

      <h2>Contact</h2>
      <p>
        Privacy questions: <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
      </p>
    </LegalPage>
  );
}
