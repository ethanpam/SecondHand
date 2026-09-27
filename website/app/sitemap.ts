import type { MetadataRoute } from 'next';
import { siteUrl } from './site';

export default function sitemap(): MetadataRoute.Sitemap {
  const updated = new Date('2026-09-26');
  return [
    { url: `${siteUrl}/`, lastModified: updated, changeFrequency: 'monthly', priority: 1 },
    { url: `${siteUrl}/chrome-extension`, lastModified: new Date('2026-09-27'), changeFrequency: 'monthly', priority: 0.7 },
    { url: `${siteUrl}/faq`, lastModified: new Date('2026-09-27'), changeFrequency: 'monthly', priority: 0.6 },
    { url: `${siteUrl}/privacy`, lastModified: updated, changeFrequency: 'yearly', priority: 0.5 },
  ];
}
