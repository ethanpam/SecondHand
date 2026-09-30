# Question bank

One JSON file per **real public form**. It holds the form's questions copied exactly, each tagged with the answer rule that decides it. The dataset builder turns these into training examples and computes every correct answer with code (`shared/facts.cjs` plus `ML_model/answer-rules.cjs`). So a tag must describe what the question asks. **Never write answers here.**

Check your files with `node --test tests/ml-question-bank.test.cjs`.

## Rules for collecting
- **Public forms only:** food pantry and food bank intake forms, SNAP, WIC and USDA/TEFAP household applications, as Google Forms, Jotforms, web pages or PDFs. Skip anything behind a login.
- **Read only.** Never type into, submit, or save a form. Open it, read it, close it.
- **Copy labels and options exactly** as shown, without numbering like "3." or required-field asterisks.
- **No personal data.** Forms are blank; if a page shows anyone's information, skip it.
- **Every question on the page**, including ones SecondHand can't answer (`none`) and ones it must never answer (`never`). The model has to learn when to stay quiet.
- **One file per form.** Name it `<organization>-<form>.json` in kebab-case, e.g. `east-texas-food-bank-usda-intake.json`. Before adding a form, check that its URL isn't already in the bank.

## File format
```json
{
  "source": { "url": "https://…", "title": "Form title as shown", "kind": "google-form | jotform | pdf | web | iowa-portal", "retrieved": "YYYY-MM-DD", "region": "City, ST" },
  "questions": [
    { "id": "q1", "label": "Is anyone in your household 60 or older?", "type": "radio", "options": ["Yes", "No"], "rule": { "name": "anySenior60" } },
    { "id": "q2", "label": "Full name", "type": "text", "options": [], "rule": { "name": "field", "key": "fullName" } }
  ]
}
```
- `type` is one of `radio`, `select`, `checkbox`, `text`, `textarea`, `number`, `date`, `email`, `tel`.
- `options` lists the choices exactly, in page order, leaving out empty "Choose" placeholders. It's `[]` for text boxes.
- `note` (optional) explains a judgment call, e.g. why a question is `none`.
- `source.holdout: true` keeps a form in the test set for good. Use it only for fresh forms collected as a clean final check.
- The final holdout (#65) lives apart, in `ML_model/questions-final/`: the same format plus `source.final: true`. Training never reads that folder, `questions/` refuses a final form, and a test fails if a final form's label or distinctive option text appears in a training form or a synthetic rewording. Those forms are scored once, after the confidence bars are frozen.

## Picking a rule
The full list, with what each rule means and which question types it fits, is in `ML_model/answer-rules.cjs`. The most common:

| The question asks… | Rule |
|---|---|
| a text box for name, email, phone, address, ZIP, household size… | `field` with `key` (one of the engine's keys, e.g. `fullName`, `phone`, `zip`, `householdSize`) |
| anyone 65+ / 60+ in the household | `anySenior65` / `anySenior60` |
| "Are you 60 or older?" | `applicantAgeAtLeast` with `age: 60` |
| children under 18 in the household (yes/no) | `anyChildren` |
| anyone else in the household / household size > 1 | `householdMoreThanOne` |
| how many people / adults / children / seniors (choices) | `householdSize` / `adultsCount` / `childrenCount` / `seniorsCount` |
| the applicant's age range (choices) | `applicantAgeRange` |
| veteran, disability, pregnant, Medicare, all US citizens, homeless | `veteran`, `disability`, `pregnant`, `medicare`, `allCitizens`, `homeless` |
| income below an amount | `incomeBelow` with `amount`, `period` (`month` or `year`), and `orEqual: true` for "at or below" |
| which income range (choices) | `incomeBracket` with `period` |
| state, county (choices), or "Do you live in Iowa / Polk County?" | `state`, `county`, `livesInState` / `livesInCounty` |
| applying for SNAP, FIP, or Medicaid | `applyingSnap`, `applyingFip`, `applyingMedicaid` |
| the applicant's own row in a household table: "Applying?" | `applyingFor` with `programs`, the ones the form covers (`snap`, `fip`, `medicaid`) |
| coverage or benefits held now: "Do you have Medicaid?", "Which insurance do you have?" | `none`: the profile only says what the applicant is applying for |
| anything the saved profile can't know: pets, pickup day, student ID, diet, "currently receive SNAP?", "how did you hear about us" | `none` |
| consent, signatures, "I certify", terms, SSN | `never` |

If a question could fit two rules, or you're unsure, use `none` and explain it in `note`. A wrong tag teaches the model a wrong answer.
