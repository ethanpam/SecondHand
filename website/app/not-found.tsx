import type { Metadata } from 'next';
import { SiteFooter, SiteHeader } from './site-chrome';

export const metadata: Metadata = {
  title: 'Page not found',
  description:
    'This secondHand page doesn’t exist or has moved. Find downloads, the setup guide, common questions, and the privacy policy.',
  robots: { index: false, follow: true },
};

export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main id="main" className="wrap doc-page">
        <p className="eyebrow">404 / A small detour</p>
        <h1>Page not found</h1>
        <p className="doc-lead">
          This page doesn’t exist or has moved. These links can help you find
          what you need.
        </p>
        <ul className="not-found-links">
          <li>
            <a href="/">Download secondHand for Windows or Mac</a>
          </li>
          <li>
            <a href="/#setup">Setup guide</a>
          </li>
          <li>
            <a href="/#faq">Common questions</a>
          </li>
          <li>
            <a href="/privacy">Privacy policy</a>
          </li>
        </ul>
      </main>
      <SiteFooter />
    </>
  );
}
