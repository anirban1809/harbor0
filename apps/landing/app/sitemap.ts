import type { MetadataRoute } from 'next';
import { features } from './features';

export const dynamic = 'force-static';

export const siteUrl = 'https://harbor0.com';

// Every page the static export writes, for search engines.
export default function sitemap(): MetadataRoute.Sitemap {
  const paths = ['', ...features.map(({ id }) => `/${id}`), '/apps', '/privacy', '/terms'];
  return paths.map((path) => ({ url: `${siteUrl}${path}` }));
}
