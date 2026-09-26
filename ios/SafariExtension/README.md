# Safari contact autofill prototype

This bundled iOS Safari Web Extension offers an explicit **Preview fields → Fill saved contact details** flow. Its applicant mapping derives from this repository's [live-inspected public form metadata](../../docs/iowa-portal.md) recorded September 26, 2026. Safari filling, installed native messaging, and authenticated renewal have **not** been validated.

The extension only operates in the active top-level tab at `https://hhsservices.iowa.gov/apspssp/ssp.portal/applyForBenefits/enterPersonalInfo`. It also requires the visible **Enter Personal Information** heading and the unique `form#personalInformation` with action `enterPersonalInfo`. Safari grants temporary access through `activeTab` when the user opens the extension. There are no permanent or broad host permissions, background scripts, automatically injected content scripts, network calls, external webpage message listeners, or extension storage. Enable the installed extension in Safari settings and allow it on the Iowa portal when prompted.

## Data flow

1. The user unlocks SecondHand and starts its 10-minute autofill session.
2. **Preview fields** injects `field-mapper.js` into the active tab's isolated world. It reads form metadata and whether fields are empty, and returns only friendly field names/counts. Preview does not request saved profile data.
3. **Fill saved contact details** rechecks the active tab and exact URL, then calls native messaging from the extension popup:

   ```js
   browser.runtime.sendNativeMessage("com.ethanpam.secondhand", {
     action: "contactFields",
     pageURL: "https://hhsservices.iowa.gov/apspssp/ssp.portal/applyForBenefits/enterPersonalInfo",
     keys: ["firstName", "lastName"]
   });
   ```

4. `SafariWebExtensionHandler` rejects unknown actions, extra message properties, unsupported URLs, duplicate/unknown keys, unavailable sessions, and expired sessions. It reads `SecureVault.readAutofillSession()` and returns only requested contact fields:

   ```js
   { fields: { firstName: "Example" }, expiresAt: 1790424000000 }
   // Errors: { error: "session_unavailable" } or { error: "unsupported_request" }
   ```

   `expiresAt` is milliseconds since the Unix epoch. The shared model is `AutofillSession(expiresAt: Date, fields: [String: String])`. Root app code owns vault encryption, session creation/revocation, and the shared Keychain group.

5. The popup validates expiry and rechecks the tab/URL again. It sends only keys from the preview to the isolated script. The script validates the preview token, document identity, exact URL, session expiry, and current fields. The preview is single-use and expires after two minutes. No form navigation or submission is performed.

## Matching boundaries

Supported keys: `firstName`, `lastName`, `addressLine1`, `addressLine2`, `city`, `state`, `postalCode`.

Each field must match its observed **ID, name, control type, and every associated label**. Autocomplete alone is insufficient. Name controls use `firstName` / `lastName` and labels First Name / Last Name. Home address controls must also be inside `#personalInformation #homeAddrDiv`: `addressLine1` (Home Address Line 1), `addressLine2` (Home Address Line 2), `city` (City), `state` (State, a select), and `zipcode` (Zip Code (99999), mapped to local `postalCode`). Required asterisks, trailing colons, whitespace, and letter case are normalized. ZIP values must contain exactly five digits; ZIP+4 stays manual. The user must answer the home-address question themselves to expose those controls.

The matcher skips conflicting hints, duplicate matches (including populated duplicates), existing values, disabled/read-only/hidden/offscreen/covered fields, unknown or other-person section headings, and unsupported input types. No automatic scrolling occurs. Re-preview after scrolling. Mailing/shipping/billing addresses stay manual.

The profile's generic phone cannot be assigned to the observed separate home/mobile phone controls, so neither phone is filled. Email, middle name, SSNs, birth dates, income, account numbers, signatures, uploads, checkboxes, passwords, and eligibility answers are never mapped. A changed applicant route, heading, form ID/action, field schema, or address context fails closed.

Account, sign-in, registration, profile, password, and recovery routes are excluded, including the observed public route `/apspssp/ssp.portal/login/personalInfoSignup`. Pages containing password inputs or account-related headings are also rejected. A supported host alone does not establish that a page is a renewal form.

Once placed in a field, information is available to Iowa's website and its scripts. The user should review all answers and submit directly on the official portal. The extension has no automatic submission capability.

## Verification

Run the deterministic, synthetic-DOM security and behavior checks from the repository root:

```sh
node --test ios/Tests/extension.test.js
```

The tests use a sanitized synthetic transcription of the public schema and cover exact URL/page/form/field rejection, account pages, household ambiguity, address-purpose distinctions, sensitive and hidden fields, preservation of edits, changed/duplicated elements, navigation races, session expiry, select-option matching, and the popup/native data boundary.

The public field metadata has been inspected; this is not a completed Safari workflow validation. Before describing a real Iowa workflow as supported, test an installed, signed build on an iPhone with a consenting test user: verify extension permissions, shared-Keychain access, session expiration/revocation, an authenticated application/renewal page, field semantics, review behavior, and that no submission occurs. Record validated selectors and portal changes separately. Do not populate or submit a real application during automated checks.

Apple documents [native messaging and app-extension communication](https://developer.apple.com/documentation/safariservices/messaging-between-the-app-and-javascript-in-a-safari-web-extension). Script injection follows the documented [`scripting.executeScript` API](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/executeScript).
