import type { Metadata } from 'next';
import { Home } from './_home/home';
import { release } from '../lib/release';
import { siteUrl } from '../lib/site';

export const metadata: Metadata = {
  title: { absolute: 'SecondHand | Iowa SNAP helper for Windows and Mac' },
  description:
    'Meet SecondHand for Windows and Mac. Keep your details encrypted on your computer and use the included Chrome extension to fill supported fields in Iowa’s SNAP application.',
  alternates: { canonical: '/' },
};

// Describes the app for search engines. The common questions have their own page and data.
const structuredData = [
  {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'SecondHand',
    url: `${siteUrl}/`,
    downloadUrl: `${siteUrl}/downloads`,
    softwareVersion: release,
    applicationCategory: 'UtilitiesApplication',
    operatingSystem: 'Windows 10 or later, macOS 13 or later',
    description:
      'A desktop app and Chrome extension that keep your details encrypted on your computer and fill supported fields in Iowa’s SNAP application after you approve.',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  },
];

export default function Page() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(structuredData).replace(/</g, '\\u003c'),
        }}
      />
      <Home />
    </>
  );
}
