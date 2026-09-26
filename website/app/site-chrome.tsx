import { ArrowIcon, ExternalIcon } from './icons';
import { downloads } from './release';
import { VariableWordmark } from './variable-wordmark';

function Brand({ className = 'brand' }: { className?: string }) {
  return (
    <a href="/" className={className} aria-label="secondHand home">
      <span className="brand-mark">sh</span>second<span>Hand</span>
    </a>
  );
}

export function SiteHeader() {
  return (
    <>
      <a href="#main" className="skip">
        Skip to content
      </a>
      <header className="site-header wrap">
        <Brand />
        <nav aria-label="Main navigation">
          <a href="/#setup">Setup guide</a>
          <a href="/#faq">Questions</a>
          <a href="/privacy">Privacy</a>
        </nav>
        <a className="header-download" href="/#downloads">
          Get secondHand <ArrowIcon size={15} />
        </a>
      </header>
    </>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer wrap">
      <div className="footer-top">
        <div>
          <Brand className="brand footer-brand" />
          <p>
            Independent software. Not affiliated with Iowa HHS.
            <br />
            Using secondHand does not determine benefit eligibility.
          </p>
        </div>
        <nav aria-label="Footer" className="footer-links">
          <a href="/">Download</a>
          <a href="/#setup">Setup guide</a>
          <a href="/#faq">Common questions</a>
          <a href="/privacy">Privacy policy</a>
          <a href={downloads.checksums}>
            Download checksums <ExternalIcon size={14} />
          </a>
        </nav>
      </div>
      <VariableWordmark />
      <div className="footer-bottom">
        <span>A helping hand for Iowa SNAP.</span>
        <a href="#main">Back to top ↑</a>
      </div>
    </footer>
  );
}
