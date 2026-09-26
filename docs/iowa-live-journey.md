# Iowa guest-draft journey: fictional QA

## Scope and authorization

This log records one observed live Iowa guest-draft path on September 26, 2026. It uses an explicitly fictional QA persona and the public campus location supplied for testing. It is not evidence of all household branches, benefit eligibility, a submitted application, or end-to-end operation of the SecondHand extension and desktop bridge.

The user completed CAPTCHA and the initial data-use consent themselves, then authorized continuing the fictional draft using ordinary **Save and Continue** actions. Further consent, certification, signatures, and final submission were outside that authorization. The journey reached **E-Signature** and stopped without interacting with that page. No final submission or receipt was obtained.

This document records sanitized route paths, visible headings, and control metadata reported by the operator. It does not contain session identifiers, session-bearing URLs, tokens, cookies, hidden field values, real applicant data, or captured page contents. Fixed query parameters inside reported public button handlers are retained only as control metadata. Describing a control here does not enable it in the production adapter or justify inferring unseen controls.

## Fictional scenario

- Name: Avery Jordan Example.
- Public campus test location: 411 Morrill Rd, Ames, IA 50011.
- Reserved fictional phone numbers: 202-555-0147 and 202-555-0148.
- One adult; home and mailing address are the same.
- SNAP only; SSN remains blank.

These are QA inputs, not defaults for a real applicant. Entering them into the live portal shares them with Iowa and may save a draft before final submission.

## Observed sequence

Paths below omit the common portal base `/apspssp/ssp.portal`. For example, `/applyForBenefits/dynamicQuestions` denotes the full pathname `/apspssp/ssp.portal/applyForBenefits/dynamicQuestions` on the official Iowa portal. Query strings and fragments from journey URLs are omitted.

