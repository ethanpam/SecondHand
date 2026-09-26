import Link from 'next/link';
import { ExternalIcon } from './icons';
import { downloads, release } from './release';

function Brand({ className = 'brand' }: { className?: string }) {
  return <Link href="/" className={className} aria-label="secondHand home">secondHand<span className="brand-tag" aria-hidden="true">IOWA</span></Link>;
}

export function SiteHeader() {
  return (
    <>
      <a href="#main" className="skip">Skip to content</a>
      <header className="site-header">
        <div className="header-bar">
          <Brand />
          <nav aria-label="Main navigation"><Link href="/#setup">Setup guide</Link><Link href="/#faq">Questions</Link><Link href="/privacy">Privacy policy</Link></nav>
          <Link href="/#downloads" className="header-cta">Download</Link>
        </div>
      </header>
    </>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="wrap footer-grid">
        <div className="footer-about">
          <Brand className="brand footer-brand" />
          <p>Prepare your Iowa SNAP application on your own computer. Independent software, not affiliated with Iowa HHS.</p>
        </div>
        <nav aria-label="Footer" className="footer-columns">
          <div><h2>Download</h2><Link href="/thank-you/windows">Windows</Link><Link href="/thank-you/mac-apple-silicon">Mac with Apple silicon</Link><Link href="/thank-you/mac-intel">Intel Mac</Link></div>
          <div><h2>Help</h2><Link href="/#setup">Setup guide</Link><Link href="/#faq">Common questions</Link><a href="https://hhsservices.iowa.gov/apspssp/ssp.portal" target="_blank" rel="noreferrer">Iowa’s portal <ExternalIcon size={14} /></a></div>
          <div><h2>About</h2><Link href="/privacy">Privacy policy</Link><a href={downloads.checksums}>Download checksums</a></div>
        </nav>
      </div>
      <div className="wrap">
        <div className="footer-bottom">
          <p>Using secondHand does not determine benefit eligibility.</p>
          <p className="footer-version"><span className="dot" aria-hidden="true" />Version {release}</p>
        </div>
      </div>
    </footer>
  );
}
