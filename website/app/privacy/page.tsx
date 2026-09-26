import type { Metadata } from 'next';
import { SiteFooter, SiteHeader } from '../site-chrome';

export const metadata: Metadata = {
  title: 'Privacy policy',
  description:
    'How the SecondHand website, desktop app, and Chrome extension handle your information: stored encrypted on your computer, with no accounts, analytics, or ads.',
  alternates: { canonical: '/privacy' },
};

export default function PrivacyPolicy() {
  return (
    <>
      <SiteHeader />
      <main id="main" className="wrap doc-page">
        <h1>Privacy policy</h1>
        <p className="doc-date">Last updated September 26, 2026</p>
        <p className="doc-lead">
          SecondHand helps you prepare an Iowa SNAP application on your own
          computer. We do not collect your benefits information. There are no
          SecondHand accounts, analytics, or ads.
        </p>

        <h2>This website</h2>
        <p>
          This website offers the SecondHand installers and setup instructions.
          It has no forms or accounts, and its code does not set cookies or run
          analytics, advertising, or tracking scripts.
        </p>
        <p>
          Like any website, the hosting provider processes basic connection
          information, such as your IP address, browser type, the page or file
          requested, and the time. This is used to deliver pages and downloads
          and to keep the service running. SecondHand does not use it to
          identify you.
        </p>

        <h2>The desktop app</h2>
        <p>
          Your profile and application records are saved in an encrypted file on
          your computer. They are not sent to SecondHand, and the app has no
          cloud sync, analytics, telemetry, or AI service.
        </p>
        <ul>
          <li>
            Your password and recovery key are never stored by SecondHand.
            Anyone with your recovery key and your SecondHand files can open
            your information, so keep the key somewhere safe.
          </li>
          <li>
            If you turn on “Let this computer reset my password,” a reset secret
            is protected by your computer’s own secure storage (the macOS
            Keychain or Windows data protection). Anyone who can sign in to the
            same computer account could use it. You can turn it off in Privacy
            &amp; backups.
          </li>
          <li>
            Encrypted backups are saved only where you choose. A folder synced
            by other software may upload them.
          </li>
        </ul>

        <h2>The Chrome extension</h2>
        <p>
          The extension works only on Iowa’s Self-Service Portal. It asks the
          desktop app for saved details through a connection on your computer,
          and only after you approve the request in the desktop app. It does not
          keep your information in Chrome’s storage or Chrome Sync.
        </p>

        <h2>Information you share with Iowa</h2>
        <p>
          When you approve a fill, the details are entered into Iowa’s website.
          Iowa’s website can save them as they are entered, even before you
          submit. Information you give Iowa is handled under Iowa HHS’s own
          privacy practices, not this policy.
        </p>

        <h2>What we never do</h2>
        <ul>
          <li>Sell or rent your information.</li>
          <li>Share your information with advertisers or data brokers.</li>
          <li>
            Decide whether you are eligible for benefits. Only Iowa HHS does
            that.
          </li>
        </ul>

        <h2>Removing your information</h2>
        <p>
          To delete what the desktop app saved, uninstall SecondHand and delete
          its data folder: <code>%LOCALAPPDATA%\SecondHand</code> on Windows or{' '}
          <code>~/Library/Application Support/SecondHand</code> on a Mac. Delete
          any encrypted backups you exported as well.
        </p>

        <h2>Changes to this policy</h2>
        <p>
          If this policy changes, the new version will be posted on this page
          with a new date.
        </p>
      </main>
      <SiteFooter />
    </>
  );
}
