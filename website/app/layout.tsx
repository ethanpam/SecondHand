import type { Metadata } from 'next';
import '@fontsource/geist/latin-400.css';
import '@fontsource/geist/latin-500.css';
import '@fontsource/geist/latin-600.css';
import '@fontsource/instrument-serif/latin-400.css';
import './globals.css';
import { siteUrl } from './site';
export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: 'secondHand | Iowa SNAP helper for Windows and Mac',
    template: '%s | secondHand',
  },
  description:
    'secondHand keeps your details encrypted on your computer and fills supported fields in Iowa’s SNAP application after you approve.',
  icons: { icon: '/icon.svg' },
  openGraph: {
    type: 'website',
    siteName: 'secondHand',
    locale: 'en_US',
    url: '/',
    title: 'secondHand | Iowa SNAP helper for Windows and Mac',
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
