import type { MetadataRoute } from 'next';
import { siteUrl } from './site';

export default function sitemap(): MetadataRoute.Sitemap {
  const updated = new Date('2026-09-26');
  return [
    { url: `${siteUrl}/`, lastModified: updated, changeFrequency: 'monthly', priority: 1 },
    { url: `${siteUrl}/privacy`, lastModified: updated, changeFrequency: 'yearly', priority: 0.5 },
  ];
}
