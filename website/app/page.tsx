import type { Metadata } from 'next';
import { Home } from './home';

export const metadata: Metadata = {
  title: { absolute: 'Download secondHand | Iowa SNAP helper for Windows and Mac' },
  description: 'Download secondHand for Windows or Mac. Keep your details encrypted on your computer and use the included Chrome extension to fill supported fields in Iowa’s SNAP application.',
  alternates: { canonical: '/' },
};

export default function Page() {
  return <Home />;
}
