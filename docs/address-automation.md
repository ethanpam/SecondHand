# Home-address confirmation

This development branch supports Iowa's observed **Select Address** home-address step. During approved guided autofill, it selects the first entry under **Possible matches for your home address** and uses the verified **Save and Continue** button. This follows the requested first-suggestion preference; it does not establish that the address is correct. The applicant must review the chosen address before final submission. The public 0.4 download has not been updated with this change.

The adapter uses Iowa's suggestions for the address entered in the current application. It does not reread or substitute the desktop profile at this step. The originally entered-address option is identified separately and is never used as a fallback when suggestions are missing. Address values remain in the page and private, short-lived navigation snapshot; the sidebar receives only a static checklist and status.

## Observed controls

Read-only inspection on September 26, 2026 verified:

- Path `/applyForBenefits/addressValidation`, heading **Select Address**, and `form#addressValue` posting to `selectedAddress`.
- A home-address table with distinct **Possible matches for your home address:** and **Your Home address as you entered is:** rows.
- Suggestion radio `#homeAddressIndex0`, name `homeAddressIndex`, value `0`, handler `onHomeAddrSelect('0');`. The original-address radio follows the suggestions with its own sequential index.
- A separate associated label and county row for each choice. The observed suggested address had no county input; the original address had a hidden county select.
- A visible `button[type="button"].saveAndContinueButton` labeled **Save and Continue**, handler `submitForm();`.
- Known home/mailing error containers and a hidden modal containing **Sign & Submit**. Any rendered modal blocks automation. The visible `#infoMsg` is ordinary selection guidance, not an error.

The inspected page contained one suggestion. Local generated variants exercise multiple suggestions with the same structure; those variants have not been verified live. Separate mailing-address confirmation is not mapped.

## Selection and navigation guards

`SecondHandAddressPolicy.decide(input)` is a pure, value-free decision over ordered candidate metadata, scope, and warning/error/unknown-control flags. Only the verified home scope is eligible. It chooses the first suggestion regardless of address spelling differences, accepting up to eight structurally verified suggestions. This intentionally replaces the earlier, unused equivalent-address comparison prototype.

The adapter must verify the exact form, headings, group boundaries, radio IDs/names/values/handlers, and ordinary Next control. A heading alone does not enable automation. Unexpected controls, unsupported mailing choices, visible county questions, errors, warnings, consent, and visible dialogs pause the flow.

The single-use navigation snapshot binds the document, URL, original elements, ordered choices, current selection, and displayed address text. Changed choices or addresses invalidate it. Immediately before automatic navigation, the worker checks the existing desktop grant and tab/cancellation/expiry guards. The adapter revalidates the snapshot, selects the first suggestion if needed, then checks the resulting selection and page state before clicking Next once. An uncertain result is not retried automatically.

The desktop approval dialog and sidebar disclose first-suggestion selection. The home address stored in a real profile has no fixture default. The campus address in the QA profile is used only by isolated tests.

**Save and Continue sends and may save answers with Iowa before final submission.** Signatures, consent, review, final submission, and unverified later pages require the applicant. This feature does not automate the whole SNAP application.

## Validation

`tests/fixtures/iowa-select-address.cjs` reconstructs the observed schema with the public campus test location. It contains no captured page, cookies, or session values. Policy and adapter tests cover first-suggestion selection, altered markup and snapshots, error/modal/county pauses, and single-use navigation. The isolated Chromium smoke exercises applicant → verified home-address confirmation → unsupported later page with the actual extension and a simulated native bridge. A separate hypothetical address fixture continues to prove that unverified markup stays manual.
