import type { Metadata } from 'next';
import './globals.css';
import { siteUrl } from './site';
export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: 'secondHand | Iowa SNAP helper for Windows and Mac', template: '%s | secondHand' },
  description: 'secondHand keeps your details encrypted on your computer and fills supported fields in Iowa’s SNAP application after you approve.',
  icons: { icon: '/icon.svg' },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
