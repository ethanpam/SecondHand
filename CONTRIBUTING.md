# Contributing to SecondHand

Thank you for helping. SecondHand serves people applying for food and other assistance, so the most important rule comes first.

## Never use real applicant data

Don't put a real person's name, address, Social Security number, income, or any other personal detail in an issue, a pull request, a test, a screenshot, or a commit. Use the fictional applicant in [`tests/fixtures/applicant-profile.json`](tests/fixtures/applicant-profile.json) (Daniel Ceaser) or make up obviously fake details. When you share a form that doesn't fill, save a copy with the answers removed, or describe the question labels instead.

## Ways to help

- **Report a form that doesn't fill.** Open an issue with the website's address, the question's label, and what happened. No personal details.
- **Improve a translation.** The side panel speaks six languages; native speakers can catch wording that reads oddly.
- **Map a new form or fix a rule.** See [How a new form gets supported](README.md#how-a-new-form-gets-supported) and the [application guides](docs/applications/README.md).
- **Improve the docs.** If a step in the [setup guide](docs/setup.md) confused you, it will confuse someone else.
- **Pick up a roadmap item.** The [roadmap](README.md#roadmap) lists what's planned.

Security problems go through [SECURITY.md](SECURITY.md), not a public issue.

## Set up

You need Node.js 22.12 or newer (24 recommended) and npm.

```sh
npm ci
npm run check
npm test
npm run dev
```

`npm run dev` opens the desktop app and a separate Chromium with the extension loaded, and reloads on edits. The [README's developer section](README.md#for-developers) lists every command. The website has its own setup in [`website/README.md`](website/README.md).

## Before you open a pull request

1. **Test first where you can.** Add or update a test in `tests/` that fails without your change.
2. **Run the checks.** `npm test` and `npm run check` always. If you touched the desktop app, the extension, OCR, or Laya, also run the matching smoke test (`npm run test:ui`, `test:extension`, `test:ocr`, `test:laya`). For `website/`, run `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build` there.
3. **Bump the extension's `BUILD`** in `extension/background.js` and `extension/panel.js` when you change anything in `extension/`. `npm run check` tells you if you forgot.
4. **One change per commit**, with a conventional title such as `fix:`, `feat:`, `docs:`, `test:`, `refactor:`, or `chore:`.
5. **Show what changed on screen.** If your change is visible, put before and after screenshots in the pull request.

## Product rules the code keeps

- **Applicant data stays on the computer.** No server, no analytics, no tracking, and no third-party scripts or fonts. Chrome's extension storage never holds applicant details.
- **The person stays in charge.** SecondHand asks before sharing, never touches CAPTCHA, consent, signatures, or final submission, and never changes an answer already on the page.
- **AI is optional.** The rules must work with Laya turned off, and anything Laya fills is marked as a guess.
- **Plain words.** Write for someone reading in their second language on a phone: short sentences, "password" rather than jargon, no buzzwords.

The full list is in the [implementation contract](docs/implementation-contract.md).

## Code of conduct

Everyone taking part agrees to the [code of conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions are released under the [MIT License](LICENSE).