| Step | Route path | Observation and action | Coverage limit |
| --- | --- | --- | --- |
| 1 | `/applyForBenefits/enterPersonalInfo` | The initial applicant page was completed with the fictional scenario, and ordinary **Save and Continue** succeeded. | This records successful live traversal, not proof that the extension performed the fill or navigation. |
| 2 | `/applyForBenefits/addressValidation` | The first possible home-address suggestion was selected: 411 Morrill Rd with ZIP+4 **50011-2104**. **Save and Continue** succeeded. | One home-address suggestion path only. No separate mailing-address or county-question branch was exercised. Selection does not establish suitability as an applicant's actual address. |
| 3 | `/applyForBenefits/enterPersonalInfoSummary` | Heading: **Enter Personal Information Summary**. No main form or editable answers were present. The reviewed summary was continued to the next page. | Summary review remains manual in production. |
| 4 | `/applyForBenefits/dynamicQuestionsStart` | Heading: **Emergency Supplemental Nutrition Assistance Program (SNAP)**. Four household Yes/No questions appeared in `form#answerSet`. Fictional answers **Yes, Yes, No, Yes** were entered, and the draft advanced to **Tell Us More**. | Manual answers under the fictional no-income, cash-below-$100, housing-expense scenario. No profile-schema or API mapping is implied. |
| 5 | `/applyForBenefits/dynamicQuestions` | Heading: **Tell Us More**. The **Start Application** breadcrumb was active. Fictional personal details were entered for the primary person in `form#answerSet`, which posts to `simple`. **Save and Continue** succeeded. | The SSN-existence question and SSN number were left blank; the portal permitted continuation. |
| 6 | `/applyForBenefits/ssaVerificationRender` | Heading: **Background Information**. Optional background questions appeared in `form#answerSet`, posting to `simple`. Fictional answers were entered and ordinary Next successfully loaded **Start Application Summary**. | Race remained blank. |
| 7 | `/applyForBenefits/vlpVerificationRender` | Heading: **Start Application Summary**. The entered fictional answers were displayed, reviewed, and continued using **Save and Continue**. | Review remains manual; the summary's presence is not an eligibility result or final submission. |
| 8 | `/applyForBenefits/wicCategoricalVerificationRender` | Heading: **People Summary**. **People** was the active breadcrumb and **Start Application** was marked visited. The primary applicant was the fictional persona. No other person was added; **Save and Continue** loaded the **Job and School** introduction. | Only the single-adult path was exercised. |
| 9 | `/applyForBenefits/dynamicQuestions` | **Job and School** introduction, section **2 of 7**, with its breadcrumb active. The operator continued. | Introduction only; no job or school answers were inferred. |
| 10 | `/applyForBenefits/dynamicQuestions` | **Job Information**, with `form#answerSet` posting to `simple`. Four manual questions were answered **No** for the fictional adult; ordinary Next loaded **Job Summary**. | School, strike, working/planned-work/self-employment, and recently-ended-job detail branches were not explored. |
| 11 | `/applyForBenefits/dynamicQuestions` | **Job Summary** displayed the four **No** answers. The operator reviewed them and used **Save and Continue** to reach **Other Income**. | Manual summary review. |
| 12 | `/applyForBenefits/dynamicQuestions` | **Other Income** introduction, section **3 of 7**. The operator continued to **Income Information**. | Introduction only. |
| 13 | `/applyForBenefits/dynamicQuestions` | **Income Information** presented eight manual income questions. Seven were answered **No**, and expected income remaining unchanged was answered **Yes**. Saving loaded **Other Income Summary**. | No income-amount or source-detail branches were visited. |
| 14 | `/applyForBenefits/dynamicQuestions` | **Other Income Summary** displayed the eight fictional answers. The operator reviewed them and used **Save and Continue** to reach **Expenses**. | Manual summary review. |
| 15 | `/applyForBenefits/dynamicQuestions` | **Expenses** introduction, section **4 of 7**. The operator continued to **Expenses Information**. | Introduction only. |
| 16 | `/applyForBenefits/dynamicQuestions` | **Expenses Information** presented eight manual expense questions. Housing and utilities were answered **Yes**; the other six were answered **No**. Saving loaded **Housing Expenses**. | Only the reported housing and utilities branches were selected. |
| 17 | `/applyForBenefits/dynamicQuestions` | Heading: **Housing Expenses**; page title: **HousingCosts**. The fictional primary person and expense type **Rent** were selected explicitly; **800** and **Monthly** were entered. Ordinary Next loaded **Housing Expenses Summary**. | Manual QA money entry; no production rent mapping is established. |
| 18 | `/applyForBenefits/dynamicQuestions` | **Housing Expenses Summary** confirmed **Rent, 800, Monthly**. The draft continued to **Utility Expenses**. | This confirmation concerns the entered QA answers only. |
| 19 | `/applyForBenefits/dynamicQuestions` | **Utility Expenses** requested a person and utility types. The fictional primary person, Electricity/Lights, Water/Sewage, and heating/cooling were selected. **Save and Continue** was accepted. | No utility amount was requested or entered. Other utility types were untouched. |
| 20 | `/applyForBenefits/dynamicQuestions` | **Utility Expenses Summary** confirmed the three selected types. **Save and Continue** loaded **Expenses Summary**. | Manual summary review. |
| 21 | `/applyForBenefits/dynamicQuestions` | **Expenses Summary** displayed the initial expense Yes/No answers, **800 Monthly** rent, and the selected utility types as intended. Ordinary **Save and Continue** loaded **Property**. | Manual summary review. |
| 22 | `/applyForBenefits/dynamicQuestions` | **Property** introduction, section **5 of 7**, followed by **Property Information**. Liquid assets was answered **Yes**; six other property questions were answered **No**. | Only the liquid-assets detail branch was exercised. |
| 23 | `/applyForBenefits/dynamicQuestions` | **Other Property - Liquid Assets**. The fictional primary person, **Cash/Uncashed Check**, and current value **50** were entered explicitly. Ordinary Next was accepted. | Optional amount owed, account/policy, bank name, and acquisition date remained blank. |
| 24 | `/applyForBenefits/addressValidationDQfuncPage` | **Liquid Assets Summary** confirmed **Cash, 50**. **Save and Continue** loaded **Property Summary**. | This was a financial summary, not address selection. |
| 25 | `/applyForBenefits/dynamicQuestions` | **Property Summary** confirmed the property answers. Ordinary **Save and Continue** loaded the **Other** introduction. | Manual summary review. |
| 26 | `/applyForBenefits/dynamicQuestions` | **Other** introduction, section **6 of 7**. The operator continued. | Introduction only. |
| 27 | `/applyForBenefits/personRelationshipRender` | **Household Relationships** contained no other household members or answer inputs for the single-adult scenario. Ordinary Next was used. | No relationship or multi-person branch was exercised. |
| 28 | `/applyForBenefits/dynamicQuestionsResume` | **Other Information** presented six manual questions; all were answered **No** for the fictional scenario. The operator continued. | These sensitive answers were explicit QA choices, not inferred from saved profile values. |
| 29 | `/applyForBenefits/dynamicQuestions` | **Other Information Continued** presented five manual questions; all were answered **No** for the fictional scenario. The operator continued. | No related detail branches were explored. |
| 30 | `/applyForBenefits/dynamicQuestions` | **Other Summary** was reviewed and ordinary Next was used. | Manual summary review. |
| 31 | `/applyForBenefits/dynamicQuestions` | **Submit Application** introduction, section **7 of 7**. Ordinary Continue loaded **Voter Registration**. | The section title did not itself submit the application. |
| 32 | `/applyForBenefits/thirdPartyDetails` | **Voter Registration**: the operator explicitly chose **No** using `#falseRadio1` and used ordinary **Save and Continue**. | No voter-registration application or consent was completed. |
| 33 | `/applyForBenefits/iaReminderAboutYourRights` | The reminder stated that signing later acknowledges rights. Initial Continue required reviewing **Legal Information**. The operator opened the linked PDF, then ordinary Continue loaded **E-Signature**. | No checkbox or separate acknowledgment was present or operated. Opening the PDF did not certify or sign anything. |
| 34 | `/applyForBenefits/eSignature` | Heading: **E-Signature**. The signing checkbox remained unchecked, signature field empty, role at its untouched **Applicant** default, and **Submit Application** disabled. | **Stopped. No clicks or field edits were made on this final page.** |

