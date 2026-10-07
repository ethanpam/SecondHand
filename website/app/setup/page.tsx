import type { Metadata } from 'next';
import Link from 'next/link';
import { ExternalIcon } from '../_components/icons';
import { SiteFooter, SiteHeader } from '../_components/site-chrome';

export const metadata: Metadata = {
  title: 'Setup guide',
  description:
    'Install SecondHand, create your password, and connect the included Chrome extension. Includes security warning notes and instructions for updates.',
  alternates: { canonical: '/setup' },
};

export default function SetupGuide() {
  return (
    <>
      <SiteHeader />
      <main id="main" className="wrap setup-page">
        <p className="setup-download-note">
          Need the app first?{' '}
          <a href="/downloads">Download SecondHand for Windows or Mac</a>.
        </p>
        <section id="setup" className="setup-section">
          <div className="section-heading">
            <div>
              <h1>
                A few steps.
                <br />
                Then you’re set.
              </h1>
            </div>
            <p className="section-aside">
              Your desktop app and Chrome extension work together. Here’s how to
              connect them.
            </p>
          </div>
          <ol className="steps">
            <li>
              <span className="step-number">01</span>
              <div>
                <h3>Install the app</h3>
                <p>
                  <strong>Windows:</strong> open the downloaded .exe and follow
                  the installer.
                </p>
                <p>
                  <strong>Mac:</strong> open the .dmg, drag SecondHand into
                  Applications, then open it from Applications.
                </p>
                <details>
                  <summary>If your computer shows a warning</summary>
                  <div className="details-body">
                    <p>
                      These pilot builds don’t yet have a verified publisher
                      signature.
                    </p>
                    <p>
                      On Windows, SmartScreen may show “Windows protected your
                      PC.” Review the source before deciding whether to
                      continue. On a managed computer, ask your administrator.
                    </p>
                    <p>
                      On Mac, after attempting to open the app, go to System
                      Settings → Privacy & Security. If you trust this download,
                      use Open Anyway. Never disable your computer’s security
                      protections.
                    </p>
                    <a
                      href="https://support.apple.com/en-us/102445"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Apple’s guidance on opening apps{' '}
                      <ExternalIcon size={14} />
                    </a>
                  </div>
                </details>
              </div>
            </li>
            <li>
              <span className="step-number">02</span>
              <div>
                <h3>Create a password</h3>
                <p>
                  Choose a password of at least 12 characters, then save the
                  recovery key the app shows you. Add the information you want
                  to reuse; optional fields can stay blank.
                </p>
                <p className="small-note">
                  Forgot your password? Use the recovery key, or reset it on the
                  same computer if you left that option on. If you have neither,
                  you can start over with a new password. There’s no online
                  account. You can also export an encrypted backup from the app.
                </p>
              </div>
            </li>
            <li>
              <span className="step-number">03</span>
              <div>
                <h3>Add the Chrome extension</h3>
                <p>
                  In the app, choose{' '}
                  <strong>Chrome extension → Prepare Chrome extension</strong>.
                  The app opens its extension folder and sets up the connection.
                </p>
                <p>
                  In Chrome, enter <code>chrome://extensions</code> in the
                  address bar. Turn on <strong>Developer mode</strong>, choose{' '}
                  <strong>Load unpacked</strong>, and select that folder.
                </p>
                <p>
                  <Link href="/chrome-extension">
                    See each step with pictures
                  </Link>
                </p>
                <details>
                  <summary>Finding the folder on Windows or Mac</summary>
                  <div className="details-body">
                    <p>
                      Click <strong>Copy folder path</strong> in SecondHand. On
                      Windows, paste the path into the folder chooser’s address
                      bar. On Mac, press <kbd>⌘</kbd> + <kbd>Shift</kbd> +{' '}
                      <kbd>G</kbd> in the chooser, paste the path, and confirm.
                    </p>
                    <p>
                      Keep the extension folder where the app created it. You
                      only need to load it once.
                    </p>
                  </div>
                </details>
                <details>
                  <summary>Updating from an earlier version</summary>
                  <div className="details-body">
                    <p>
                      Install the new app and open it. If it comes with a newer
                      extension, the next time you open the side panel or click
                      Autofill, SecondHand refreshes the extension files and the
                      extension reloads itself. If an Iowa page was open,
                      SecondHand asks you to reload it; save your work first.
                      Chrome may ask you to approve the extension’s updated
                      permissions. Use Chrome 116 or newer, and keep{' '}
                      <strong>Developer mode</strong> on at{' '}
                      <code>chrome://extensions</code>, because Chrome turns
                      SecondHand off without it.
                    </p>
                    <p>
                      If you installed version 0.4.0 or earlier, its extension
                      can’t update itself, so do this once by hand. Install the
                      new app, choose <strong>Refresh extension files</strong>,
                      then click Reload for SecondHand on{' '}
                      <code>chrome://extensions</code>. Reload your Iowa tab
                      too. Then click Autofill on Iowa’s applicant page. Later
                      updates are automatic.
                    </p>
                  </div>
                </details>
              </div>
            </li>
          </ol>
          <div className="ready-strip">
            <div>
              <h3>Ready to apply?</h3>
              <p>
                Keep SecondHand unlocked and open Iowa’s portal in Chrome. Click
                Autofill in the corner and approve once in the desktop app, or
                choose Always allow. SecondHand moves past information-only
                screens and fills the pages it knows. Anything missing is
                flagged so you can jump straight to it. On some pages it knows,
                it selects Save and Continue, but only when every required
                answer is filled in. Review every answer and the first suggested
                home address before you submit.
              </p>
            </div>
            <a
              href="https://hhsservices.iowa.gov/apspssp/ssp.portal"
              target="_blank"
              rel="noreferrer"
            >
              Open Iowa portal <ExternalIcon size={17} />
            </a>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
