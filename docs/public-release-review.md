# Public-release review

Reviewed October 7, 2026, starting from `4657cca` on main. This record describes the checks performed and their limits; it is not a certification that all historical content or distributed binaries are safe to publish. Repository visibility remains private.

## Dependency changes

- Desktop tooling: updated `http-cache-semantics` from 4.2.0 to 4.3.0 and `source-map-js` from 1.2.1 to 1.2.2 within existing dependency ranges.
- Website tooling: scoped a `miniflare` override to `sharp` 0.35.5 because the installed Miniflare pins 0.35.4. The lockfile includes matching Sharp platform packages. Remove the override when the parent dependency adopts a patched release.

After these changes, npm audit reports:

| Dependency tree | Full audit | `--omit=dev` |
| --- | --- | --- |
| Root | 8 moderate affected dependency entries | 0 |
| Website | 6 high affected dependency entries | 6 high |

These counts include parent dependencies affected by a shared advisory, not eight and six independent flaws. Two underlying advisories remain without a published patched version at review time:

- [`sprintf-js` 1.1.3, GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c): reaches the root through the Electron build/download tooling and its logging dependencies. It is in the development dependency tree. Do not feed untrusted format strings to build-tool logging.
- [`braces` 3.0.3, GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm): reaches the website through `vinext` → `vite-plugin-commonjs` → `vite-plugin-dynamic-import` → `fast-glob` → `micromatch`. Deeply nested attacker-controlled patterns can exhaust the stack. The inspected plugin uses globbing during source transformation, but npm categorizes this chain as production dependencies. Do not describe the website production audit as clean or treat this inspection as proof of runtime unreachability. Build only reviewed source with trusted configuration.

Re-run both full and production audits before publishing. Review upstream fixes when available; replace the dependency chain if a suitable fix is unavailable. Do not use `npm audit fix --force` blindly: its proposed version changes can downgrade major tooling. These unresolved findings require a maintainer decision, not a silent audit suppression.

## Checks completed

- Root tests: 1,870 passed, 8 skipped, 0 failed; static check passed for 185 JavaScript files and extension permissions.
- Website: all 40 tests, TypeScript checking, lint, and production build passed.
- Gitleaks 8.30.1 scanned fetched Git history with `--all` and redacted output. Fourteen generic-key matches were reviewed as public extension keys, field identifiers, or synthetic test values; no confirmed credential was found.
- Exported issue/PR text and comments, plus logs from 193 retained Actions runs, were scanned without secret matches. Scanner results do not prove absence of private information.
- Inventoried 145 tracked PNG/JPEG/GIF/PDF/MP4 assets, representing 135 unique file hashes. Visually inspected contact sheets covering static images, all four unique rendered PDF fixtures, up to five frames per GIF, and MP4 samples at five-second intervals (49 video frames across four videos). Inspected samples showed synthetic fixtures, product UI, branding, and demos; no confirmed real applicant record was identified. PDF fixtures visibly carry synthetic-test labels. This was not OCR of every pixel, review of every animation frame, an audio review, or an audit of historical media blobs.
- Inventoried 104 unexpired Actions artifacts. Their binary contents were **not** audited; log scanning does not clear installer contents. Existing published downloads also need their own release-artifact review.

## Repository owner actions

1. **Verify a working private security channel.** GitHub private vulnerability reporting is a public-repository feature. At the visibility change, an owner/admin must enable it under Settings → Advanced Security → Private vulnerability reporting and verify the report form and maintainer notifications. See [GitHub's setup instructions](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository). The reviewing account has push access but not admin access; an API 404 did not establish the setting's state. No personal email was added to `SECURITY.md`.
2. **Resolve third-party permission records.** Follow [the notices](../THIRD_PARTY_NOTICES.md). Confirm the contributors can license their contributions under MIT. Preserve upstream terms; do not assume the root license relicenses copied material.
3. **Finish the publication-content review.** Review retained installer artifacts and downloads for unintended files; review historical media and video/audio beyond the sample coverage above. Resolve any questionable content before changing visibility. Removing a file from main alone does not remove it from Git history. Any deletion of retained artifacts or history rewriting should be separately planned and approved.
4. **Decide on the remaining dependency findings.** Record the maintainer's exposure assessment or land fixes before publishing; recheck advisories against the final lockfiles.
5. **Make the visibility decision explicitly.** Publishing exposes repository history and associated public surfaces, not just today's files. This PR does not change visibility, restore CI, or publish replacement installers.
