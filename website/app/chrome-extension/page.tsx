import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { SiteFooter, SiteHeader } from '../_components/site-chrome';
import { LoopVideo } from '../_components/loop-video';
import { SetupPath } from '../_components/setup-path';

export const metadata: Metadata = {
  title: 'Add SecondHand to Chrome',
  description:
    'A step-by-step guide, with pictures, to adding the SecondHand extension to Google Chrome after you install the app.',
  alternates: { canonical: '/chrome-extension' },
};

// One click, one picture. The red ring marks what to click. On a phone, a
// closer crop around the ring keeps Chrome's small text readable.
function Shot({
  name,
  width,
  height,
  alt,
  zoom = true,
  children,
}: {
  name: string;
  width: number;
  height: number;
  alt: string;
  zoom?: boolean;
  children: ReactNode;
}) {
  return (
    <li>
      <p>{children}</p>
      <picture>
        {zoom && (
          <source
            media="(max-width: 640px)"
            srcSet={`/guide/steps/${name}-zoom.png`}
          />
        )}
        <Image
          className="guide-shot"
          src={`/guide/steps/${name}.png`}
          alt={alt}
          width={width}
          height={height}
          unoptimized
        />
      </picture>
    </li>
  );
}

export default function ChromeExtensionGuide() {
  return (
    <>
      <SiteHeader current="/chrome-extension" />
      <main id="main" className="wrap doc-page guide-page">
        <SetupPath current="/chrome-extension" />
        <h1>Add SecondHand to Chrome</h1>
        <p className="doc-lead">
          Do this once, after you install the SecondHand app. It takes about two
          minutes. You need Google Chrome 116 or newer. Don’t have the app yet?{' '}
          <Link href="/downloads">Download SecondHand</Link>.
        </p>
        <p className="guide-tip">
          In each picture, the red ring shows where to click. Take your time:
          nothing changes until you click.
        </p>

        <nav className="guide-contents" aria-label="Steps on this page">
          <ol>
            <li>
              <a href="#step-prepare">Prepare the extension in SecondHand</a>
            </li>
            <li>
              <a href="#step-developer-mode">
                Turn on Developer mode in Chrome
              </a>
            </li>
            <li>
              <a href="#step-load">Load the SecondHand folder</a>
            </li>
            <li>
              <a href="#step-pin">Pin SecondHand and use it</a>
            </li>
          </ol>
        </nav>

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
          <LoopVideo
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
            Chrome asks for this because this early version of SecondHand isn’t
            in the Chrome Web Store yet.
          </p>
          <ol className="guide-shots">
            <Shot
              name="address"
              width={1200}
              height={270}
              alt="Chrome’s address bar at the top of the window, circled, with chrome://extensions typed in it."
            >
              Open Google Chrome. Click the address bar at the very top, type{' '}
              <code>chrome://extensions</code>, and press <kbd>Enter</kbd> (on a
              Mac, <kbd>Return</kbd>).
            </Shot>
            <Shot
              name="developer-mode"
              width={1200}
              height={300}
              alt="Chrome’s Extensions page. The Developer mode switch in the top-right corner is circled. It is off."
            >
              Chrome’s Extensions page opens. Click the{' '}
              <strong>Developer mode</strong> switch in the top-right corner.
            </Shot>
            <Shot
              name="load-unpacked"
              width={1200}
              height={300}
              alt="Developer mode is now on, and three buttons appear on the left: Load unpacked, which is circled, Pack extension, and Update."
            >
              The switch turns blue and three buttons appear on the left.
            </Shot>
          </ol>
          <p>Here it is as a short video:</p>
          <LoopVideo
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
            These pictures are from a Mac. On Windows, see{' '}
            <a href="#windows-folder">the Windows steps</a> below.
          </p>
          <ol className="guide-shots">
            <Shot
              name="folder-window"
              zoom={false}
              width={910}
              height={490}
              alt="A Mac window titled Select the extension directory has opened over Chrome, with Cancel and Select buttons. The folder names in it are blurred."
            >
              Click <strong>Load unpacked</strong>. A window opens for choosing
              a folder. It may show different folders than this one.
            </Shot>
            <Shot
              name="go-to-folder"
              width={910}
              height={490}
              alt="A Go to box over the folder window, circled, with the path ending in SecondHand/chrome-extension pasted in."
            >
              Hold <kbd>Command</kbd> and <kbd>Shift</kbd> and press{' '}
              <kbd>G</kbd>. A box opens. Hold <kbd>Command</kbd> and press{' '}
              <kbd>V</kbd> to paste the path you copied in step 1, then press{' '}
              <kbd>Return</kbd>.
            </Shot>
            <Shot
              name="select"
              width={910}
              height={490}
              alt="The folder window now shows the chrome-extension folder at the top. The blue Select button in the bottom-right corner is circled."
            >
              The window now shows the <strong>chrome-extension</strong> folder
              at the top. Click <strong>Select</strong>.
            </Shot>
            <Shot
              name="loaded"
              width={1200}
              height={560}
              alt="Chrome’s Extensions page with the SecondHand extension card circled. It shows version 0.5.0 and its switch is on."
            >
              SecondHand now appears in your list of extensions. You’re finished
              with this page.
            </Shot>
          </ol>
          <h3 id="windows-folder">On Windows</h3>
          <ol className="guide-steps-text">
            <li>
              Click <strong>Load unpacked</strong>. A window opens for choosing
              a folder.
            </li>
            <li>
              Click the bar at the top of that window that shows the current
              folder’s location.
            </li>
            <li>
              Hold <kbd>Ctrl</kbd> and press <kbd>V</kbd> to paste the path you
              copied in step 1, then press <kbd>Enter</kbd>.
            </li>
            <li>
              Click <strong>Select Folder</strong>. SecondHand appears in your
              list of extensions.
            </li>
          </ol>
        </section>

        <section aria-labelledby="step-pin">
          <h2 id="step-pin">4. Pin SecondHand and use it</h2>
          <ol className="guide-shots">
            <Shot
              name="puzzle-menu"
              width={1200}
              height={320}
              alt="The puzzle-piece button in Chrome’s toolbar is circled, and its Extensions menu is open. Next to SecondHand, the pin button is circled."
            >
              To keep SecondHand one click away, click the puzzle-piece button
              in Chrome’s toolbar, near the top-right corner. Then click the pin
              next to SecondHand.
            </Shot>
            <Shot
              name="pinned"
              width={1200}
              height={200}
              alt="Chrome’s toolbar with the green SecondHand icon, circled, next to the puzzle-piece button."
            >
              The SecondHand icon now stays in the toolbar.
            </Shot>
          </ol>
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
            alt="The SecondHand card on Iowa’s page. It says the SecondHand app asks you first, then SecondHand fills each page and moves on. If Iowa suggests addresses, SecondHand picks the first, so make sure it is yours, and it never signs or sends your application. Below are the SecondHand logo, an Autofill button and a Hide button."
            width={652}
            height={408}
            unoptimized
          />
          <p>
            Click <strong>Autofill</strong> to fill the details you saved, or
            click the SecondHand logo to open the checklist in Chrome’s side
            panel. SecondHand asks the first time before it shares your details,
            and you review and submit the application yourself.{' '}
            <Link href="/how-it-works">See what happens next</Link>.
          </p>
        </section>

        <section aria-labelledby="after-update">
          <h2 id="after-update">After you update SecondHand</h2>
          <p>
            Install the new app and open it. If it comes with a newer extension,
            the next time you open the side panel or click{' '}
            <strong>Autofill</strong>, SecondHand refreshes the extension files
            and the extension reloads itself. If an Iowa page was open,
            SecondHand asks you to reload it; save your work first. Keep{' '}
            <strong>Developer mode</strong> on at{' '}
            <code>chrome://extensions</code>, because Chrome turns SecondHand
            off without it. Your saved information stays in the app.
          </p>
          <p>
            If you installed version 0.4.0 or earlier, its extension can’t
            update itself, so do this once by hand. Open the app’s{' '}
            <strong>Chrome extension</strong> page and click{' '}
            <strong>Refresh extension files</strong>. Then click the reload icon
            on SecondHand’s card at <code>chrome://extensions</code>, and reload
            your Iowa tab. Later updates are automatic.
          </p>
        </section>
        <p className="guide-back-link">
          <Link href="/setup">Back to the full setup guide</Link>
        </p>
      </main>
      <SiteFooter />
    </>
  );
}
