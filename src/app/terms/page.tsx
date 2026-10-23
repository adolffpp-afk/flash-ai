import type { Metadata } from "next";
import { COMPANY, CONTACT, LegalPage } from "@/components/LegalPage";
import { FRED_NOTICE, FRED_TERMS_URL } from "@/lib/research.ts";
import { PRODUCT_NAME } from "@/lib/product";

export const metadata: Metadata = { title: "Terms of Service" };

export default function Terms() {
  return (
    <LegalPage title="Terms of Service" updated="October 23, 2026">
      <p>
        These terms are an agreement between you and {COMPANY} (&quot;Flash&quot;, &quot;we&quot;), which operates the{" "}
        {PRODUCT_NAME} website and app (the &quot;Service&quot;), for your use of the Service. By creating an account or using
        the Service you accept them.
      </p>

      <h2>1. Your account</h2>
      <p>
        You must be at least 18 years old to use Flash. Give accurate
        details, keep your password private, and tell us at <a href={`mailto:${CONTACT}`}>{CONTACT}</a> if you think
        someone else has used your account. You are responsible for what happens under your account.
      </p>

      <h2>2. What Flash does</h2>
      <p>
        Flash sends your requests to third-party AI providers (such as Anthropic, and Groq, Google, OpenRouter,
        Cloudflare and Mistral for free models) and returns their results. Features, models and providers may change over time.
      </p>
      <p>
        Some answers use public data, listed under the answer with a link to where it came from: web search results
        (through Flash&apos;s own SearXNG search server), company filings and reported figures from the U.S. Securities
        and Exchange Commission&apos;s SEC EDGAR, and economic data from FRED&reg;, Federal Reserve Bank of St. Louis.
        That data can be late, incomplete or wrong, and Flash doesn&apos;t check it: check it at the source before you
        rely on it.
      </p>
      <p>
        By using FRED&reg; data through Flash, you also agree to the{" "}
        <a href={FRED_TERMS_URL} target="_blank" rel="noopener noreferrer">
          FRED&reg; API Terms of Use
        </a>
        , and you may use that data only as they allow. {FRED_NOTICE}
      </p>

      <h2>3. Credits and payments</h2>
      <ul>
        <li>Requests use credits. The cost of a request is shown in the app and may change as provider prices change.</li>
        <li>Domain names are paid separately, not with credits; see section 6a.</li>
        <li>Free credits are added each month and do not carry over beyond the monthly allowance.</li>
        <li>
          Credits from top-ups do not expire while your account is open. Credits have no cash value and cannot be
          transferred.
        </li>
        <li>
          Plans are subscriptions that renew automatically each month or year at the price shown when you subscribe,
          until you cancel. Each plan adds its credits once a month, including yearly plans. Unused plan credits carry
          over, up to two months&apos; worth: when a month&apos;s credits are added, plan credits left from earlier months
          above that are removed. Plans started before October 17, 2026 keep all their unused plan credits.
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

      <h2 id="domains">6a. Domain names</h2>
      <p>
        <strong>Who owns it.</strong> When you buy a domain in Flash, it is registered in your name, with the contact
        details you give at checkout. You are the registrant and the domain is yours, not Flash&apos;s. Flash buys it for
        you through our registrar partner, Name.com, Inc., an ICANN-accredited registrar.
      </p>
      <p>
        <strong>The registrar&apos;s rules.</strong> By buying a domain you also accept Name.com&apos;s{" "}
        <a href="https://www.name.com/policies/legal">Domain Name Registration Agreement</a> and the rules of the registry
        for that ending (for example .com or .app). Your rights and duties as a registrant are explained in ICANN&apos;s{" "}
        <a href="https://www.icann.org/resources/pages/benefits-2013-09-16-en">Registrants&apos; Benefits and Responsibilities</a>.
        Your contact details must be true and kept up to date.
      </p>
      <p>
        <strong>Confirming your details.</strong> After a purchase, Name.com emails the registrant and asks them to
        confirm their details. If they are not confirmed within 15 days, the registry may pause the domain until they
        are. Flash reminds you, and lets you send that email again.
      </p>
      <p>
        <strong>Price and payment.</strong> The price shown before you pay is the full price for one year, in US
        dollars. Your card is held first and charged only once the domain is registered. If the registration does not
        go through, the hold is released and you pay nothing.
      </p>
      <p>
        <strong>Refunds.</strong> A registered domain cannot be undone, so domain purchases and renewals are not
        refundable once the domain is registered or renewed. If you were charged and the domain was not registered or
        renewed, we refund you in full.
      </p>
      <p>
        <strong>Renewals.</strong> Domains are not renewed automatically. We email you 60, 30, 14 and 7 days before
        your domain ends. You renew in Flash with Renew now, at the price shown then, which can change if the
        registry&apos;s price changes. A domain that is not renewed ends on its end date and may then be lost, and
        later taken by someone else.
      </p>
      <p>
        <strong>Moving your domain.</strong> You can move your domain to another registrar. Registry rules do not allow
        a move during the first 60 days after a purchase or a change of registrant. Ask us at <a href={`mailto:${CONTACT}`}>{CONTACT}</a> and we will send
        you the transfer code.
      </p>
      <p>
        <strong>What you may not do.</strong> You may not use a domain bought in Flash for anything that breaks section
        4 (Acceptable use), or to infringe someone else&apos;s name or trademark. Disputes over a domain name follow
        ICANN&apos;s{" "}
        <a href="https://www.icann.org/resources/pages/help/dndr/udrp-en">Uniform Domain-Name Dispute-Resolution Policy</a>{" "}
        (UDRP). We may suspend or cancel a domain when the law, the registry, the registrar or a valid UDRP decision
        requires it, or after fraud or a chargeback on its payment.
      </p>
      <p>
        <strong>Where we can&apos;t sell.</strong> We do not sell domains to people in countries under sanctions, and
        each account has a limit on the number of domains it can buy.
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
