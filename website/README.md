# SecondHand download website

For an end-to-end user and engineering walkthrough, see the [detailed website guide](../docs/applications/website.md).

Public download site for the local-only SecondHand desktop application. This site stores installers and a checksum list in R2. It has no applicant forms, account system, analytics, or applicant-data storage. Hosting infrastructure can process ordinary connection logs.

## Develop

Use Node24+, `npm ci`, then `npm run dev`. Validate using `npm test`, `npm run typecheck`, and `npm run build`.

## Hosting

The site runs on a Cloudflare Worker named `secondhand`, with the installers in an R2 bucket named `secondhand-downloads` bound as `FILES`. Both names, and Cloudflare's per-request logging turned off, are set in `vite.config.ts`. Both fit Cloudflare's free tier, and R2 charges nothing for downloads.

To deploy, log in once with `npx wrangler login`, then run `npm run deploy`. It builds the site and publishes it with `wrangler deploy`. A merge to GitHub doesn't deploy anything by itself. The first time on a new Cloudflare account, create the bucket with `npx wrangler r2 bucket create secondhand-downloads`.

## Pages

- `/`: the hero, autofill demo, what SecondHand does today, and links to downloads, setup, and common questions, with `SoftwareApplication` structured data. Homepage components live in `app/_home/`.
- `/downloads`: platform downloads (opening on the visitor's platform), requirements, privacy promises, and early-access notes, in `app/downloads/`.
- `/setup`: installation, passwords, Chrome extension setup, and update instructions, in `app/setup/`.
- `/faq`: the common questions, from `app/faq/questions.ts`, with `FAQPage` structured data built from the same list.
- `/chrome-extension`: the picture guide to adding the extension to Chrome.
- `/thank-you/windows`, `/thank-you/mac-apple-silicon`, `/thank-you/mac-intel`: start the installer download once the page loads (with a direct link as a fallback) and list next steps. Not indexed.
- `/privacy`: the privacy policy. Update its date when the wording changes.
- A custom 404 page, `robots.txt`, `sitemap.xml`, and a share image (`app/opengraph-image.png`, generated from `scripts/og-image.html`).

The site URL used for canonical links, the sitemap, and share previews is in `lib/site.ts`.

## Source organization

Page folders own their route and page-specific components. `app/_home/` holds the homepage, `app/_components/` holds shared branding, navigation, icons, and the footer, and `lib/` holds site configuration, release links, download handling, and shared motion hooks. Download checksums are linked from the Downloads page.

## Visual design

The website keeps SecondHand’s original forest green (`#164c38`), soft white (`#f8faf7`), and sage accents in an open, type-led design. Bricolage Grotesque variable headings and Geist body text are self-hosted through Fontsource. The hero is card-free, with a full-width animated green background. The homepage adapts [React Bits Variable Proximity](https://reactbits.dev/text-animations/variable-proximity) into a responsive footer wordmark. A green bear mascot appears in the shared branding and favicon; its generation brief is in [the mascot note](../docs/secondhand-mascot.md). Source references, accessibility adaptations, and design decisions are in [the research note](../docs/react-bits-design-research.md); the upstream license is preserved in [the third-party notice](public/react-bits-license.txt). The browser does not request third-party fonts or scripts.

The hero sits on the page’s own flat color, with no gradient or shader. The demo section under the hero adapts [React Bits Text Type](https://reactbits.dev/text-animations/text-type) for “Ready for less typing?” alongside a click-to-autofill illustration with fictional details. Animations play without controls and hold still when the visitor’s device asks for reduced motion. The heading and illustration suspend offscreen or while hidden and show complete static content without JavaScript. The same tokens style downloads, numbered setup rows, the FAQ page, confirmations, and the 404 page.

For browser checks, install the root and website dependencies and Playwright Chromium (`npx playwright install chromium` from the root), then start the website with `npm run dev`. From the repository root, run `node scripts/smoke-website.cjs`. Set `SECONDHAND_WEBSITE_URL` if the preview uses a port other than 5173, or `SECONDHAND_BROWSER_CHANNEL=chrome` to use an installed Chrome. The smoke checks exercise a flat hero with no gradient, the page without WebGL, reduced motion, proximity wordmark behavior, typed heading layout and accessibility, click-to-autofill sequencing, the absence of motion buttons, card removal, consistent branding and mascot loading, keyboard tabs, all download confirmation routes with synthetic installer responses, FAQ disclosure, privacy, 404s, and 320–1440px layouts. Screenshots are saved under `artifacts/website/`.

The social preview source is `scripts/og-image.html`. After changing it, render it at 1200×630 with the website dependencies installed and save the screenshot to `app/opengraph-image.png`.

Page navigation uses ordinary anchors. This static download site does not need client routing, and full document navigation reliably runs the confirmation page’s download redirect in production. The `nextjs/no-html-link-for-pages` lint override is limited to the components that own these navigation links.

## Publish installers

The simplest way to upload a release is straight to R2 with Wrangler, which needs no upload secret. From `website/`, for each file in the release folder:

```sh
npx wrangler r2 object put secondhand-downloads/releases/0.6.0/secondHand-0.6.0-win-x64.exe --file /absolute/path/to/release/secondHand-0.6.0-win-x64.exe --remote
```

Then download each file back from the live site, check it against `SHA256SUMS.txt`, and only then update `LATEST_RELEASE` and the displayed version and deploy. The steps below use the site's own publish route instead, which also verifies every byte.

1. Build the reviewed desktop source for Windows x64 and Mac arm64/x64. Run its unit, UI, and packaged native-bridge tests. Generate `secondHand-extension.zip` and `SHA256SUMS.txt` with the desktop release scripts.
2. Add the new version to `releases` and set `RELEASE` in `lib/downloads.ts`. Keep `LATEST_RELEASE` and the version displayed in `lib/release.ts` on the previous release while uploading. Existing object keys cannot be overwritten.
3. Set a fresh random `RELEASE_UPLOAD_TOKEN` of at least32 characters as a Worker secret (`npx wrangler secret put RELEASE_UPLOAD_TOKEN`), deploy the reviewed website, and retain the credential locally only for this upload session.
4. Set the same token as an environment variable and run `node scripts/publish-downloads.mjs https://your-site.example /absolute/path/to/release`. The script uploads in8MiB parts then downloads each full file and verifies its SHA256 against the local artifact. Neither credential is sent to a redirect target or included in browser bundles.
5. After verifying every new file, update `LATEST_RELEASE` and the displayed version, rebuild, and **remove the upload secret before deploying that final version**. With no secret, all publishing routes return404. Make the completed download site public when authorized. Verify anonymous downloads and byte-range resume responses.

Do not commit build output, credentials, `.env` files, or installers.

## Release boundaries

Windows and Mac builds are unsigned early-access software; Mac builds are not Apple notarized. The page states this before download and links to Apple's official opening guidance. The application only fills verified supported Iowa fields; it does not submit applications or decide eligibility. CAPTCHA, consent, signatures, and submission stay with the applicant.

## Download implementation

The server only serves the fixed release filename allowlist and forces attachment downloads with `nosniff`. Files stream directly fromR2, including single byte-range requests for resumable downloads. The authenticated maintenance API only accepts allowlisted release names; it requires a constant-time hashed bearer comparison, bounded multipart sizes, sequential part manifests, and final byte-count verification. The publisher independently verifies the actual bytes. There is no public upload interface.