### Personal information summary

The observed visible continuation button had class `btn btn-primary saveAndContinueButton` and this exact handler attribute:

```html
onclick="submitUrlLink('continueEnterPersonalInfoSummary');return false;"
```

The summary itself required human/QA review. Its visible continuation control does not make the summary eligible for automatic Next.

### Emergency SNAP questions

The four observed questions concerned:

1. Household income below $150.
2. Household cash below $100.
3. Migrant or seasonal farmworker status.
4. Housing and utilities exceeding expected income.

The Yes/No controls used the ID pattern `answerSets0.answers0.answerValue1` / `answerSets0.answers0.answerValue2`, through question indexes `0`–`3`. This records only observed metadata; exact question wording, answer semantics, later conditional branches, and navigation controls are not inferred from the IDs. These answers remain manual and are not derived from saved income or expense fields.

### Tell Us More: primary person

The primary-person section contained 98 question templates, most hidden. The visible optional groups concerned gender, date of birth, whether the person has an SSN, citizenship, marital status, military status, eating with the household, disability, and blindness. Choosing citizenship **Yes** revealed a born-in-the-US question. The page stated that questions the applicant could not answer could be skipped.

The operator entered these fictional answers: Male; date of birth **04/12/1985**; citizenship **Yes**; born in the US **Yes**; Never Married; military **No**; eats with the household **Yes**; disabled **No**; blind **No**. Whether the person has an SSN and the SSN number remained blank. These choices describe this QA scenario only; no citizenship, disability, military, or SSN decision is automated or inferred.

