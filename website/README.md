# secondHand download website

Public download site for the local-only secondHand desktop application. This site stores installers and a checksum list in R2. It has no applicant forms, account system, analytics, or applicant-data storage. Hosting infrastructure can process ordinary connection logs.

## Develop

Use Node24+, `npm ci`, then `npm run dev`. Validate using `npm test`, `npm run typecheck`, and `npm run build`. Sites provisions the FILES bucket declared in `.openai/hosting.json`.

## Publish installers

1. Build the reviewed desktop source for Windows x64 and Mac arm64/x64. Run its unit, UI, and packaged native-bridge tests. Generate `secondHand-extension.zip` and `SHA256SUMS.txt` with the desktop release scripts.
2. Update `RELEASE` and its exact filename allowlist in `lib/downloads.ts` and the version displayed in `app/page.tsx` for a new release. Existing object keys cannot be overwritten.
3. Set a fresh random `RELEASE_UPLOAD_TOKEN` of at least32 characters as a Sites **secret**, deploy the reviewed website, and retain the credential locally only for this upload session.
4. Set the same token as an environment variable and run `node scripts/publish-downloads.mjs https://your-site.example /absolute/path/to/release`. For a private staging deployment, set `SITES_ACCESS_TOKEN` to the current Sites access bearer as well. The script uploads in8MiB parts then downloads each full file and verifies its SHA256 against the local artifact. Neither credential is sent to a redirect target or included in browser bundles.
5. **Remove the upload secret and redeploy the same version** after verifying every file. With no secret, all publishing routes return404. Make the completed download site public when authorized. Verify anonymous downloads and byte-range resume responses.

The website and publisher source are mirrored into `website/` in the requested GitHub repository. Sites has its own source checkout for publication. Do not commit build output, credentials, `.env` files, or installers. GitHub is private, so its release URLs must never be presented as public downloads.

## Release boundaries

Windows and Mac builds are unsigned early-access software; Mac builds are not Apple notarized. The page states this before download and links to Apple's official opening guidance. The application only fills verified supported Iowa fields; it does not submit applications or decide eligibility. CAPTCHA, consent, signatures, and submission stay with the applicant.

## Download implementation

The server only serves the fixed release filename allowlist and forces attachment downloads with `nosniff`. Files stream directly fromR2, including single byte-range requests for resumable downloads. The authenticated maintenance API only accepts allowlisted release names; it requires a constant-time hashed bearer comparison, bounded multipart sizes, sequential part manifests, and final byte-count verification. The publisher independently verifies the actual bytes. There is no public upload interface.
