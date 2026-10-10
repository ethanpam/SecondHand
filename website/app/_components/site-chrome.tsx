import Image from 'next/image';
import { ArrowIcon } from './icons';
import { VariableWordmark } from './variable-wordmark';

function Brand({ className = 'brand' }: { className?: string }) {
  return (
    <a href="/" className={className} aria-label="SecondHand home">
      <Image
        className="brand-mark"
        src="/brand/secondhand-mascot.png"
        alt=""
        width={40}
        height={40}
        unoptimized
      />
      Second<span>Hand</span>
    </a>
  );
}

const mainLinks = [
  { href: '/how-it-works', label: 'How it works' },
  { href: '/setup', label: 'Setup guide' },
  { href: '/chrome-extension', label: 'Add to Chrome' },
  { href: '/faq', label: 'Questions' },
];

// `current` is the path of the page being shown, so its link is marked.
export function SiteHeader({ current }: { current?: string } = {}) {
  return (
    <>
      <a href="#main" className="skip">
        Skip to content
      </a>
      <header className="site-header wrap">
        <Brand />
        <nav aria-label="Main navigation">
          {mainLinks.map(({ href, label }) => (
            <a
              key={href}
              href={href}
              aria-current={href === current ? 'page' : undefined}
            >
              {label}
            </a>
          ))}
        </nav>
        <a className="header-download" href="/downloads">
          Get SecondHand <ArrowIcon size={15} />
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
            Using SecondHand does not determine benefit eligibility.
          </p>
        </div>
        <nav aria-label="Footer" className="footer-links">
          <a href="/downloads">Download</a>
          <a href="/how-it-works">How it works</a>
          <a href="/setup">Setup guide</a>
          <a href="/chrome-extension">Add to Chrome</a>
          <a href="/faq">Common questions</a>
          <a href="/privacy">Privacy policy</a>
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
