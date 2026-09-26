import Link from 'next/link';
import { ExternalIcon } from './icons';
import { downloads } from './release';

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
    <footer className="wrap">
      <div><Brand className="brand footer-brand" /><p>Independent software. Not affiliated with Iowa HHS.<br />Using secondHand does not determine benefit eligibility.</p></div>
      <nav aria-label="Footer" className="footer-links">
        <Link href="/">Download</Link><Link href="/#setup">Setup guide</Link><Link href="/#faq">Common questions</Link><Link href="/privacy">Privacy policy</Link>
        <a href={downloads.checksums}>Download checksums <ExternalIcon size={14} /></a>
      </nav>
    </footer>
  );
}
