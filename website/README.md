# secondHand download website

Public download site for the local-only secondHand desktop application. This site stores installers and a checksum list in R2. It has no applicant forms, account system, analytics, or applicant-data storage. Hosting infrastructure can process ordinary connection logs.

## Develop

Use Node24+, `npm ci`, then `npm run dev`. Validate using `npm test`, `npm run typecheck`, and `npm run build`. Sites provisions the FILES bucket declared in `.openai/hosting.json`.

## Pages

- `/`: downloads (opening on the visitor's platform), setup steps, privacy summary, and common questions, with `SoftwareApplication` and `FAQPage` structured data.
- `/thank-you/windows`, `/thank-you/mac-apple-silicon`, `/thank-you/mac-intel`: start the installer download with a meta refresh and list next steps. Not indexed.
- `/privacy`: the privacy policy. Update its date when the wording changes.
- A custom 404 page, `robots.txt`, `sitemap.xml`, and a share image (`app/opengraph-image.png`, generated from `scripts/og-image.html`).

The site URL used for canonical links, the sitemap, and share previews is in `app/site.ts`.

## Visual design

The website adapts the `GrainGradient` motion and texture from mxthxn’s [Shader Gradient Component](https://v0.app/templates/shader-gradient-component-cAawT1AJaki) to secondHand’s original green-and-white palette: forest green (`#164c38`), soft white (`#f8faf7`), and sage accents. It uses the pinned `@paper-design/shaders-react` package. Instrument Serif and Geist are self-hosted through Fontsource; the browser does not request fonts or scripts from third-party services.

The decorative hero shader loads after hydration, with a CSS gradient available before loading and when WebGL is unavailable. It respects reduced motion and has a pause/play control. Paper Shaders suspends rendering when the canvas is offscreen or the document is hidden; rendering is capped at 1.5 million pixels. The same color and typography tokens style the download, setup, privacy, FAQ, confirmation, and not-found pages.

For browser checks, install the root and website dependencies and Playwright Chromium (`npx playwright install chromium` from the root), then start the website with `npm run dev`. From the repository root, run `node scripts/smoke-website.cjs`. Set `SECONDHAND_WEBSITE_URL` if the preview uses a port other than 5173, or `SECONDHAND_BROWSER_CHANNEL=chrome` to use an installed Chrome. The smoke checks exercise shader motion and fallbacks, keyboard tabs, all download confirmation routes with synthetic installer responses, FAQ disclosure, privacy, 404s, and 320–1440px layouts. Screenshots are saved under `artifacts/website/`.

The social preview source is `scripts/og-image.html`. After changing it, render it at 1200×630 with the website dependencies installed and save the screenshot to `app/opengraph-image.png`.

Page navigation uses ordinary anchors. This static download site does not need client routing, and full document navigation reliably runs the confirmation page’s download redirect in production. The `nextjs/no-html-link-for-pages` lint override is limited to the four components that own these navigation links.

## Publish installers

1. Build the reviewed desktop source for Windows x64 and Mac arm64/x64. Run its unit, UI, and packaged native-bridge tests. Generate `secondHand-extension.zip` and `SHA256SUMS.txt` with the desktop release scripts.
2. Add the new version to `releases` and set `RELEASE` in `lib/downloads.ts`. Keep `LATEST_RELEASE` and the version displayed in `app/release.ts` on the previous release while uploading. Existing object keys cannot be overwritten.
3. Set a fresh random `RELEASE_UPLOAD_TOKEN` of at least32 characters as a Sites **secret**, deploy the reviewed website, and retain the credential locally only for this upload session.
4. Set the same token as an environment variable and run `node scripts/publish-downloads.mjs https://your-site.example /absolute/path/to/release`. For a private staging deployment, set `SITES_ACCESS_TOKEN` to the current Sites access bearer as well. The script uploads in8MiB parts then downloads each full file and verifies its SHA256 against the local artifact. Neither credential is sent to a redirect target or included in browser bundles.
5. After verifying every new file, update `LATEST_RELEASE` and the displayed version, rebuild, and **remove the upload secret before deploying that final version**. With no secret, all publishing routes return404. Make the completed download site public when authorized. Verify anonymous downloads and byte-range resume responses.

The website and publisher source are mirrored into `website/` in the requested GitHub repository. Sites has its own source checkout for publication. Do not commit build output, credentials, `.env` files, or installers. GitHub is private, so its release URLs must never be presented as public downloads.

## Release boundaries

Windows and Mac builds are unsigned early-access software; Mac builds are not Apple notarized. The page states this before download and links to Apple's official opening guidance. The application only fills verified supported Iowa fields; it does not submit applications or decide eligibility. CAPTCHA, consent, signatures, and submission stay with the applicant.

## Download implementation

The server only serves the fixed release filename allowlist and forces attachment downloads with `nosniff`. Files stream directly fromR2, including single byte-range requests for resumable downloads. The authenticated maintenance API only accepts allowlisted release names; it requires a constant-time hashed bearer comparison, bounded multipart sizes, sequential part manifests, and final byte-count verification. The publisher independently verifies the actual bytes. There is no public upload interface.
