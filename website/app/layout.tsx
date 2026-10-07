import type { Metadata } from 'next';
import '@fontsource/geist/latin-400.css';
import '@fontsource/geist/latin-500.css';
import '@fontsource/geist/latin-600.css';
import '@fontsource-variable/bricolage-grotesque';
import './globals.css';
import { siteUrl } from '../lib/site';
export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: 'SecondHand | Iowa SNAP helper for Windows and Mac',
    template: '%s | SecondHand',
  },
  description:
    'SecondHand keeps your details encrypted on your computer and fills supported fields in Iowa’s SNAP application after you approve.',
  icons: {
    icon: { url: '/brand/secondhand-icon.png', type: 'image/png' },
    apple: '/brand/secondhand-mascot.png',
  },
  openGraph: {
    type: 'website',
    siteName: 'SecondHand',
    locale: 'en_US',
    url: '/',
    title: 'SecondHand | Iowa SNAP helper for Windows and Mac',
    description:
      'Save your details once, encrypted on your computer, and fill supported fields in Iowa’s SNAP application after you approve.',
  },
  twitter: { card: 'summary_large_image' },
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
