import type { MetadataRoute } from 'next';
import { siteUrl } from '../lib/site';

// Installer files and the publishing API are not pages. Thank-you pages stay
// crawlable so search engines can read their noindex tag.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/', disallow: ['/api/', '/download/'] },
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
