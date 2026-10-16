import type { Metadata } from "next";
import { COMPANY, CONTACT, LegalPage } from "@/components/LegalPage";
import { PRODUCT_NAME } from "@/lib/product";

export const metadata: Metadata = { title: "Delete your account" };

// The public page app stores ask for: how to have a Flash account and its data deleted, without
// signing in or opening the app. Settings > Delete account gives the same steps.
export default function DeleteAccount() {
  const subject = encodeURIComponent(`Delete my ${PRODUCT_NAME} account`);
  return (
    <LegalPage title="Delete your account" updated="October 15, 2026">
      <p>
        You can ask {COMPANY} to delete your {PRODUCT_NAME} account and its data at any time, from the website or the
        Android app. You don&apos;t need to sign in or have the app installed.
      </p>

      <h2>How to ask</h2>
      <ol>
        <li>
          Email{" "}
          <a href={`mailto:${CONTACT}?subject=${subject}`}>{CONTACT}</a> from the email address of your {PRODUCT_NAME}{" "}
          account, with the subject &quot;Delete my {PRODUCT_NAME} account&quot;.
        </li>
        <li>We reply by email to confirm it&apos;s you before anything is deleted.</li>
        <li>Once you confirm, we delete your account within 30 days and email you when it&apos;s done.</li>
      </ol>
      <p>
        Signed in? <strong>Settings → Account → Delete account</strong> shows the same steps.
      </p>

      <h2>What we delete</h2>
      <ul>
        <li>Your account: email address, name, password, sign-in methods and settings.</li>
        <li>Your chats, files, pictures, recordings, projects and memory note.</li>
        <li>Websites and apps you published, and the data their visitors and members saved in them.</li>
        <li>Connected accounts (connectors) and their keys or tokens.</li>
        <li>Your unused credits, which can&apos;t be refunded once the account is deleted.</li>
      </ul>

      <h2>What we keep</h2>
      <ul>
        <li>
          Billing records (what was bought, when and for how much) for as long as tax law requires. Card details are
          held by Stripe, never by us.
        </li>
        <li>Copies in our database backups, until those backups expire on their normal schedule.</li>
      </ul>

      <p>
        To delete only some data, such as a chat or a project, you can do it yourself in the app at any time. See the{" "}
        <a href="/privacy">Privacy Policy</a> for more.
      </p>
    </LegalPage>
  );
}
