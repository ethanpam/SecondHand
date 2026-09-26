'use client';

import { useState, type KeyboardEvent } from 'react';
import { CheckIcon, DownloadIcon, ExternalIcon } from './icons';

const release = '0.4.0';
const windows = `/download/secondHand-${release}-win-x64.exe`;
const macArm = `/download/secondHand-${release}-mac-arm64.dmg`;
const macIntel = `/download/secondHand-${release}-mac-x64.dmg`;
const platforms = [{ id: 'windows', label: 'Windows' }, { id: 'mac', label: 'Mac' }] as const;
type Platform = (typeof platforms)[number]['id'];

export default function Home() {
  const [platform, setPlatform] = useState<Platform>('windows');
  // Arrow keys, Home, and End move between tabs, following the ARIA tabs pattern.
  const moveBetweenTabs = (event: KeyboardEvent<HTMLButtonElement>) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const index = platforms.findIndex(item => item.id === platform);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? platforms.length - 1 :
      (index + (event.key === 'ArrowRight' ? 1 : -1) + platforms.length) % platforms.length;
    setPlatform(platforms[next].id);
    document.getElementById(`tab-${platforms[next].id}`)?.focus();
  };
  return (
    <>
      <a href="#downloads" className="skip">Skip to downloads</a>
      <header className="site-header wrap">
        <a href="#" className="brand" aria-label="secondHand home"><span className="brand-mark">sh</span>second<span>Hand</span></a>
        <nav aria-label="Main navigation"><a href="#setup">Setup guide</a><a href="#privacy">Your privacy</a></nav>
      </header>
      <main className="wrap">
        <section className="intro" id="downloads">
          <div className="intro-copy">
            <p className="eyebrow"><span className="status-dot" /> Iowa SNAP · Early access</p>
            <h1>A little help with<br />the paperwork.</h1>
            <p className="lead">Keep your information on your computer. Use it to fill supported fields in Iowa’s SNAP application, with you in control.</p>
            <div className="trust-line">Encrypted on your device <span>·</span> No account needed</div>
            <a className="text-link" href="#setup">How to get set up</a>
          </div>
          <div className="download-panel">
            <div className="panel-heading"><h2>Download secondHand</h2><span className="version">v{release}</span></div>
            <div className="platform-tabs" role="tablist" aria-label="Choose your computer">
              {platforms.map(({ id, label }) => (
                <button key={id} id={`tab-${id}`} type="button" role="tab" aria-selected={platform === id} aria-controls={`panel-${id}`}
                  tabIndex={platform === id ? 0 : -1} onClick={() => setPlatform(id)} onKeyDown={moveBetweenTabs}>{label}</button>
              ))}
            </div>
            <div id="panel-windows" role="tabpanel" aria-labelledby="tab-windows" hidden={platform !== 'windows'} className="download-content">
                <p className="download-title">For your Windows PC</p>
                <p className="muted">Windows 10 or later · 64-bit Intel / AMD</p>
                <a className="download-button" href={windows}><DownloadIcon /> Download for Windows <span>.exe</span></a>
                <p className="micro">Chrome extension included. No separate download needed.</p>
            </div>
            <div id="panel-mac" role="tabpanel" aria-labelledby="tab-mac" hidden={platform !== 'mac'} className="download-content">
                <p className="download-title">For your Mac</p>
                <p className="muted">macOS 13 or later · MacBook, iMac & Mac mini</p>
                <a className="download-button" href={macArm}><DownloadIcon /> Apple Silicon <span>.dmg</span></a>
                <a className="secondary-download" href={macIntel}>Download for Intel Mac <ExternalIcon /></a>
                <p className="micro">Find your chip in Apple menu → About This Mac. Choose Apple Silicon for an M-series chip.</p>
            </div>
            <div className="release-note"><p><strong>Early access builds are unsigned.</strong> Your computer may show a security warning. Read the setup notes below before opening.</p></div>
          </div>
        </section>

        <div className="scope-note"><span className="note-label">What it does today</span><p>A browser side panel tracks the applicant page with completion checkmarks and missing-field reminders. With your approval, it fills saved applicant details, address and mailing information, and your explicit program choices. It selects Save and Continue when required answers are complete, then checks the next step. Unverified later pages stay manual.</p></div>

        <section id="setup" className="setup-section">
          <div className="section-heading"><div><p className="eyebrow">One-time setup</p><h2>Three steps. Then you’re ready.</h2></div><span className="section-aside">Desktop app + Google Chrome</span></div>
          <ol className="steps">
            <li><span className="step-number">01</span><div><h3>Install the app</h3><p><strong>Windows:</strong> open the downloaded .exe and follow the installer.</p><p><strong>Mac:</strong> open the .dmg, drag secondHand into Applications, then open it from Applications.</p><details><summary>If your computer shows a warning</summary><div className="details-body"><p>These pilot builds don’t yet have a verified publisher signature.</p><p>On Windows, SmartScreen may show “Windows protected your PC.” Review the source before deciding whether to continue. On a managed computer, ask your administrator.</p><p>On Mac, after attempting to open the app, go to System Settings → Privacy & Security. If you trust this download, use Open Anyway. Never disable your computer’s security protections.</p><a href="https://support.apple.com/en-us/102445" target="_blank" rel="noreferrer">Apple’s guidance on opening apps <ExternalIcon size={14} /></a></div></details></div></li>
            <li><span className="step-number">02</span><div><h3>Create your private vault</h3><p>Choose a passphrase of at least 12 characters. Add the information you want to reuse; optional fields can stay blank.</p><p className="small-note">Keep your passphrase safe. There’s no online account or password reset. You can export an encrypted backup from the app.</p></div></li>
            <li><span className="step-number">03</span><div><h3>Add the Chrome extension</h3><p>In the app, choose <strong>Chrome extension → Prepare Chrome extension</strong>. The app opens its extension folder and sets up the connection.</p><p>In Chrome, enter <code>chrome://extensions</code> in the address bar. Turn on <strong>Developer mode</strong>, choose <strong>Load unpacked</strong>, and select that folder.</p><details><summary>Finding the folder on Windows or Mac</summary><div className="details-body"><p>Click <strong>Copy folder path</strong> in secondHand. On Windows, paste the path into the folder chooser’s address bar. On Mac, press <kbd>⌘</kbd> + <kbd>Shift</kbd> + <kbd>G</kbd> in the chooser, paste the path, and confirm.</p><p>Keep the extension folder where the app created it. You only need to load it once.</p></div></details><details><summary>Updating from an earlier version</summary><div className="details-body"><p>Install the new app, choose <strong>Refresh extension files</strong>, then click Reload for secondHand on <code>chrome://extensions</code>. Reload your Iowa tab too. Use Chrome 116 or newer. Chrome may ask you to approve the extension’s updated permissions. Click Open assistant on Iowa’s page to open the browser side panel.</p></div></details></div></li>
          </ol>
          <div className="ready-strip"><div><h3>Ready to apply?</h3><p>Keep secondHand unlocked and open Iowa’s portal in Chrome. Click the Open assistant button or the extension’s toolbar icon to open the side panel. Choose Start guided autofill and approve in the desktop app. Missing answers are listed with a Show field button; completed answers get a checkmark. An active session continues once required answers are complete.</p></div><a href="https://hhsservices.iowa.gov/apspssp/ssp.portal" target="_blank" rel="noreferrer">Open Iowa portal <ExternalIcon size={17} /></a></div>
        </section>

        <section id="privacy" className="privacy-section"><div><p className="eyebrow">Your information stays yours</p><h2>On your computer.<br />Under your control.</h2></div><div className="privacy-copy"><p>Your profile and application history are encrypted on your device. secondHand has no account system, cloud sync or analytics. This website hosts the installers; it does not collect your benefits information.</p><ul><li><CheckIcon /> The desktop asks you to approve filling and guided navigation.</li><li><CheckIcon /> Information you put into Iowa’s portal goes to Iowa.</li><li><CheckIcon /> You handle CAPTCHA, consent, signatures and submission.</li></ul><p className="small-note">Like other websites, the hosting provider may process connection logs. Your browser and the Iowa portal have their own privacy practices.</p></div></section>
      </main>
      <footer className="wrap"><div><a href="#" className="brand footer-brand"><span className="brand-mark">sh</span>second<span>Hand</span></a><p>Independent software. Not affiliated with Iowa HHS.<br />Using secondHand does not determine benefit eligibility.</p></div><a href={`/download/SHA256SUMS.txt?release=${release}`}>Download checksums <ExternalIcon size={14} /></a></footer>
    </>
  );
}
