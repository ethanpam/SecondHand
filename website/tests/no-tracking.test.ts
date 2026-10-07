import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { app, pages } from './support/pages.ts';
import { siteUrl } from '../lib/site.ts';

// Every page is built only from the site's own files: no analytics, no tracking
// and nothing loaded from another site. This reads each page's own code and
// everything it imports; the browser smoke checks the same pages while running.
const root = new URL('../', import.meta.url);
const manifest = JSON.parse(
  readFileSync(new URL('package.json', root), 'utf8'),
);

const trackerPackages = [
  '@vercel/analytics',
  '@vercel/speed-insights',
  '@next/third-parties',
  'next/script',
  'react-ga',
  'react-ga4',
  'react-gtm-module',
  'analytics',
  '@analytics/',
  'posthog-js',
  'mixpanel-browser',
  '@segment/',
  '@amplitude/',
  'amplitude-js',
  '@hotjar/',
  'react-hotjar',
  'plausible-tracker',
  'next-plausible',
  'fathom-client',
  '@sentry/',
  '@datadog/',
  'logrocket',
  '@fullstory/',
  '@microsoft/clarity',
];
const isTracker = (name: string) =>
  trackerPackages.some(
    (tracker) =>
      name === tracker || (tracker.endsWith('/') && name.startsWith(tracker)),
  );
const trackingCode = [
  /\bsendBeacon\b/,
  /document\.cookie/,
  /\bcookieStore\b/,
  /\bping=/,
  /gtag|dataLayer|googletagmanager|google-analytics|cloudflareinsights|fbq\(|_paq\b/,
];
// Addresses a page may contain without loading anything: the site's own
// address and the structured-data vocabulary name.
const ownAddresses = [siteUrl, 'https://schema.org'];
const imports =
  /\b(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)|@import\s+(?:url\()?['"]([^'"]+)['"]/g;
const addresses = /(?:https?:)?\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s'"`)<>]*/gi;

function ownFile(specifier: string, from: URL) {
  const base = specifier.startsWith('@/')
    ? new URL(specifier.slice(2), root)
    : /^\.\.?\//.test(specifier)
      ? new URL(specifier, from)
      : null;
  if (!base) return null;
  const file = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']
    .map((suffix) => new URL(`${base.href}${suffix}`))
    .find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
  if (!file)
    throw new Error(`Cannot find ${specifier} imported by ${from.pathname}`);
  return file;
}

// The page, the layouts around it, and every site file they import.
function pageCode(page: URL) {
  const layouts = [];
  for (
    let directory = new URL('./', page);
    directory.href.startsWith(app.href);
    directory = new URL('../', directory)
  ) {
    const layout = new URL('layout.tsx', directory);
    if (existsSync(layout)) layouts.push(layout);
  }
  const files = new Map<string, string>();
  const packages = new Set<string>();
  const queue = [page, ...layouts];
  for (let file = queue.pop(); file; file = queue.pop()) {
    if (files.has(file.href) || !/\.(tsx?|css)$/.test(file.pathname)) continue;
    const code = readFileSync(file, 'utf8');
    files.set(file.href, code);
    for (const [, ...found] of code.matchAll(imports)) {
      const specifier = found.find(Boolean) as string;
      const next = ownFile(specifier, file);
      if (next) queue.push(next);
      else packages.add(specifier);
    }
  }
  return { files, packages };
}

// A link the visitor follows is navigation, not a request the page makes.
const isLinkHref = (code: string, index: number) =>
  /<a\b[^<>]*\bhref=\{?\s*["'`]$/.test(
    code.slice(Math.max(0, index - 300), index),
  );

const everyPage = [
  ...pages.map(({ file, path }) => ({ file, path })),
  { file: new URL('not-found.tsx', app), path: '404' },
];

void test('every page is checked, including the Chrome extension guide', () => {
  const paths = everyPage.map(({ path }) => path);
  for (const path of [
    '/',
    '/chrome-extension',
    '/faq',
    '/privacy',
    '/thank-you/[platform]',
    '404',
  ])
    assert.ok(paths.includes(path), path);
});

void test('the site depends on no analytics or tracking package', () => {
  assert.deepEqual(Object.keys(manifest.dependencies).filter(isTracker), []);
});

for (const { file, path } of everyPage) {
  void test(`${path} loads nothing from other sites and runs no tracking code`, () => {
    const { files, packages } = pageCode(file);
    assert.ok(files.size > 1, `${path} and its layout were read`);
    assert.deepEqual(
      [...packages].filter(isTracker),
      [],
      `${path} imports a tracker`,
    );
    for (const [href, code] of files) {
      const name = href.slice(root.href.length);
      for (const pattern of trackingCode)
        assert.doesNotMatch(
          code,
          pattern,
          `${name} (used by ${path}) has tracking code`,
        );
      for (const match of code.matchAll(addresses)) {
        const [address] = match;
        if (
          ownAddresses.some(
            (own) => address === own || address.startsWith(`${own}/`),
          )
        )
          continue;
        assert.ok(
          isLinkHref(code, match.index),
          `${name} (used by ${path}) loads ${address}`,
        );
      }
    }
  });
}
