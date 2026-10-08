import type { Metadata } from 'next';
import { SiteFooter, SiteHeader } from '../_components/site-chrome';
import { DownloadOptions } from './download-options';

export const metadata: Metadata = {
  title: 'Download SecondHand for Windows and Mac',
  description:
    'Download the free SecondHand desktop app for Windows or Mac, with the Chrome extension included. Review requirements and early-access notes before installing.',
  alternates: { canonical: '/downloads' },
};

export default function Downloads() {
  return (
    <>
      <SiteHeader />
      <main id="main" className="wrap downloads-page">
        <DownloadOptions />
      </main>
      <SiteFooter />
    </>
  );
}