The observed continuation control was `#dqButtonId309`, class `btn btn-primary saveButton`, with this exact handler attribute:

```javascript
dynamicQuestionsButton('WARNING!', '', 'Ok', 'Cancel', 'answerSet', 'simple?buttonId=309', 'true', 'dqButtonId309');
```

The optional date-of-birth repeat-fill mapping uses this verified control, with Next always manual on this page. Its unit and isolated Chromium tests are described in [extension QA](extension-qa.md); this manual journey is separate evidence. The other subjective and sensitive questions remain manual for real applicants, and the hidden templates are not treated as observed active questions.

### Background Information

The page showed a heading identifying the primary person and introductory text outside the form at `div.fullrow.floatLeft > p`. Visible optional questions concerned Iowa residency (question index `1`), migrant or seasonal farmworker status (`5`), preferred language (`8`), naturalized citizenship (`18`), birth state (`187`), and race checkboxes (`189`). Indexes record the observed question templates; they do not establish stable or global mappings.

The fictional answers were Iowa resident **Yes**, migrant or seasonal farmworker **No**, preferred language **English**, naturalized citizen **No**, and birth state **Iowa**. Race remained blank. The birth state was an explicit QA answer; a saved home-address state must never be treated as a person's birth state.

The observed ordinary Next control was `#dqButtonId311`, with this exact handler attribute:

```javascript
dynamicQuestionsButton('WARNING!', '', 'Ok', 'Cancel', 'answerSet', 'simple?buttonId=311', 'true', 'dqButtonId311');
```

The operator clicked this control and reached **Start Application Summary**. These background questions remain manual for real applicants.

### Start Application Summary and People Summary

The operator reviewed the displayed fictional answers on **Start Application Summary** and used ordinary **Save and Continue**. The following **People Summary** identified Avery Jordan Example as the primary applicant and offered optional **Add Another Person**. No other person was added in this single-adult scenario. Other household members and their conditional questions were not explored.

**People Summary** had no form. Its continuation control was `#saveAndContinueButton`, type `button`, class `btn btn-primary saveAndContinueButton`, with this exact handler attribute:

```javascript
submitUrlLink('summaryContinue?questionSetId=4');return false;
```

The operator clicked this control and reached the **Job and School** introduction. Neither summary is enabled for automatic review or navigation by these observations.

### Job and School

After continuing the section **2 of 7** introduction, **Job Information** presented four manual questions: school or college attendance (question index `0`), being on strike (`3`), working, planned work, or self-employment (`6`), and a job ending in the last 30 days (`7`). The operator chose **No** for all four under the fictional scenario.

The ordinary continuation button had no ID and this exact handler attribute:

```javascript
submitAction();return false;
```

The next page, **Job Summary**, displayed all four **No** answers. The operator reviewed them and clicked **Save and Continue**. No job, employer, school, or income-detail branch was visited.

**Route reuse is a verified integration constraint:** the introduction, question form, and summary all appeared at the same clean `/applyForBenefits/dynamicQuestions` path, which was also used earlier by **Tell Us More**. A route alone cannot identify the active step, question set, or safe navigation behavior. Page-specific visible headings, section phase, form structure, and controls must be verified separately.

### Other Income

The **Other Income** introduction identified section **3 of 7**. The following **Income Information** page used the same clean route. The observed question topics and explicit fictional answers were:

| Question index | Topic, paraphrased | Fictional answer |
| --- | --- | --- |
| `0` | Social Security, retirement, or pensions | No |
| `1` | Listed income including alimony, child support, investments, and unemployment | No |
| `3` | Listed income including gifts, workers' compensation, settlements, and SSI | No |
| `5` | Educational grants or loans | No |
| `10` | Housing, food, or similar support provided free or in exchange | No |
| `15` | Expected income remaining unchanged | Yes |
| `16` | Money from friends or relatives | No |
| `17` | Other income | No |

