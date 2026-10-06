'use client';

import { useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { ArrowIcon, CheckIcon, DownloadIcon, ExternalIcon } from './icons';
import Link from 'next/link';
import { GradientBackground } from './gradient-background';
import { release } from './release';
import { SiteFooter, SiteHeader } from './site-chrome';
import { TextType } from './text-type';
import { AutofillDemo } from './autofill-demo';

const platforms = [
  { id: 'windows', label: 'Windows' },
  { id: 'mac', label: 'Mac' },
] as const;
type Platform = (typeof platforms)[number]['id'];

// Open the panel on the visitor's own computer so the first button fits it.
// The server always renders Windows; the browser swaps in the detected value.
// iPads report a Mac platform, so a Mac also needs a mouse-style pointer.
function detectPlatform(): Platform {
  const name =
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform || navigator.platform;
  return /mac/i.test(name) && navigator.maxTouchPoints < 2 ? 'mac' : 'windows';
}
const noSubscription = () => () => {};

export function Home() {
  const detected = useSyncExternalStore(
    noSubscription,
    detectPlatform,
    (): Platform => 'windows',
  );
  const [chosen, setPlatform] = useState<Platform | null>(null);
  const platform = chosen ?? detected;
  // Arrow keys, Home, and End move between tabs, following the ARIA tabs pattern.
  const moveBetweenTabs = (event: KeyboardEvent<HTMLButtonElement>) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const index = platforms.findIndex((item) => item.id === platform);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? platforms.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + platforms.length) %
            platforms.length;
    setPlatform(platforms[next].id);
    document.getElementById(`tab-${platforms[next].id}`)?.focus();
  };
  return (
    <div className="home-page">
      <SiteHeader />
      <main id="main">
        <section className="hero" aria-labelledby="hero-heading">
          <GradientBackground />
          <div className="hero-content wrap">
            <div className="hero-copy">
              <h1 id="hero-heading">
                <span>A little help.</span>
                <span>A lot less typing.</span>
              </h1>
              <p className="hero-lead">
                Applying for Iowa SNAP? Keep your details on your computer. Let
                SecondHand fill the supported fields, with your permission.
              </p>
              <div className="hero-actions">
                <a className="primary-link" href="#downloads">
                  Get SecondHand <ArrowIcon size={20} />
                </a>
                <a className="secondary-link" href="#setup">
                  Setup guide
                </a>
              </div>
              <p className="hero-note">
                Free for Windows &amp; Mac. No account needed.
              </p>
            </div>
          </div>
        </section>

        <div className="wrap page-content">
          <section
            id="demo"
            className="demo-section"
            aria-labelledby="demo-heading"
          >
            <h2 id="demo-heading">
              <TextType text={'Ready for\nless typing?'} />
            </h2>
            <AutofillDemo />
          </section>

          <div className="scope-note">
            <span className="note-label">What it does today</span>
            <div>
              <p>
                A browser side panel tracks the applicant page with completion
                checkmarks and missing-field reminders. With your approval, it
                fills saved applicant details, address and mailing information,
                and your explicit program choices, then selects Save and
                Continue when required answers are complete. On the home-address
                page, when SecondHand recognizes it, it selects Iowa’s first
                suggested home address and continues, so review that address
                before you submit.
              </p>
              <p>
                It answers Iowa’s Tell Us More questions only from answers you
                saved in My information. If you turn on Laya, SecondHand’s AI on
                this computer, it fills more questions and marks them as guesses
                to check. It moves past information-only screens for you. It
                also selects Save and Continue on Tell Us More, Background
                Information, and Iowa’s questions about emergency SNAP, jobs,
                income, expenses and property. It does the same on pages for one
                person’s saved job, private pension, Social Security, rent,
                utilities or cash. It does this only when it knows every
                question on the page and every required answer is filled in. If
                a required answer is missing, or Iowa shows an error or pop-up,
                it stays on that page. Anywhere else, you move on yourself. You handle
                consent, signatures and submission.
              </p>
              <p>
                The side panel works in English, Spanish, Vietnamese, Chinese,
                French and Arabic. On Iowa’s information-only screens, it can
                list what the screen says and show its words in your language,
                using Chrome’s built-in summarizer and translator on this
                computer, when that Chrome has them.
              </p>
            </div>
          </div>

          <section
            className="intro"
            id="downloads"
            aria-labelledby="download-heading"
          >
            <div className="intro-copy">
              <h2 id="download-heading">
                Your details,
                <br />
                ready to reuse.
              </h2>
              <p className="lead">
                Save your details once in an encrypted app on your computer.
                After you approve, its Chrome extension fills the supported
                fields in Iowa’s SNAP application.
              </p>
              <ul className="promise-list">
                <li>
                  <CheckIcon size={16} /> Encrypted on your computer. No
                  account, cloud sync or analytics.
                </li>
                <li>
                  <CheckIcon size={16} /> The app asks before filling, unless
                  you choose Always allow.
                </li>
                <li>
                  <CheckIcon size={16} /> It never submits your application. You
                  handle CAPTCHA, consent, signatures and submission.
                </li>
              </ul>
              <p className="small-note promise-note">
                What you enter in Iowa’s portal goes to Iowa. This website only
                hosts the installers. Read the full{' '}
                <a href="/privacy">privacy policy</a>.
              </p>
              <a className="text-link" href="#setup">
                How to get set up
              </a>
            </div>
            <div className="download-panel">
              <div className="panel-heading">
                <h3>Download SecondHand</h3>
                <span className="version">v{release}</span>
              </div>
              <p className="phone-note">
                SecondHand installs on Windows and Mac computers. Open this page
                on your computer to download it.
              </p>
              <div
                className="platform-tabs"
                role="tablist"
                aria-label="Choose your computer"
              >
                {platforms.map(({ id, label }) => (
                  <button
                    key={id}
                    id={`tab-${id}`}
                    type="button"
                    role="tab"
                    aria-selected={platform === id}
                    aria-controls={`panel-${id}`}
                    tabIndex={platform === id ? 0 : -1}
                    onClick={() => setPlatform(id)}
                    onKeyDown={moveBetweenTabs}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div
                id="panel-windows"
                role="tabpanel"
                aria-labelledby="tab-windows"
                hidden={platform !== 'windows'}
                className="download-content"
              >
                <p className="download-title">For your Windows PC</p>
                <p className="muted">
                  Windows 10 or later <span aria-hidden="true">·</span> 64-bit
                  Intel / AMD
                </p>
                <a className="download-button" href="/thank-you/windows">
                  <DownloadIcon /> Download for Windows <span>.exe</span>
                </a>
                <p className="micro">
                  Chrome extension included. No separate download needed.
                </p>
              </div>
              <div
                id="panel-mac"
                role="tabpanel"
                aria-labelledby="tab-mac"
                hidden={platform !== 'mac'}
                className="download-content"
              >
                <p className="download-title">For your Mac</p>
                <p className="muted">
                  macOS 13 or later <span aria-hidden="true">·</span> MacBook,
                  iMac &amp; Mac mini
                </p>
                <a
                  className="download-button"
                  href="/thank-you/mac-apple-silicon"
                >
                  <DownloadIcon /> Apple Silicon <span>.dmg</span>
                </a>
                <a className="secondary-download" href="/thank-you/mac-intel">
                  Download for Intel Mac
                </a>
                <p className="micro">
                  Find your chip in Apple menu → About This Mac. Choose Apple
                  Silicon for an M-series chip.
                </p>
              </div>
              <div className="release-note">
                <p>
                  <strong>Early access builds are unsigned.</strong> Your
                  computer may show a security warning. Read the setup notes
                  below before opening.
                </p>
              </div>
            </div>
          </section>

          <section id="setup" className="setup-section">
            <div className="section-heading">
              <div>
                <h2>
                  A few steps.
                  <br />
                  Then you’re set.
                </h2>
              </div>
              <p className="section-aside">
                Your desktop app and Chrome extension work together. Here’s how
                to connect them.
              </p>
            </div>
            <ol className="steps">
              <li>
                <span className="step-number">01</span>
                <div>
                  <h3>Install the app</h3>
                  <p>
                    <strong>Windows:</strong> open the downloaded .exe and
                    follow the installer.
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
                        Settings → Privacy & Security. If you trust this
                        download, use Open Anyway. Never disable your computer’s
                        security protections.
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
                    Forgot your password? Use the recovery key, or reset it on
                    the same computer if you left that option on. If you have
                    neither, you can start over with a new password. There’s no
                    online account. You can also export an encrypted backup from
                    the app.
                  </p>
                </div>
              </li>
              <li>
                <span className="step-number">03</span>
                <div>
                  <h3>Add the Chrome extension</h3>
                  <p>
                    In the app, choose{' '}
                    <strong>Chrome extension → Prepare Chrome extension</strong>
                    . The app opens its extension folder and sets up the
                    connection.
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
                        Click <strong>Copy folder path</strong> in SecondHand.
                        On Windows, paste the path into the folder chooser’s
                        address bar. On Mac, press <kbd>⌘</kbd> +{' '}
                        <kbd>Shift</kbd> + <kbd>G</kbd> in the chooser, paste
                        the path, and confirm.
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
                        Install the new app and open it. If it comes with a
                        newer extension, the next time you open the side panel
                        or click Autofill, SecondHand refreshes the extension
                        files and the extension reloads itself. If an Iowa page
                        was open, SecondHand asks you to reload it; save your
                        work first. Chrome may ask you to approve the
                        extension’s updated permissions. Use Chrome 116 or
                        newer, and keep <strong>Developer mode</strong> on at{' '}
                        <code>chrome://extensions</code>, because Chrome turns
                        SecondHand off without it.
                      </p>
                      <p>
                        If you installed version 0.4.0 or earlier, its extension
                        can’t update itself, so do this once by hand. Install
                        the new app, choose{' '}
                        <strong>Refresh extension files</strong>, then click
                        Reload for SecondHand on{' '}
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
                  Keep SecondHand unlocked and open Iowa’s portal in Chrome.
                  Click Autofill in the corner and approve once in the desktop
                  app, or choose Always allow. SecondHand moves past
                  information-only screens and fills the pages it knows.
                  Anything missing is flagged so you can jump straight to it. On
                  some pages it knows, it selects Save and Continue, but only
                  when every required answer is filled in. Review every answer
                  and the first suggested home address before you submit.
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

          <section
            className="faq-callout"
            aria-labelledby="faq-callout-heading"
          >
            <h2 id="faq-callout-heading">Still have questions?</h2>
            <Link className="text-link" href="/faq">
              Read the common questions
            </Link>
          </section>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
