# Test fixtures

`applicant-profile.json` is entirely fictional data for isolated local QA and browser fixtures. It includes every current profile key, explicit Yes/No choices, and separate home and mailing addresses. Its phone numbers use the reserved 555-0100–0199 range, email uses `.invalid`, and SSN is blank.

Never enter, upload, or submit this data to the live Iowa portal. Tests may clone it to exercise unknown choices, no home address, same-as-home mailing, alternate program selections, and missing required information. It does not supply defaults to the real desktop profile.