The topic descriptions are summaries, not complete question wording or exhaustive option lists. Saving loaded **Other Income Summary**, where the operator reviewed the eight answers and clicked **Save and Continue**. No income amounts, individual income sources, or associated detail branches were explored. These questions remain manual and are not derived from a saved monthly income total.

### Expenses and housing costs

After the **Expenses** introduction, section **4 of 7**, **Expenses Information** presented these topics and explicit fictional answers:

| Question index | Topic, paraphrased | Fictional answer |
| --- | --- | --- |
| `1` | Dependent care | No |
| `2` | Housing expenses | Yes |
| `3` | Low-rent housing | No |
| `6` | Child support | No |
| `7` | Utilities | Yes |
| `8` | Energy assistance in the past year | No |
| `11` | Medical expenses | No |
| `12` | Medicare expenses | No |

Saving reached **Housing Expenses** with page title **HousingCosts**, `form#answerSet`, and POST action `simple`. The required person select, ID `answerSets0.personSelection`, offered only the fictional primary person with option value `0`; the operator selected that person. The expense-type select `#questionType` offered **Rent** with value `2999`. Choosing Rent opened accordion `#2999` containing `#section2999` and reset the expense-type select. The UI confirmed that the rent section opened; an automation-tool warning about the reset select did not indicate failed selection.

The visible required **How much** text control had ID `answerSets0.answers1.answerValue` and name `answerSets[0].answers[1].answerValue`. It received the fictional amount **800**. The **How often** select at question index `2` offered Annually, Every Other Week, Irregular/Infrequent, Monthly, Quarterly, Semi Annually, Twice a Month, and Weekly; the operator explicitly selected **Monthly**. A start-date control at index `3` was present but hidden and was not filled.

The ordinary Next button had no ID and handler `submitAction();return false;`; the operator clicked it. **Housing Expenses Summary** confirmed **Rent, 800, Monthly**, and the draft continued to **Utility Expenses**. No production rent mapping is established by this manual QA entry. Person, expense type, amount, and frequency must remain explicit; a stored rent amount alone cannot select the person or imply the portal's frequency answer. Other expense types and associated branches were not explored.

### Utilities and expense summaries

On **Utility Expenses**, the operator explicitly selected the fictional primary person using `answerSets0.personSelection`. The checkbox group followed the ID pattern `answerSets0.answers0.answerValuesN`. These options were selected:

- Index `2`: Electricity/Lights.
- Index `3`: Water/Sewage.
- Index `9`: Heating/cooling.

The other observed options were left untouched: index `1` Gas, `4` Telephone, `5` Pet Fees, `6` Garage Rent, `7` landlord extra charges, and `8` Garbage. The page asked for utility types only; it had no amount question. No stored monthly utilities figure was entered or used to infer a type.

**Save and Continue** was accepted. **Utility Expenses Summary** confirmed the three selected types, then ordinary continuation loaded **Expenses Summary**. The operator checked that this combined summary displayed the initial expense Yes/No answers, **800 Monthly** rent, and the selected utility types as intended, then clicked its ordinary **Save and Continue**. All these pages reused `/applyForBenefits/dynamicQuestions`.

### Property and liquid assets

After the **Property** introduction, section **5 of 7**, **Property Information** presented these topics and explicit fictional answers:

| Question index | Topic, paraphrased | Fictional answer |
| --- | --- | --- |
| `0` | Liquid assets | Yes |
| `2` | Property | No |
| `4` | Trust | No |
| `5` | Property sold or transferred in the last 90 days | No |
| `6` | Personal property | No |
| `8` | Vehicle | No |
| `10` | Resources shared with someone outside the household | No |

The following **Other Property - Liquid Assets** page used `form#answerSet` posting to `simple`. The operator selected the fictional primary person with `answerSets0.personSelection`, chose **Cash/Uncashed Check** at question index `0`, and entered current value **50** at index `1`. Optional amount owed (`2`), account/policy (`3`), bank name (`4`), and acquisition date (`12`) remained blank. The no-ID ordinary Next button used `submitAction();return false;` and was accepted.

