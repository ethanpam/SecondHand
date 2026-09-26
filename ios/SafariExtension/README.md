# Safari guided application assistant

The iOS extension now supports a user-started application session, explicit field mapping, approved page continuation, and separately approved submission. It uses the laptop implementation's inspected applicant-field schema. **It has not completed a live Iowa application or authenticated renewal.** See the [full pipeline](../docs/Application-assistant.md) and [validation record](../docs/Validation.md).

## User flow

1. In SecondHand, review the profile and allow application sharing for ten minutes.
2. Open an Iowa application in Safari, handle login and initial consent/verification, then start assistance from the extension. Grant Iowa website access when asked.
3. Known applicant fields fill automatically. Other eligible fields require a user-selected match to a saved answer; these mappings last only for the current page.
4. Review the page, complete missing answers, and explicitly Continue. Pause and Stop can interrupt filling. A paused session requires Resume.
5. Complete the signature on Iowa's website. On a recognizable E-Signature page, check the extension's authorization box and choose **Approve and submit application**. Unknown signing or submission pages stay manual.
6. Check Iowa's result. On a recognized confirmation page, enter the number and confirm that the website reports submission. Unlock the app to import the receipt. Otherwise record it manually in the app.

## Data and permissions

`activeTab`, `scripting`, `nativeMessaging`, and `storage` support the workflow. Optional host access to `https://hhsservices.iowa.gov/*` is requested only when the user starts assistance. All runtime operations additionally require the exact HTTPS origin and a clean `/apspssp/ssp.portal/applyForBenefits/` route. Query strings, fragments, account routes, subframes, and external form targets are unsupported. There are no network fetches, cookie access, external message endpoints, backend, or cloud synchronization.

The native app shares only first/middle/last name, email, explicit home/mobile phone numbers, home address, monthly income, and monthly housing cost after explicit authorization. The extension requests only fields selected for the current operation. Generic phone, household members, documents, notes, SSNs, birth dates, passwords, signatures, and consent are never supplied.

The worker persists only tab ID, expiration, phase, page count, and filled count. Answers, page URLs, field labels, mappings, snapshots, and approval tokens are not written to extension storage or logs. The isolated page script keeps its private review snapshot in memory. JavaScript does not guarantee immediate memory zeroization.

## Native protocol

All messages are sent to `browser.runtime.sendNativeMessage("com.ethanpam.secondhand", message)` from extension-owned code. There is no webpage-to-native bridge.

- `{action: "applicationFields", pageURL, keys}` returns `{fields, expiresAt}` for requested allowlisted keys when the encrypted sharing session is valid.
- `{action: "recordReceipt", pageURL, confirmationNumber, receiptID}` requires an active session, a UUID, and a 3–80 character alphanumeric/space/hyphen confirmation. It writes a separate encrypted pending receipt and returns `{recorded: true}`. This is a user report, not agency verification.
- The older `contactFields` action remains restricted to the original applicant page and original contact subset.

Errors are fixed identifiers and never contain saved values, local paths, or underlying native diagnostics. Pending receipts are imported idempotently; they do not race writes to the app's profile vault or downgrade more advanced progress.

## Page operations

Known fields require the inspected form, ID, name, type, labels, and recipient context. First/middle/last name and home/mobile phone mappings come from the [public inspection](../../docs/iowa-portal.md). Home address must remain in `#personalInformation #homeAddrDiv`; the user answers the home-address question before those controls can be filled. Phones must be ten digits or a US country-code variant; ZIP codes must contain five digits.

Unknown labeled text/select fields have no automatic mapping. The user explicitly chooses a saved field. Unsupported, hidden, read-only, disabled, ambiguous, other-person, signature, verification, or sensitive controls remain manual. Existing answers are preserved. Scrolling is allowed only to reveal an already-rendered selected control, followed by another visibility and context check.

Each preview lasts at most two minutes and is consumed on use, including failures. Popup requests echo the exact displayed preview token. Page operations recheck document identity, URL, session expiration, field identity, and current page content. Changes to review answers, attestation prose, or form targets invalidate approval. Stop/Pause cancels pending writes and actions.

Continue is always an explicit user action and runs the website's normal validation. On the known applicant page, the bundle directly reuses `extension/iowa-adapter.js` for the verified button/form schema, required labels, and conditional radio/program questions. Other pages also check visible required labels and question groups before continuing. The final action requires a recognized signing heading, one form-associated **Submit Application** button, a live session, an unchanged review, and separate approval. It never fills signature controls, bypasses validation, makes a direct HTTP submission, or automatically retries. The worker records only an attempt until the user provides a receipt. Unknown submission contexts cannot use an ordinary Continue shortcut.

## Tests

From the repository root:

```sh
npm ci --ignore-scripts
node --test ios/Tests/*.test.js
```

The suites cover strict known-field matching, explicit mappings, multiple synthetic application pages, changed terms/answers, expiry, cancellation, one-use approvals, worker recovery, stale popups, native boundaries, receipt reporting, and no replay of submission. All form submits in tests are local synthetic events. Signed Safari native messaging and the complete live Iowa workflow still need device validation.
