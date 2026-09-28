import type { Metadata } from 'next';
import { Home } from './home';
import { release } from './release';
import { siteUrl } from './site';

export const metadata: Metadata = {
  title: { absolute: 'Download SecondHand | Iowa SNAP helper for Windows and Mac' },
  description: 'Download SecondHand for Windows or Mac. Keep your details encrypted on your computer and use the included Chrome extension to fill supported fields in Iowa’s SNAP application.',
  alternates: { canonical: '/' },
};

// Describes the app for search engines. The common questions have their own page and data.
const structuredData = [
  {
    '@context': 'https://schema.org', '@type': 'SoftwareApplication',
    name: 'SecondHand', url: `${siteUrl}/`, downloadUrl: `${siteUrl}/`, softwareVersion: release,
    applicationCategory: 'UtilitiesApplication', operatingSystem: 'Windows 10 or later, macOS 13 or later',
    description: 'A desktop app and Chrome extension that keep your details encrypted on your computer and fill supported fields in Iowa’s SNAP application after you approve.',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  },
];

export default function Page() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData).replace(/</g, '\\u003c') }} />
      <Home />
    </>
  );
}
