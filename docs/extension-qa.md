# Extension QA and recorded walkthrough

Run from the repository root after `npm ci` and `npx playwright install chromium`:

```sh
npm run check
npm test
npm run test:native
npm run test:extension
npm run test:extension:video
```

The video command writes a recording and `qa-report.json` to
`artifacts/extension-qa/<timestamp>/`. Artifacts are ignored by Git. The recording contains
only the fictional profile in `tests/fixtures/applicant-profile.json`.

The extension, background worker, content script, and Chrome native side panel
run in actual Chromium. Test documents are fulfilled locally at the expected
portal URL so the real origin checks are exercised. All other web requests are
blocked and DNS resolution is disabled. The native desktop responses in this
browser walkthrough are simulated; this is not a recording of the complete
desktop approval and native-host connection. `test:native` separately checks
the actual development native-host subprocess and authenticated local IPC with
synthetic messages.

The video shows these actions:

1. Click **Autofill** with missing first-name, applicant, and program answers.
2. Check that home and separate mailing addresses fill from the fictional profile.
3. Use the sidebar checklist to focus and complete the missing first name.
4. Manually answer Yes to applying and select SNAP, acting as the fictional applicant.
5. Verify that the extension continues exactly once after required answers are complete.
6. Observe the manual pause at a **hypothetical** address-confirmation page, then
   manually select the fictional address. Unsupported automation remains paused.

The recording places actual form and native-sidebar captures side by side.
An on-screen QA caption identifies the simulated portal and desktop connection.
It contains no audio and does not show a live Iowa filing. The JSON report
includes timed chapters, assertions, and the recording's scope.

The broader browser smoke additionally exercises the observed home-address
confirmation structure using `tests/fixtures/iowa-select-address.cjs`: it chooses
the first possible home match, advances exactly once, makes only an empty-field desktop authorization request at that step (no profile values), and pauses at an unsupported later page. Generated variants
cover prior selections, multiple suggestions, the original address chosen with
its county question shown, a county question that stays shown after the switch,
errors, visible dialogs, and unsupported mailing controls. The video flow above retains the
separate hypothetical address page to demonstrate the unverified-layout pause.

The browser smoke also exercises the sanitized primary-applicant **Tell Us More** fixture: it requests only `birthDate`, formats it as `MM/DD/YYYY`, preserves manual and hidden controls, and makes zero Next clicks. Changed person phase, form, or heading prevents profile release. The sidebar exposes static checklist labels without the applicant name, birth date, private navigation snapshot, or access receipt.

The browser smoke also checks conditional address/program branches,
preservation of existing answers, potentially destructive parent choices,
full-document navigation and extension reinjection, consent pauses, per-page
verified applicant/address Save and Continue, lock/access-revision changes, and that sidebar messages omit profile values and private navigation tokens.

The applicant fixture uses sanitized metadata from the observed blank Iowa
form. The new home-address fixture reconstructs observed controls with a public
campus test address. The birth-date fixture reproduces observed self-page metadata with explicitly synthetic placeholders for unmapped questions. Multiple-address variants and unsupported-page fixtures are synthetic. Browser requests never reach Iowa. These tests do not establish live
end-to-end filing, and passing them does not mean the extension can complete an
entire SNAP application.

The separately authorized [live journey](iowa-live-journey.md) was operated manually through E-Signature and stopped with all signature controls untouched. It is not part of the isolated extension smoke or the earlier video, and it does not establish automated end-to-end filing.

Earlier published isolated walkthroughs show the former **Start guided autofill** controls and session protocol. Those videos are historical evidence of that build; current scripts use **Autofill** / **Stop**, per-request native authorization, and `accessRevision` checks. They do not retroactively establish live portal behavior.

## Recording the real desktop connection

A live walkthrough uses the running desktop app, its registered native host,
and the installed Chrome extension. Enter only the agreed fictional profile in
an isolated demo vault. The operator completes CAPTCHA and consent. Ordinary
Save and Continue can send and save draft answers before final submission;
stop before signing or submitting. On a Mac, label the footage as a macOS
desktop run rather than a Windows executable test.

For an existing recording, this macOS helper preserves the original, removes
audio, and converts an explicitly selected range to H.264 MP4:

```sh
node scripts/record-live-demo.cjs --source /path/to/recording.mov \
  --output artifacts/live-demo/clip.mp4 --start 60 --duration 120
```

It requires macOS `avconvert` and Swift Command Line Tools. It does not capture
the screen or upload files. Review the finished clip and crop unrelated windows
with a video editor before sharing. Keep manual actions and pauses visible, and
describe any cuts or speed changes; the recording is evidence only of the steps
it actually shows.

## Screenshots of every surface

`npm run capture:ui -- <label>` loads the extension in the same isolated Chromium and saves each state of
the card and the side panel as `docs/pr-media/<shot>-<label>.png`: ready, working, filled, hidden to its
logo, locked, the app closed, another website, sensitive details held for Fill sensitive details, Laya's
guesses, Spanish, Arabic, and an outdated build. Run it with `before` on main and `after` on a
branch to compare them in a pull request. Shot names after the label limit the run to those shots; a name
that ends in a hyphen takes every shot that starts with it, as in `npm run capture:ui -- after card- panel-iowa`.

The side panel is captured at Chrome's own 360 by 765 pixels and the card as a 330 by 190 corner of the
page, both at twice that size. `card-autofill` is a short recording and needs `ffmpeg` on the PATH. Every
run fails if the extension logged an error in any of its pages or its worker.
