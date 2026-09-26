# Iowa SNAP sources

Research reviewed **September 26, 2026**. These are official Iowa HHS sources used to scope this prototype. Agency notices and current instructions govern an individual case. App dates and statuses are user-entered, with no agency synchronization.

## Official destinations

| Resource | Link |
| --- | --- |
| Iowa HHS Self-Service Portal | [Open the portal](https://hhsservices.iowa.gov/apspssp/ssp.portal) |
| How to apply for SNAP | [Application guidance](https://hhs.iowa.gov/assistance-programs/food-assistance/snap/apply-snap) |
| SNAP program and case contact | [SNAP overview](https://hhs.iowa.gov/assistance-programs/food-assistance/snap) |
| SNAP questions | [SNAP FAQ](https://hhs.iowa.gov/assistance-programs/food-assistance/snap/faqs) |
| Recertification form 470-2881, revision 04/26 | [Review/Recertification Eligibility Document](https://hhs.iowa.gov/media/4862/download) |
| Application form 470-0462, revision 05/25 | [Food and Financial Support Application](https://hhs.iowa.gov/media/4531/download) |
| Employee manual 7-B | [SNAP Application Processing](https://hhs.iowa.gov/media/3994/download) |
| Employee manual 7-G | [SNAP Case Maintenance](https://hhs.iowa.gov/media/3999/download) |
| Portal navigation help | [HHS Self-Service Portal help](https://hhsservices.iowa.gov/apspssp/pages/WebHelp/acssp_home_page.htm) |
| General renewal-page help | [Renew My Benefits help](https://hhsservices.iowa.gov/apspssp/pages/WebHelp/renew_my_benefits.htm) |

Links to downloadable forms may serve newer revisions later. Check the revision on a downloaded form before relying on it.

## Renewal dates and requirements

The 7-B manual, printed page 19, revised January 30, 2026, describes 12-month certification when all adults are at least 60 or disabled and the household has no earned income; other households generally receive six months, with certain four-month exceptions. This supports storing notice dates rather than generating annual renewals. The approval notice gives the certification start and end dates. [7-B manual](https://hhs.iowa.gov/media/3994/download)

The 7-G manual, printed pages 38–40, requires a recertification application, an interview when required, and requested verification. It accepts a Review/Recertification Eligibility Document (RRED) or an Iowa SNAP application. It calls receipt by the 15th of the final certification month timely filing. Other requirements still matter for uninterrupted benefits. Some households are exempt from routine recertification interviews; other households must have an interview at least every 12 months. The app should track tasks without deciding that an interview is required or complete. [7-G manual](https://hhs.iowa.gov/media/3999/download)

The RRED's first page has distinct benefits-end and return-by dates, an interview checkbox, and the worker's contact and return instructions. It lists return by mail, email, fax, or local office. Its second page tells users not to delay returning the form while collecting documents, and to provide copies. The notice's dates and instructions are the best input for the tracker. [RRED, pages 1–2](https://hhs.iowa.gov/media/4862/download)

No generic Iowa SNAP interim-report schedule was verified in this research. The 7-G manual instead describes simplified reporting of certain changes during certification. The app does not generate an interim-report deadline; it tracks the renewal and follow-up dates the user enters from their notice. [7-G manual, printed page 1](https://hhs.iowa.gov/media/3999/download)

Suggested interface wording: **“Enter the return-by date on your Iowa HHS renewal notice. Renewal timing depends on your household.”**

## Application and renewal portal limits

Iowa HHS recommends its Self-Service Portal for applications. Users may also apply through a local office or a paper form. The application guidance describes an interview and possible requests for additional documents. A form submission and an eligibility decision are separate events. [How to apply](https://hhs.iowa.gov/assistance-programs/food-assistance/snap/apply-snap)

The portal advertises draft saving and access to submitted applications for all programs. Its current public home page lists viewing benefits, renewing benefits, reporting case changes, and electronic notices as **Medicaid-specific** features. Therefore, the generic “Renew My Benefits” help page does not establish that the corresponding account feature supports SNAP. We have not verified a dedicated SNAP online renewal route with an authenticated case. [Portal home page](https://hhsservices.iowa.gov/apspssp/ssp.portal), [general renewal help](https://hhsservices.iowa.gov/apspssp/pages/WebHelp/renew_my_benefits.htm)

The public portal contains verification-code prompts and warns that guest data can be lost after navigating away or 15 minutes idle. It also warns about opening the same application in multiple browsers. User-controlled sessions and review are necessary for this prototype; background submission cannot be promised. [Portal home page](https://hhsservices.iowa.gov/apspssp/ssp.portal)

## Form clues and autofill validation

The paper application includes contact information, household members, income, and expenses. These are useful clues for the app's data model, but paper labels do not establish live browser field identifiers. Signatures and attestations stay with the user. [Application form](https://hhs.iowa.gov/media/4531/download)

The publicly accessible account signup page includes name, date of birth, and SSN. It says this information manages the online profile; it is not evidence of SNAP application-field mappings. The extension must not treat account signup, login, recovery, or verification forms as application pages. [Account signup](https://hhsservices.iowa.gov/apspssp/ssp.portal/login/personalInfoSignup)

The implemented matcher uses conservative field semantics and local test fixtures. It has not been validated against an authenticated Iowa SNAP application or renewal. Only a user-approved contact snapshot may be filled. Unknown or ambiguous fields should remain for manual completion; eligibility answers, signatures, passwords, verification codes, and submission are outside scope.

Future portal validation should use an authorized testing arrangement and verify the exact live field labels, repeated-person sections, accessibility names, page navigation, error handling, and portal changes. This research created no account and submitted no application.

## Help

- SNAP case questions and reporting changes: **877-347-5678**, listed on the [SNAP overview](https://hhs.iowa.gov/assistance-programs/food-assistance/snap).
- General help applying: **800-972-2017**, listed in [application guidance](https://hhs.iowa.gov/assistance-programs/food-assistance/snap/apply-snap).
- For a renewal, use the worker and return instructions printed on the user's notice. The app should direct people there without guessing a case-specific deadline or destination.
