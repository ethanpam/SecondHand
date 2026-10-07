'use client';

import { useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { CheckIcon, DownloadIcon, ExternalIcon } from '../_components/icons';
import { downloads, release } from '../../lib/release';

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

export function DownloadOptions() {
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
    <section
      className="intro"
      id="downloads"
      aria-labelledby="download-heading"
    >
      <div className="intro-copy">
        <h1 id="download-heading">Get SecondHand</h1>
        <p className="lead">
          Save your details once in an encrypted app on your computer. After you
          approve, its Chrome extension fills the supported fields in Iowa’s
          SNAP application.
        </p>
        <ul className="promise-list">
          <li>
            <CheckIcon size={16} /> Encrypted on your computer. No account,
            cloud sync or analytics.
          </li>
          <li>
            <CheckIcon size={16} /> The app asks before filling, unless you
            choose Always allow.
          </li>
          <li>
            <CheckIcon size={16} /> It never submits your application. You
            handle CAPTCHA, consent, signatures and submission.
          </li>
        </ul>
        <p className="small-note promise-note">
          What you enter in Iowa’s portal goes to Iowa. This website only hosts
          the installers. Read the full <a href="/privacy">privacy policy</a>.
        </p>
        <a className="text-link" href="/setup">
          How to get set up
        </a>
      </div>
      <div className="download-panel">
        <div className="panel-heading">
          <h3>Download SecondHand</h3>
          <span className="version">v{release}</span>
        </div>
        <p className="phone-note">
          SecondHand installs on Windows and Mac computers. Open this page on
          your computer to download it.
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
            Windows 10 or later <span aria-hidden="true">·</span> 64-bit Intel /
            AMD
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
            macOS 13 or later <span aria-hidden="true">·</span> MacBook, iMac
            &amp; Mac mini
          </p>
          <a className="download-button" href="/thank-you/mac-apple-silicon">
            <DownloadIcon /> Apple Silicon <span>.dmg</span>
          </a>
          <a className="secondary-download" href="/thank-you/mac-intel">
            Download for Intel Mac
          </a>
          <p className="micro">
            Find your chip in Apple menu → About This Mac. Choose Apple Silicon
            for an M-series chip.
          </p>
        </div>
        <p className="micro">
          <a className="text-link" href={downloads.checksums}>
            Download checksums <ExternalIcon size={14} />
          </a>
        </p>
        <div className="release-note">
          <p>
            <strong>Early access builds are unsigned.</strong> Your computer may
            show a security warning. Read the{' '}
            <a href="/setup#setup">setup notes</a> before opening.
          </p>
        </div>
      </div>
    </section>
  );
}
