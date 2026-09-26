# Address confirmation development

The current released extension pauses on **Select Address**. `extension/address-policy.js` is a tested comparison component for the next integration; it is not loaded by the manifest, worker, or content script and cannot select an address or navigate Iowa's portal by itself. Live address controls and later application pages still need inspection.

Iowa's [Select Address help](https://hhsservices.iowa.gov/apspssp/pages/WebHelp/select_address.htm) describes confirming correct addresses and saving them with **Save and Continue**. It does not document the current application form's field IDs, original/suggested address containers, choice values, warnings, or navigation handler. A help-page heading is insufficient to enable automatic actions.

## Comparison contract

The pure `SecondHandAddressPolicy.decide(input)` function accepts:

```js
{
  scope: 'home', // 'home' or 'mailing'; evaluated separately
  submitted: { line1: '123 Test Way', line2: 'Unit 4', city: 'Demo City', state: 'IA', zip: '50309' },
  candidates: [
    { id: 'suggestion-1', address: { line1: '123 TEST WAY', line2: 'UNIT 4', city: 'DEMO CITY', state: 'IA', zip: '50309' } }
  ],
  hasWarnings: false,
  hasErrors: false
}
```

The example is fictional and must not be entered into the live portal. Every input key is required, including an explicit empty `line2` when no unit or second line exists. Candidate IDs are adapter-local identifiers, not applicant answers. Candidates represent verified suggestions, separately from the original entered-address display.

The decision is eligible only when there is exactly one valid suggestion, no warning or error, and every component matches after ASCII capitalization and whitespace normalization. No punctuation is removed, no abbreviations are expanded, and no fuzzy matching, transliteration, inferred apartment, or ZIP+4 addition is accepted. Several candidates pause even when one matches. Home and mailing details are never substituted for each other.

Results contain only `eligible`, a fixed `reason` code, `candidateIndex` (zero or null), and static `differingComponents` names. They contain no address strings or candidate IDs. The module performs no DOM operations, network requests, logging, or storage and does not determine deliverability or benefit eligibility.

## Live integration requirements

Use the address actually entered in this application, including manual edits, as the comparison source. A saved desktop profile can be stale. The real screen must establish which controls represent that original address and which are suggestions; if it cannot, pause. Address details remain ephemeral and must not enter screenshots, fixtures, logs, sidebar messages, or persistent extension storage.

Before activating selection and navigation, verify the real form/action, home and mailing group boundaries, complete address components, suggestion controls, handlers, warning/error containers, and the exact ordinary **Save and Continue** control. Transcribe only sanitized structure into a fixture. Recheck the decision and original DOM elements immediately before selecting; recheck selected state and any resulting errors before navigation. Reuse the desktop session check, cancellation/tab/expiry guards, and single-use navigation snapshot. A comparison result alone never authorizes a click.

Changed addresses, missing units, multiple suggestions, unclear controls, consent, signatures, review, and final submission require the applicant. No automatic retry should follow an uncertain navigation result. Later pages need their own verified mappings; this component does not make the whole SNAP application automatic.

## Validation

Run `node --test tests/address-policy.test.cjs` for structured comparison cases. The real Chromium smoke (`npm run test:extension`) also includes an explicitly hypothetical Select Address page. It verifies that the current production extension stops after the applicant page, displays the manual address checklist, leaves choices untouched, and makes no second navigation or extra profile requests. That scenario proves the current boundary; it does not validate real Iowa address selection.
