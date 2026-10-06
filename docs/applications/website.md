# Website: visitor guide, architecture, and release operations

The SecondHand website explains the product, offers Windows/Mac downloads, and walks visitors through Chrome setup. It is a distribution website, not the desktop application running in a browser.

It has no applicant account system, profile editor, document-upload form, or applicant-data database. Hosting infrastructure can still process ordinary connection logs. Product privacy statements should distinguish local applicant processing from the infrastructure needed to serve a website and downloads.

This guide describes repository source at the baseline in the [guide index](README.md). It does not independently verify which commit is currently deployed or whether a particular R2 object has been uploaded.

## Contents

- [For a visitor](#for-a-visitor)
- [Pages and routes](#pages-and-routes)
- [Technology and runtime](#technology-and-runtime)
- [Design, accessibility, and motion](#design-accessibility-and-motion)
- [Run locally](#run-locally)
- [How downloads work](#how-downloads-work)
- [Publish a release: maintainer workflow](#publish-a-release-maintainer-workflow)
- [Troubleshooting](#troubleshooting)
- [Maintenance checklist](#maintenance-checklist)

## For a visitor

1. Open the homepage and review what the current release supports.
2. Choose Windows, Mac Apple silicon, or Mac Intel. The page initially selects a platform from the visitor's environment, but verify it yourself.
3. Review the unsigned/early-access notice and select the installer.
4. On the thank-you page, allow the ordinary file download to start. Use the direct download link if automatic download does not start.
5. Install the desktop app using the [Windows](windows-exe.md) or [Mac](macos-dmg.md) guide.
6. Create a password and save the recovery key in the app.
7. Follow the Chrome setup guide. Downloading the desktop app or extension ZIP is not equivalent to loading the extension in Chrome.

The homepage's autofill illustration uses fictional details and demonstrates behavior; it does not read the visitor's profile or complete an actual application. The website's download confirmations are not application-submission confirmations.

## Pages and routes

| Route | Purpose | Main source |
| --- | --- | --- |
| `/` | Product explanation, demo, platform downloads, privacy summary, and setup | [page.tsx](../../website/app/page.tsx), [home.tsx](../../website/app/home.tsx) |
| `/faq` | Common questions and matching FAQ structured data | [questions.ts](../../website/app/faq/questions.ts), [page.tsx](../../website/app/faq/page.tsx) |
| `/chrome-extension` | Illustrated guide to loading the prepared extension | [page.tsx](../../website/app/chrome-extension/page.tsx) |
| `/thank-you/windows` | Start Windows download and explain next steps | [platform page](../../website/app/thank-you/[platform]/page.tsx) |
| `/thank-you/mac-apple-silicon` | Start arm64 Mac download | Same platform page and release data |
| `/thank-you/mac-intel` | Start x64 Mac download | Same platform page and release data |
| `/privacy` | Public privacy policy | [page.tsx](../../website/app/privacy/page.tsx) |
| `/download/<file>` | Serve an allowed release file from R2 | [download route](../../website/app/download/[file]/route.ts) |
| `/api/publish/<file>` | Authenticated maintenance upload endpoint | [publish route](../../website/app/api/publish/[file]/route.ts) |

There are also a custom 404, robots, sitemap, and social preview image. The public canonical origin is centralized in [app/site.ts](../../website/app/site.ts). Thank-you pages are not intended for indexing.

## Technology and runtime

The website uses React and Vinext with the existing app-directory structure, then targets a Cloudflare Worker with an R2 bucket bound as `FILES`. The repository's `website/.openai/hosting.json` declares that bucket and project association; it does not declare a D1 database.

A request for a page reaches the website runtime and renders the corresponding content. A file request is delegated to the download helper, which validates the release/file combination and streams the object. Neither route needs an applicant vault or a running Electron app.

Source responsibilities:

| File or area | Responsibility |
| --- | --- |
| [package.json](../../website/package.json) | Runtime/development dependencies and commands |
| [app/layout.tsx](../../website/app/layout.tsx) | Shared document layout and metadata |
| [app/site-chrome.tsx](../../website/app/site-chrome.tsx) | Shared navigation/footer presentation |
| [app/release.ts](../../website/app/release.ts) | Advertised version and public download links |
| [lib/downloads.ts](../../website/lib/downloads.ts) | Allowed files, release selection, HTTP streaming, upload validation |
| [scripts/publish-downloads.mjs](../../website/scripts/publish-downloads.mjs) | Maintainer upload and round-trip byte verification |
| [app/globals.css](../../website/app/globals.css) | Visual system and responsive presentation |
| [app/autofill-demo.tsx](../../website/app/autofill-demo.tsx) | Fictional click-to-autofill illustration |
| [app/gradient-background.tsx](../../website/app/gradient-background.tsx) | Decorative shader and fallback |
| [app/text-type.tsx](../../website/app/text-type.tsx) | Animated demo heading |
| [app/variable-wordmark.tsx](../../website/app/variable-wordmark.tsx) | Responsive decorative footer wordmark |

Navigation uses ordinary anchors. Full-document navigation is intentional, especially so the thank-you page's download startup runs consistently. Do not replace it with client routing without checking production download behavior.

## Design, accessibility, and motion

The site uses forest green, soft white, sage accents, the green mascot, and self-hosted Bricolage Grotesque/Geist fonts. The browser does not need third-party font or script hosts for those assets.

The hero shader initializes after hydration, with a CSS fallback if WebGL is unavailable or lost. Reduced-motion settings should show stable content. Animations pause offscreen or while hidden; the shader has a 1.5-million-pixel cap. The typed heading and illustrative form retain meaningful static content without JavaScript.

Keep semantic labels, keyboard behavior, focus states, and narrow-screen layouts when editing animated components. The synthetic form illustration must remain clearly separate from actual applicant-data collection.

The social preview source is `website/scripts/og-image.html`; the stored preview image is rendered at 1200×630. Existing third-party design attribution/license material is retained in the website. See the [website design notes](../react-bits-design-research.md).

## Run locally

Use Node 24 as the documented development recommendation; the package declares its exact minimum engine. From `website/`:

```sh
npm ci
npm run dev
```

The development server normally uses port 5173; use the printed URL if it selects something else. Opening the UI locally does not imply the remote R2 release objects or upload secret are available in that environment.

Validate from `website/`:

```sh
npm test
npm run typecheck
npm run lint
npm run build
```

`npm run start` runs Wrangler against the generated `dist/server/wrangler.json` after a build; it is not the same command as the development server.

For browser smoke checks, install root dependencies and Playwright Chromium, start the website, then from the repository root run:

```sh
node scripts/smoke-website.cjs
```

Set `SECONDHAND_WEBSITE_URL` for a different preview URL or `SECONDHAND_BROWSER_CHANNEL=chrome` to use installed Chrome. The smoke harness uses synthetic installer responses for download routes; it tests navigation/interaction, not the bytes of published installers. It saves screenshots in ignored `artifacts/website/`.

The checks exercise 320–1440 px layouts, keyboard navigation, fallback/reduced motion, download confirmation routes, FAQ, privacy, and 404 behavior. The repository no longer supplies hosted CI; run the appropriate local checks and record their results.

## How downloads work

The current source declares release `0.4.0` in both the displayed release module and download helper. The helper also recognizes historical releases through its explicit list. Do not infer the package's source revision solely from its filename or displayed version.

Objects live under a release prefix such as:

```text
releases/0.4.0/secondHand-0.4.0-win-x64.exe
releases/0.4.0/secondHand-0.4.0-mac-arm64.dmg
releases/0.4.0/secondHand-0.4.0-mac-x64.dmg
releases/0.4.0/secondHand-extension.zip
releases/0.4.0/SHA256SUMS.txt
```

Only allowed filenames and recognized release combinations are served. The response sets attachment disposition, content length/type, `nosniff`, ETag, cache headers, and byte-range support. A stored checksum can be exposed as `X-Checksum-SHA256`.

Single byte ranges support resumed downloads. Unsatisfiable or malformed ranges produce 416; matching conditional requests can return 304. Unknown release/file combinations return 404. A recognized artifact whose bucket object is missing returns a temporary-unavailable 503 rather than an unrelated file.

The filename allowlist is not a general-purpose file server. User-controlled path text must never select arbitrary object keys or local files.

## Publish a release: maintainer workflow

Publishing is separate from merging website or desktop source. This section is a runbook, not a claim that a release has been performed.

### 1. Produce and validate artifacts

Build reviewed source on the appropriate Windows/Mac hosts. Run relevant unit, UI, OCR, and packaged native-host checks using synthetic data. Record the commit, architecture, build environment, and tested behavior.

From the root, the existing release helpers include:

```sh
npm run extension:zip
npm run release:checksums
```

Confirm the output set contains all expected installers, extension ZIP, and `SHA256SUMS.txt`. Do not reuse a version/object key for different bytes.

### 2. Prepare a staged website change

In `website/lib/downloads.ts`, add the new version to the recognized releases and set the upload target `RELEASE`. Keep `LATEST_RELEASE` and the visible `website/app/release.ts` version on the previous complete release during upload. This avoids offering a half-published set to visitors.

The existing source permits maintenance upload only with a fresh `RELEASE_UPLOAD_TOKEN` of at least 32 characters. Provision it as a hosting secret, not a committed `.env` value or browser-bundled configuration. Use the intended Sites source checkout/deployment rather than assuming a GitHub merge automatically publishes it.

### 3. Upload and verify

With the same token available only to the upload process, run from `website/`:

```sh
node scripts/publish-downloads.mjs https://your-site.example /absolute/path/to/release
```

Replace the placeholder URL with the intended site. A private staging deployment can additionally require `SITES_ACCESS_TOKEN`. Credentials must not be put into the command's URL, committed files, screenshots, or PR text.

The publisher sends 8 MiB multipart pieces, then downloads each completed object and compares its SHA-256 with the local artifact. The server limits files to 512 MiB, validates sequential part manifests and final byte count, and refuses overwriting existing release keys. The bearer comparison uses hashed constant-time comparison. These checks do not replace the publisher's verification of actual bytes.

### 4. Advertise only the complete release

After all artifacts verify, update `LATEST_RELEASE` and the displayed release/download links. Remove the upload secret before deploying that final version. Without the secret, publishing endpoints return 404. Confirm anonymous downloads, checksum agreement, direct fallback links, and range-resume behavior.

Keep the prior release available as intended by the allowlist. Do not publish private repository release URLs as public download links. The existing public distribution design uses the website and R2 objects.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Download never starts | Thank-you page direct link, browser download handling, route, and object availability |
| 404 | Exact filename, recognized release, and optional release query; publish endpoints also intentionally hide without a secret |
| 503 for a download | Allowlisted artifact missing from the deployed bucket |
| Correct page but old installer | `app/release.ts`, `LATEST_RELEASE`, object key, and verified artifact provenance |
| Resumed download fails | Single-range syntax, object size, ETag/If-Range handling |
| Local preview lacks downloads | Runtime bucket binding and staging data; UI preview alone does not upload artifacts |
| Publish request rejected | Secret presence/length, bearer token, allowed target, multipart ordering, size, existing key |
| Motion breaks on a device | Reduced-motion preference, WebGL fallback/context loss, hydration, visibility handling |
| Git merge did not change the live site | Confirm the actual deployment checkout and publishing process |

## Maintenance checklist

After changing a public capability statement, compare it with the specific shipped artifact. After changing setup screens, update `/chrome-extension` and the desktop guides together. Keep FAQs and their structured data sourced from the same list. Update the privacy-policy date when its wording changes. After changing download routes, run server tests and a real staged byte verification, not only a screenshot test.
