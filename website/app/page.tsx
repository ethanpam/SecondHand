import type { Metadata } from 'next';
import { faq } from './faq';
import { Home } from './home';
import { release } from './release';
import { siteUrl } from './site';

export const metadata: Metadata = {
  title: { absolute: 'Download secondHand | Iowa SNAP helper for Windows and Mac' },
  description: 'Download secondHand for Windows or Mac. Keep your details encrypted on your computer and use the included Chrome extension to fill supported fields in Iowa’s SNAP application.',
  alternates: { canonical: '/' },
};

// Describes the app and the FAQ for search engines. The FAQ text comes from the
// same data the page renders, so the two cannot drift apart.
const structuredData = [
  {
    '@context': 'https://schema.org', '@type': 'SoftwareApplication',
    name: 'secondHand', url: `${siteUrl}/`, downloadUrl: `${siteUrl}/`, softwareVersion: release,
    applicationCategory: 'UtilitiesApplication', operatingSystem: 'Windows 10 or later, macOS 13 or later',
    description: 'A desktop app and Chrome extension that keep your details encrypted on your computer and fill supported fields in Iowa’s SNAP application after you approve.',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
  },
  {
    '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: faq.map(({ question, answer }) => ({ '@type': 'Question', name: question, acceptedAnswer: { '@type': 'Answer', text: answer } })),
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
