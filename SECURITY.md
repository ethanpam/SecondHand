# Security policy

SecondHand holds some of the most sensitive details a person has: their Social Security number, income, household, and citizenship answers. We take reports seriously.

## Report a problem privately

Please don't open a public issue for a security problem. Use [GitHub's private vulnerability reporting](https://github.com/ethanpam/secondHand/security/advisories/new) when available. Reports are shared privately with the maintainers and advisory collaborators, rather than posted as public issues.

If the form is unavailable, do not post vulnerability details or applicant data publicly. Ask a maintainer to arrange a private reporting channel, without including the vulnerability itself. Maintainers must enable and verify private reporting when the repository becomes public; see the [release checklist](docs/public-release-review.md#repository-owner-actions).

Include what you found, how to reproduce it, and what an attacker could do with it. Use only the fictional test profile or made-up details, never real applicant data.

We aim to reply within a week and to tell you when a fix ships. We're happy to credit you in the release notes if you'd like.

## Supported versions

Only the latest release gets security fixes. Today that is **0.5.0**.

## What's in scope

- The desktop app's encrypted storage, password, recovery key, Touch ID, and backups
- The native messaging connection between the Chrome extension and the app
- The extension filling or reading anything it shouldn't, or running on a site it shouldn't
- The download website and its release publishing route
- Laya model downloads and updates

[The security design](docs/security.md) explains how each part is meant to work, and its known limits. For example, SecondHand can't protect against malware already running as the user, so reports that need that level of access are out of scope.
