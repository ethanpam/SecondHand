# Household setup and "save it for next time"

## Goal
SecondHand answers more of a form's questions from what the applicant saved, with less typing up front.
1. **A household list:** each person's name, birth date, relationship to the applicant, and optionally whether they're a student and their grade. Code derives every count a form asks for from it, including age bands like 0–17, 18–59, 60+ or 0–5, plus a student's name and grade.
2. **A short guided setup** right after the password is created, that's skippable, resumable, and saves as it goes.
3. **"Save to My information"**, offered when Autofill left a known question open because nothing was saved, and the applicant then answered it on the page.

Questions that change over time ("Is this your first visit this month?", pickup times) are never pre-answered.

## Today
- The profile stores fixed counts: `householdSize`, `householdAdults` (18–64), `householdChildren` (under 18) and `householdSeniors` (65+), validated in `shared/schema.cjs`.
- A form asking "# of people in your household 18–59" or "60+" can't be answered, and neither can "Student name and grade" or "Guardian first and last name".
- The live QA (#89) found these age-band boxes on most pantry forms.

## Design

### 1. Household list (`shared/schema.cjs`, `renderer/`)
- **A new profile field, `householdMembers`:** an array of up to 20 `{ id, firstName, lastName, birthDate, relationship, student, grade }`.
  - `relationship`: self, spouse/partner, child, parent, sibling, grandchild, other relative or other.
  - `student`: yes or no. `grade`: free text up to 20 characters, e.g. "3rd", "K" or "College".
  - The applicant is the `self` row, created from their own name and birth date and kept in sync with them.
  - Validation follows the schema's existing rules: dates valid and not in the future; names trimmed, length-limited, no control characters.
- **Derived counts:** when `householdMembers` has people, `householdSize`, `householdAdults`, `householdChildren` and `householdSeniors` are derived from it by code (ages as of today), the same way `DERIVED_FIELDS` works.
  - The manual counts stay for applicants who skip the list.
  - When both exist, the list wins, and My information shows the derived counts read-only, with a note.
- **Facts for Laya:** `shared/facts.cjs` gains facts about each person, e.g. "The household has 2 children: ages 7 and 12." and "One household member is a student in 3rd grade.". Facts from birth dates are marked sensitive, as the applicant's own birth date is today.

### 2. Age bands and members in the rules (`extension/generic-adapter.js`, desktop `getFields`)
- **Age bands:** a count question that names an age range, such as "# of people in your household 0 - 17 yrs old", "18-59", "60 +", "60 and older", "under 5", "ages 6 to 18" or "0–5", is matched to a band key, e.g. `householdCount:0-17` or `householdCount:60+`.
  - The desktop computes the count from the members' birth dates as of today. It returns a number only when every member has a birth date; otherwise the question stays with the applicant.
  - Band keys are parsed and validated strictly: whole numbers 0–120, low ≤ high, or N+.
  - A count by birth date counts as sensitive (it reveals ages), so it goes through the named confirmation on non-Iowa sites, as `birthDate` does.
- **Students:** a "Student name and grade" style box is filled from the one member who is a student, as "First Last, Grade". With zero or several students, it stays with the applicant.
- **Guardian:** "Guardian name" is **not** inferred, because the contract forbids inferred answers. It stays with the applicant unless the guardian is saved explicitly, which this spec doesn't add.
- **The applicant-only guards from #83 stay:** a member's details only go into boxes that ask for that member's details (student name, a household member's row), never into the applicant's own boxes.

### 3. Guided first-run setup (`renderer/`)
- **When it appears:** right after the vault is created, the app offers **Set up your information (about 5 minutes)**, with **Skip for now**.
- **The steps:** you (name, birth date, contact); your household (the list above); where you live; income and money on hand; programs; About you (the Tell Us More answers from #63).
  - Every step reuses the existing My information fields and validation; there's no second form.
  - Each step saves when the applicant moves on.
  - Progress is remembered, so the setup can be resumed from Overview ("Finish setting up: 3 of 6 steps").
- **Accessibility:** it works with the keyboard and a screen reader, and stays readable at 200% zoom.

### 4. "Save to My information" (`extension/`, `desktop/`)
- **When it's offered:** after an Autofill, the worker knows which questions it matched to a profile key the applicant hasn't saved (the "not saved" list in the side panel).
  - When the applicant later types or selects an answer in one of those boxes on the page, the side panel shows **Save to My information** beside that question, with the value.
  - Only keys in `PROFILE_KEYS` are offered, with the same type checks as the schema.
- **Saving:**
  1. The click sends `saveFields { url, fields: { key: value } }`, a new native request. Its validation mirrors `getFields`: https site or Iowa's portal, profile keys only, and values checked by the schema.
  2. The app needs to be unlocked. It shows one confirmation naming the fields and values ("Save to My information?"), then saves through the existing profile update path.
  3. Nothing is saved without that click and that confirmation.
- **Reading the page:** the extension reads a box's value only for the boxes listed, and only after the applicant clicks Save. It never reads password, code or signature boxes. Sensitive keys get the same confirmation as filling them.
- **Out of scope:** questions without a profile key.

## Unchanged
- Nothing is filled without an Autofill click, and nothing is submitted.
- Sensitive details still need confirmation on non-Iowa sites.
- Iowa's adapter keeps filling only what it verifies. Iowa's household-member pages are out of scope.

## Strings and docs
- New extension strings go in all six catalogs in `extension/strings.js`. The desktop renderer stays English, like today.
- Update the README ("What it does"), `docs/security.md` (`saveFields`, member data), `docs/implementation-contract.md` and `docs/iowa-portal.md` if field coverage changes.

## Tests (written first)
- **Schema:** member validation, derived counts and their boundaries (birthdays today, age 17/18, 59/60, 64/65), the list winning over the manual counts, and the 20-member limit.
- **Age bands:** parsing every phrasing above and refusing malformed ones; counts from birth dates; no answer when a birth date is missing; sensitive confirmation off Iowa.
- **Students:** exactly one student fills "First Last, Grade"; zero or several don't. Guardian is never filled.
- **Facts:** the new member facts and their sensitivity.
- **`saveFields`:** validation, the unlocked and confirmed path, refusals, and that only listed boxes are read, after the click.
- **Setup:** step saving, resume and skip (renderer state tests).
- **Smoke:** `npm run test:ui` covers the setup flow and a household list. A synthetic form with the screenshot's questions (`# of people 0–17 / 18–59 / 60+`, "Student name and grade") fills from the fictional profile, which gets a fictional household. `npm run test:extension` covers "Save to My information".
- `npm test`, `npm run check`, `npm run test:extension`, `npm run test:translation`, `npm run test:laya` and `npm run test:ui` pass.
