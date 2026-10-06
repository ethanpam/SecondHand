// Finds the site's pages and route handlers from the app directory, the way
// vinext maps files to URLs, so new pages are covered without editing tests.
import { readdirSync } from 'node:fs';

export const app = new URL('../../app/', import.meta.url);

function files(name: string, directory = app): URL[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory())
      return files(name, new URL(`${entry.name}/`, directory));
    return entry.name === name ? [new URL(entry.name, directory)] : [];
  });
}

const route = (file: URL) =>
  `/${decodeURIComponent(file.href.slice(app.href.length)).split('/').slice(0, -1).join('/')}`;

export const pages = files('page.tsx').map((file) => ({
  file,
  path: route(file),
  dynamic: route(file).includes('['),
}));

export const handlers = files('route.ts').map((file) => ({
  file,
  path: route(file),
}));
