import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './support/app-modules.ts';
import { handlers, pages } from './support/pages.ts';
import { siteUrl } from '../lib/site.ts';

// Loaded after the hooks above, which resolve their extensionless imports.
const { default: robots } = await import('../app/robots.ts');
const { default: sitemap } = await import('../app/sitemap.ts');

const rules = robots().rules;
const rule = Array.isArray(rules) ? rules : [rules];
const disallowed = rule.flatMap(({ disallow = [] }) =>
  Array.isArray(disallow) ? disallow : [disallow],
);
const blocked = (path: string) =>
  disallowed.some((prefix) => path.startsWith(prefix));
const entries = sitemap();
const listed = entries.map(({ url }) => new URL(url).pathname);
const source = (file: URL) => readFileSync(file, 'utf8');

void test('robots.txt lets every crawler in and names the sitemap', () => {
  assert.deepEqual(rule, [
    { userAgent: '*', allow: '/', disallow: ['/api/', '/download/'] },
  ]);
  assert.equal(robots().sitemap, `${siteUrl}/sitemap.xml`);
});

void test('robots.txt keeps crawlers out of every route handler', () => {
  assert.ok(handlers.length > 0);
  for (const { path } of handlers)
    assert.ok(blocked(`${path}/`), `${path} must be disallowed`);
});

void test('the sitemap lists every page that can be indexed, once, on the https site address', () => {
  assert.match(siteUrl, /^https:\/\/[^/]+$/);
  for (const { url } of entries) assert.ok(url.startsWith(`${siteUrl}/`), url);
  assert.equal(new Set(listed).size, listed.length, 'No page is listed twice');
  const indexable = pages
    .filter(({ dynamic }) => !dynamic)
    .map(({ path }) => path);
  assert.deepEqual([...listed].sort(), indexable.sort());
  assert.ok(listed.includes('/chrome-extension'));
  for (const path of listed)
    assert.equal(blocked(path), false, `${path} must not be disallowed`);
});

void test('sitemap entries have real dates and priorities', () => {
  for (const { url, lastModified, priority } of entries) {
    assert.ok(
      lastModified instanceof Date && !Number.isNaN(lastModified.getTime()),
      url,
    );
    assert.ok(
      typeof priority === 'number' && priority > 0 && priority <= 1,
      url,
    );
  }
});

void test('each listed page names its own address as canonical', () => {
  for (const { file, path } of pages.filter(({ dynamic }) => !dynamic)) {
    const canonical = /alternates:\s*\{\s*canonical:\s*'([^']+)'/.exec(
      source(file),
    );
    assert.equal(canonical?.[1], path, `${path} canonical`);
  }
});

void test('pages left out of the sitemap ask not to be indexed', () => {
  const unlisted = [
    ...pages.filter(({ dynamic }) => dynamic).map(({ file }) => file),
    new URL('../app/not-found.tsx', import.meta.url),
  ];
  for (const file of unlisted)
    assert.match(source(file), /robots:\s*\{\s*index:\s*false/, file.pathname);
});
