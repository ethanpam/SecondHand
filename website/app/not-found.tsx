import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteFooter, SiteHeader } from './site-chrome';

export const metadata: Metadata = {
  title: 'Page not found',
  robots: { index: false, follow: true },
};

export default function NotFound() {
  return (
    <>
      <SiteHeader />
      <main id="main" className="wrap doc-page">
        <h1>Page not found</h1>
        <p className="doc-lead">This page doesn’t exist or has moved. These links can help you find what you need.</p>
        <ul className="not-found-links">
          <li><Link href="/">Download secondHand for Windows or Mac</Link></li>
          <li><Link href="/#setup">Setup guide</Link></li>
          <li><Link href="/#faq">Common questions</Link></li>
          <li><Link href="/privacy">Privacy policy</Link></li>
        </ul>
      </main>
      <SiteFooter />
    </>
  );
}