**Liquid Assets Summary** confirmed **Cash, 50**. Its route was `/applyForBenefits/addressValidationDQfuncPage`, despite being a financial summary rather than a home-address selection page. This reinforces that names within URLs cannot determine page purpose or adapter eligibility. **Save and Continue** loaded **Property Summary** at `/applyForBenefits/dynamicQuestions`, where the reported answers were confirmed. Continuing that summary reached the **Other** introduction, section **6 of 7**.

No real asset, account, policy, or bank data was entered. Non-liquid-property, trust, transfer, personal-property, vehicle, and shared-resource detail branches were not explored. The fictional cash value was an explicit manual answer; it was not inferred from other fields.

### Household relationships and other information

After the **Other** introduction, **Household Relationships** at `/applyForBenefits/personRelationshipRender` had no other household members or answer inputs on the single-adult path. Ordinary Next loaded **Other Information** at `/applyForBenefits/dynamicQuestionsResume`. The operator explicitly answered **No** to these six topics:

| Question index | Topic, paraphrased |
| --- | --- |
| `0` | Aging out of foster care |
| `2` | Homelessness |
| `6` | SNAP disqualification |
| `10` | Iowa EBT |
| `11` | Incarceration |
| `14` | Authorized representative |

**Other Information Continued** at `/applyForBenefits/dynamicQuestions` received explicit **No** answers for five more topics:

| Question index | Topic, paraphrased |
| --- | --- |
| `0` | Benefits from another state |
| `3` | Fugitive or parole status |
| `5` | SNAP sale over $500 |
| `6` | Duplicate benefits |
| `7` | Trading SNAP |

These are abbreviated topic descriptions, not exact question wording or legal interpretations. The answers apply only to the fictional QA scenario. No production inference or automatic answer mapping is established for these sensitive questions. The operator reviewed **Other Summary** and used ordinary Next.

### Final section and legal information

The **Submit Application** introduction identified section **7 of 7**. Its ordinary Continue led to **Voter Registration** at `/applyForBenefits/thirdPartyDetails`. The operator explicitly chose **No** using `#falseRadio1`, then used ordinary **Save and Continue**.

At `/applyForBenefits/iaReminderAboutYourRights`, the page offered only Continue and stated that signing later acknowledges rights. There was no checkbox. The first Continue attempt reported that **Legal Information** must be reviewed. The operator opened `#legallinkId`, linking to the official [Legal Information PDF](https://hhs.iowa.gov/sites/default/files/RC-0120.pdf), in a new tab. The PDF redirected to Iowa's media-download endpoint. No separate acknowledgment was made. Ordinary Continue then loaded **E-Signature**.

### Untouched E-Signature page

The final observed page was `/applyForBenefits/eSignature`, with an **E-Signature** H2 and `form#representativeForm` posting to `eSignature`. Observed final controls were:

| Control | Observed state | Handler, where reported |
| --- | --- | --- |
| `#checktoSign`, name `sign` | Unchecked | `onCheckToSignChange(this.checked)` |
| `#signature`, name `signature` | Empty | Not recorded |
| `#role`, name `role` | Default **Applicant**, untouched | Not recorded |
| `#submitAnchorId`, label **Submit Application** | Disabled; not clicked | `submitApplication(); return false;` |

No click, checkbox change, signature entry, role change, or other field edit was made on this page. The tab was handed back to the user.

## Final boundary and validation limits

The live journey ended at the untouched **E-Signature** page. Earlier approved answers were sent to Iowa and may persist in a server-side draft; stopping before submission does not mean those answers remained local. There was no certification, signature, final submission, receipt, confirmation number, or eligibility result.

This establishes one manually traversed fictional guest path, including selected housing, utility, and cash branches. It does not establish complete application coverage, other household or eligibility branches, actual submission behavior, or an end-to-end test of the SecondHand extension and native bridge. Only controls and outcomes expressly recorded above were observed. Existing production coverage must still be judged against its own code, explicit allowlists, and tests.
