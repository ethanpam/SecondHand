import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { SiteFooter, SiteHeader } from '../site-chrome';
import { GuideVideo } from './guide-video';

export const metadata: Metadata = {
  title: 'Add SecondHand to Chrome',
  description:
    'A step-by-step guide, with pictures, to adding the SecondHand extension to Google Chrome after you install the app.',
  alternates: { canonical: '/chrome-extension' },
};

export default function ChromeExtensionGuide() {
  return (
    <>
      <SiteHeader />
      <main id="main" className="wrap doc-page guide-page">
        <h1>Add SecondHand to Chrome</h1>
        <p className="doc-lead">
          Do this once, after you install the SecondHand app. It takes about two
          minutes. You need Google Chrome 116 or newer. Don’t have the app yet?{' '}
          <Link href="/#downloads">Download SecondHand</Link>.
        </p>

        <section aria-labelledby="step-prepare">
          <h2 id="step-prepare">1. Prepare the extension in SecondHand</h2>
          <p>
            Open SecondHand and unlock it. Choose{' '}
            <strong>Chrome extension</strong> in the sidebar, then click{' '}
            <strong>Prepare Chrome extension</strong>.
          </p>
          <p>
            SecondHand saves the extension in a folder on your computer and
            shows where it is. Click <strong>Copy folder path</strong>. You’ll
            paste it in step 3.
          </p>
          <GuideVideo
            src="/guide/prepare.mp4"
            poster="/guide/prepare.jpg"
            width={1800}
            height={1300}
            label="In SecondHand, clicking Prepare Chrome extension shows the extension folder. Copy folder path copies its location."
          />
        </section>

        <section aria-labelledby="step-developer-mode">
          <h2 id="step-developer-mode">2. Turn on Developer mode in Chrome</h2>
          <p>
            Open Google Chrome, type <code>chrome://extensions</code> in the
            address bar, and press Enter. Turn on{' '}
            <strong>Developer mode</strong> in the top-right corner. Three
            buttons appear.
          </p>
          <p>
            Chrome asks for this because this early version of SecondHand isn’t
            in the Chrome Web Store yet.
          </p>
          <GuideVideo
            src="/guide/developer-mode.mp4"
            poster="/guide/developer-mode.jpg"
            width={1800}
            height={560}
            label="On Chrome’s extensions page, turning on Developer mode shows the Load unpacked button."
          />
        </section>

        <section aria-labelledby="step-load">
          <h2 id="step-load">3. Load the SecondHand folder</h2>
          <p>
            Click <strong>Load unpacked</strong>. A window opens for choosing a
            folder.
          </p>
          <ul>
            <li>
              <strong>Mac:</strong> press Command + Shift + G, paste the path
              you copied, press Return, then click <strong>Select</strong>.
            </li>
            <li>
              <strong>Windows:</strong> paste the path into the bar at the top
              of the window, press Enter, then click{' '}
              <strong>Select Folder</strong>.
            </li>
          </ul>
          <p>SecondHand now appears in your list of extensions:</p>
          <Image
            className="guide-media"
            src="/guide/loaded.jpg"
            alt="Chrome’s extensions page with Developer mode on and the SecondHand · Iowa SNAP companion extension listed."
            width={1800}
            height={880}
            unoptimized
          />
        </section>

        <section aria-labelledby="step-use">
          <h2 id="step-use">4. Use it on Iowa’s application</h2>
          <p>
            Keep SecondHand open and unlocked. In Chrome, open{' '}
            <a href="https://hhsservices.iowa.gov/apspssp/ssp.portal">
              Iowa’s benefits portal
            </a>
            . This card appears in the bottom-right corner of the page:
          </p>
          <Image
            className="guide-media guide-card"
            src="/guide/iowa-card.png"
            alt="The SecondHand card on Iowa’s page, with the SecondHand logo and an Autofill button."
            width={624}
            height={228}
            unoptimized
          />
          <p>
            Click <strong>Autofill</strong> to fill the details you saved, or
            click the SecondHand logo to open the checklist in Chrome’s side
            panel. SecondHand asks the first time before it shares your details,
            and you review and submit the application yourself.
          </p>
          <p>
            To keep SecondHand one click away, click the puzzle-piece icon in
            Chrome’s toolbar and pin SecondHand.
          </p>
        </section>

        <section aria-labelledby="after-update">
          <h2 id="after-update">After you update SecondHand</h2>
          <p>
            Install the new app and open it. The next time you open the side
            panel or click <strong>Autofill</strong>, SecondHand refreshes the
            extension files and the extension reloads itself. If an Iowa page
            was open, SecondHand asks you to reload it; save your work first.
            Keep <strong>Developer mode</strong> on at{' '}
            <code>chrome://extensions</code>, because Chrome turns SecondHand
            off without it. Your saved information stays in the app.
          </p>
          <p>
            If you installed version 0.4.0, its extension can’t update itself,
            so do this once by hand. Open the app’s{' '}
            <strong>Chrome extension</strong> page and click{' '}
            <strong>Refresh extension files</strong>. Then click the reload icon
            on SecondHand’s card at <code>chrome://extensions</code>, and reload
            your Iowa tab. Later updates are automatic.
          </p>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
