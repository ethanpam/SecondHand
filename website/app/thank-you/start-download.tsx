'use client';

import { useEffect } from 'react';

// Starts the installer download once the page has loaded. The file is sent as
// an attachment, so the page stays open. This replaces a timed meta refresh,
// which assistive technology can't control; without JavaScript the page's
// direct link still works.
export function StartDownload({ href }: { href: string }) {
  useEffect(() => { window.location.assign(href); }, [href]);
  return null;
}
