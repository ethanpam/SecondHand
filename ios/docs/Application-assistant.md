# Guided application assistant

SecondHand's iOS assistant automates typing and approved page actions while the applicant stays involved. It is not an unattended renewal service. Offline storage works without a connection; applying through Iowa's website requires internet access.

## Pipeline

1. **Review and share.** The applicant unlocks the native app, reviews their current profile, and explicitly enables a ten-minute encrypted application snapshot.
2. **Start in Safari.** The extension requests access to the Iowa origin when Start is selected. A background controller binds the session to one tab and validates the native sharing grant. It retains only a tab ID, expiration, phase, page count, and filled-field count in extension storage.
3. **Inspect.** The isolated page script identifies known applicant fields or offers eligible labeled fields for explicit user mapping. No saved values are returned by inspection. Page snapshots and one-use preview tokens remain in memory.
4. **Fill.** The native handler releases only the requested approved fields. The script rechecks the document, URL, field identity/context, emptiness, visibility, and expiration. A complete home address recently confirmed in the native profile supplies a derived Yes answer for the verified, unanswered **Do you have a home address?** group. The assistant uses Iowa's normal radio control to reveal its fields, then scans again and requests the address fields under the active native sharing grant before filling them in the same Start action. It preserves existing answers and refuses a choice that could reset existing home or mailing details. Other hidden questions remain untouched; rendered fields can be scrolled into view.
5. **Review and continue.** Users complete unanswered questions on the website, refresh the preview, and choose Continue. Each action has a fresh, short-lived preview bound to the page and its current answers. A different tab, changed page, or missing required answer prevents the action. Pause/Stop interrupts pending work; worker recovery does not replay an action.
6. **Sign and approve.** Users complete signature and consent themselves. The extension only offers submission on an E-Signature page with one eligible, form-associated Submit Application button. The popup requires an unchecked-by-default authorization box and a distinct approval button. Changed controls, review text, terms, or form targets invalidate approval. Expiry, Pause, and Stop also invalidate it.
7. **Check the receipt.** Before attempting submission, the worker persists an awaiting-confirmation phase. It never treats a click or navigation as success and never automatically retries. On a recognizable confirmation page, the user enters the website's number and confirms submission. The native extension writes a separate encrypted receipt; the app imports it on unlock/resume and labels it user-reported. Receipts are deduplicated and do not overwrite a more advanced plan or attach an older submission to a new renewal.

## Coverage

| Page or information | Behavior |
| --- | --- |
| Inspected Enter Personal Information page | Automatically matches first/middle/last name, home/mobile phone, and home address using the laptop adapter's verified schema; a reviewed complete native address can select the unanswered home-address Yes choice before a fresh scan fills its fields |
| Other labeled text/select controls on application routes | User chooses the saved field for this page; no guessed matches or remembered mappings |
| Email, monthly income, monthly housing cost | Available only through an explicit field selection; different income definitions must be resolved by the applicant |
| Other household members, SSN, birth date, passwords, security codes, account numbers | Not filled |
| Login, CAPTCHA, preliminary program choices/consent, uploads | Pause for the applicant |
| Signing or submission context with unknown structure | Manual website fallback |
| Recognized E-Signature / Submit Application | Separate user approval, then one normal website button click; signature controls remain untouched |
| Recognized receipt heading | User-confirmed number capture; no inferred agency status |
| Unrecognized receipt or authenticated renewal route | Use the website and manually record progress |

Support is restricted to clean HTTPS URLs beneath `hhsservices.iowa.gov/apspssp/ssp.portal/applyForBenefits/`. Account routes, query/fragment routes, unrelated origins, frames, and external form targets are rejected. This deliberately excludes unverified portal variants.

## Implementation

- `field-mapper.js` retains the strict inspected Iowa field matcher and adds the laptop's explicit home/mobile phone semantics.
- The Safari bundle includes `extension/iowa-adapter.js` directly from the laptop implementation. Its verified Continue control and required/conditional-question checks are shared across both platforms, including Iowa's required labels that lack HTML `required` attributes. The home-address choice uses its exact radio-group matcher and dependent-answer guard, including the expected question, labels, option values, form, and Iowa show/hide handlers.
- `Models.swift` derives `hasHomeAddress: "yes"` only when the profile was confirmed within the past 24 hours and contains a street, city, recognized US state/DC code, and five-digit ZIP. Unit is optional. It never derives No from missing information, and session validation rejects an unsupported home-address answer or Yes without a complete address.
- `application-assistant.js` owns document inspection, user-selected bindings, scrolling fills, cancellation, and one-use page actions. Its private snapshot includes all form values and page markup so changes to review/attestation text invalidate approval. Its home-address action accepts only the native Yes value and a fresh preview of the still-unanswered verified group; it clicks the normal control rather than evaluating Iowa's handler directly.
- `background.js` owns the one-tab workflow, native requests, cancellation, and extension-message origin checks. For the home-address question, it requests the derived value separately, attempts the choice at most once per run, then inspects again and obtains requested text values under the active native grant. The document and URL must remain the same. Persistent metadata contains no answers, labels, URLs, signatures, or approval tokens.
- `popup.js` presents mapping choices and final approval. Each mutating request is bound to the preview actually shown to that popup, preventing another popup's refresh from silently replacing the approved application.
- `SafariWebExtensionHandler.swift` validates the action, route, field allowlist, and active sharing grant. No webpage/native messaging endpoint is exposed.
- `SecureVault.swift` stores encrypted snapshots and independent pending receipt files; the extension never edits the app's main profile vault. AppData imports durable receipt IDs/confirmation numbers before clearing pending files.

## Evidence and remaining validation

The [repository's public portal inspection](../../docs/iowa-portal.md) establishes the applicant-page schema, its approved Continue action, and earlier onboarding steps. The [live iPhone Safari recording](qa/iphone-live-safari-demo.mp4) verifies the installed extension's native messaging, automatic home-address Yes choice, and **10 filled applicant fields** in one Start action on iOS 26.5 Simulator. The user separately approved the fictional live test and completed CAPTCHA and consent. No applicant Save and Continue, signature, or submission action was taken. The complete iOS application workflow, later pages, and physical-device integration remain unverified.

The final step uses the semantic labels in [Iowa's E-Signature help](https://hhsservices.iowa.gov/apspssp/pages/WebHelp/e_signature.htm). Its actual signed-in DOM and receipt page still require validation with a consenting applicant or an agency test environment. A different heading, button, route, or form action may make the assistant pause. [Iowa's SNAP instructions](https://hhs.iowa.gov/assistance-programs/food-assistance/snap/apply-snap) also describe interviews and additional documents; successful form submission does not complete those steps.

Tests exercise local synthetic pages through known autofill → explicit income mapping → manual signature → approved submission → user-confirmed receipt. They intercept all submit events locally. They do not establish successful live filing, physical-device Safari integration, eligibility, or renewal coverage. See [Validation](Validation.md).

The follow-up [Iowa guest-page QA](../../android/docs/Iowa-guest-QA.md) also exercises the shared engine in Android's real isolated WebView. It found and fixed a generic Continue action on the unintegrated **Select Address** step. Mobile treats that heading or the observed `addressValidation` route as manual, including when errors or dialogs appear. That later address-validation step remains manual on iOS and Android; it is separate from the applicant page's home-address Yes choice described above.
