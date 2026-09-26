import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'Download secondHand — Iowa SNAP companion for Windows & Mac',
  description: 'Download secondHand for Windows or Mac. Keep your profile encrypted on your computer and use the included Chrome extension to fill supported Iowa SNAP fields.',
  icons: { icon: '/icon.svg' },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
