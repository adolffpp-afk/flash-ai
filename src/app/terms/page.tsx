import type { Metadata } from "next";
import { COMPANY, CONTACT, LegalPage } from "@/components/LegalPage";

export const metadata: Metadata = { title: "Terms of Service" };

export default function Terms() {
  return (
    <LegalPage title="Terms of Service" updated="October 9, 2026">
      <p>
        These terms are an agreement between you and {COMPANY} (&quot;Flash&quot;, &quot;we&quot;) for your use of the
        Flash AI website and app (the &quot;Service&quot;). By creating an account or using the Service you accept them.
      </p>

      <h2>1. Your account</h2>
      <p>
        You must be at least 18 years old to use Flash. Give accurate
        details, keep your password private, and tell us at <a href={`mailto:${CONTACT}`}>{CONTACT}</a> if you think
        someone else has used your account. You are responsible for what happens under your account.
      </p>

      <h2>2. What Flash does</h2>
      <p>
        Flash sends your requests to third-party AI providers (such as Anthropic, and Groq, Google, OpenRouter and
        Cloudflare for free models) and returns their results. Features, models and providers may change over time.
      </p>

      <h2>3. Credits and payments</h2>
      <ul>
        <li>Requests use credits. The cost of a request is shown in the app and may change as provider prices change.</li>
        <li>Free credits are added each month and do not carry over beyond the monthly allowance.</li>
        <li>
          Purchased credits, including plan credits, do not expire while your account is open. They have no cash value
          and cannot be transferred.
        </li>
        <li>
          Plans are subscriptions that renew automatically each month or year at the price shown when you subscribe,
          until you cancel. Each plan adds its credits once a month, including yearly plans. Unused plan credits carry
          over.
        </li>
        <li>
          You can cancel at any time from the credits panel. Your plan keeps running, and keeps adding its monthly
          credits, until the end of the period you paid for. We do not give partial refunds for the rest of a period.
        </li>
        <li>
          Switching to a different plan starts a new billing period on the day you switch, at the new price. Your
          previous plan ends that day without a partial refund, and you keep all credits already added.
        </li>
        <li>
          If we change a plan&apos;s price, we will tell you before your next renewal, and the new price applies from
          that renewal.
        </li>
        <li>
          A long reply stops when it reaches what your credits cover. You can buy more credits and ask Flash to
          continue.
        </li>
        <li>
          Credits used by a request that fails are returned automatically. Other purchases are non-refundable, except
          where the law requires otherwise. Contact us if you were charged in error.
        </li>
        <li>When paid plans are available, payments are processed by Stripe. We do not store your card details.</li>
      </ul>

      <h2>4. Acceptable use</h2>
      <p>You agree not to use Flash to:</p>
      <ul>
        <li>break the law, or infringe anyone&apos;s copyright, trademark, privacy or other rights;</li>
        <li>create content that sexualises minors, harasses or threatens people, or promotes violence or hatred;</li>
        <li>impersonate real people or organisations, or create deceptive deepfakes, scams, phishing pages or malware;</li>
        <li>publish apps that collect passwords, payment details or sensitive personal data;</li>
        <li>attack, overload or try to get around the limits or security of the Service; or</li>
        <li>break the usage policies of the AI providers Flash relies on.</li>
      </ul>
      <p>We may remove content, unpublish apps, or suspend accounts that break these rules.</p>

      <h2>5. Your content</h2>
      <p>
        You keep ownership of what you put into Flash and, as far as the law and our providers allow, of what Flash makes
        for you. You give us permission to store and process your content only to run the Service. You are responsible
        for checking that you have the rights to use what you upload and publish.
      </p>

      <h2>6. Published apps</h2>
      <p>
        Apps you publish are public to anyone with the link, and data saved in them is visible to their users. You are
        responsible for your published apps, including any data they collect. Don&apos;t store private or sensitive
        information in them.
      </p>

      <h2>7. AI output</h2>
      <p>
        AI can be wrong, incomplete or out of date. Check important results yourself, and don&apos;t rely on Flash for
        medical, legal, financial or safety decisions.
      </p>

      <h2>8. Availability and changes</h2>
      <p>
        We work to keep Flash running but can&apos;t promise it will always be available or error-free. We may change or
        stop features, and we&apos;ll give notice of important changes to these terms by email or in the app.
      </p>

      <h2>9. Liability</h2>
      <p>
        The Service is provided &quot;as is&quot;. To the extent the law allows, we are not liable for indirect or
        consequential losses, and our total liability to you is limited to the amount you paid us in the 12 months
        before the claim.
      </p>

      <h2>10. Ending your account</h2>
      <p>
        You can stop using Flash at any time and ask us to delete your account. We may close accounts that break these
        terms.
      </p>

      <h2>11. Contact</h2>
      <p>
        Questions about these terms: <a href={`mailto:${CONTACT}`}>{CONTACT}</a>.
      </p>
    </LegalPage>
  );
}
