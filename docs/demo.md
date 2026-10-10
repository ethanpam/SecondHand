# Presenting SecondHand

A runbook for a live demo of about five minutes. Everything on screen is the fictional applicant Avery Example
from `tests/fixtures/applicant-profile.json`. Nothing is ever submitted.

## The day before

1. **Use a computer you can share on screen.** Make a new Chrome profile just for the demo (Chrome menu →
   Profiles → Add), so no bookmarks, sign-ins or history of your own show. Chrome 116 or newer.
2. **Run the app from this checkout** (`npm ci`, then `npm start`) until a release newer than 0.5.0 is on the
   download site. The 0.5.0 download predates the fixes for ad-heavy pages and household tables listed below.
3. **Make the demo data.** `npm run demo:backup` writes `artifacts/demo/secondhand-demo.secondhand` and prints
   its password. In the app's password screen choose **Restore an encrypted backup**, pick that file, and
   unlock with the printed password. My information now holds Avery Example and a household of four. If the
   app already has your own information, export a backup of it first (Privacy & backups) and restore it after.
4. **Connect Chrome** in the demo profile: **Chrome extension → Prepare Chrome extension**, then Load unpacked
   in `chrome://extensions` ([setup guide](setup.md#set-up-chrome-once)). Pin the SecondHand icon to the toolbar.
5. **Turn SecondHand on for all websites**: open any form below, click the SecondHand icon, choose
   **Use SecondHand on all websites**, and allow it in Chrome and in the app.
6. **Decide on approvals.** The app asks before any answer leaves it. Showing that pop-up once is a good
   privacy moment; after that, **Always allow on this computer** (Chrome extension page) keeps the demo moving.
   Turn it back off afterwards.
7. **Rehearse once** with the forms below, then reload each tab so they start empty.

Open these tabs in order before you start:

| Tab | What it shows |
| --- | --- |
| The SecondHand app, on My information | Details saved once, on this computer, behind a password |
| [CSI Food Pantry appointment (Google Forms)](https://docs.google.com/forms/d/e/1FAIpQLSePpl2_E4U4RduWCqiB5M6h5rH3LVFPFKGsgNc2mLdwDOLT7Q/viewform) | A real pantry form: email, name, phone and household size in one click |
| [Food bank registration (Jotform template)](https://www.jotform.com/form-templates/food-bank-registration-form) | A long intake: 11 answers, address and household counts, and a household table |
| [Student registration practice form](https://demoqa.com/automation-practice-form) | Any website: a form SecondHand has never seen |
| [Wikipedia: SNAP](https://en.wikipedia.org/wiki/Supplemental_Nutrition_Assistance_Program) | No form, no card: SecondHand stays out of the way |

## Run of show

1. **The problem (30 s).** Every program asks the same questions again: who you are, where you live, who lives
   with you, what you earn. People who have the least time copy it over and over.
2. **Save it once (45 s).** In the app, scroll My information: name, address, phone, household. Point out
   *Stored on this computer*: an encrypted file, no account, no cloud, no analytics.
3. **A real pantry form (60 s).** Google Forms tab. The card in the corner says the site is ready. Click
   **Autofill**. Four answers fill with a green outline, and the card says *Filled 4 answers. Check them before
   you submit.* Click **5 questions left** to jump to what still needs the applicant.
4. **A long intake (60 s).** Jotform tab. One click fills 11 answers, including the address and how many
   adults and seniors live there. In the household table only the first row gets Avery's name; the other rows
   stay empty, because SecondHand never guesses who another row is.
5. **Any website (45 s).** Practice form tab. It fills name, email, mobile number and address on a form it
   has never seen. Gender and hobbies stay for the applicant.
6. **Stays out of the way (15 s).** Wikipedia tab: no card on a page without a form.
7. **The side panel (30 s).** Click the SecondHand icon: what was filled, each question left, and a way to
   turn SecondHand off for a site.
8. **Close (15 s).** The applicant always reviews, signs and submits. SecondHand fills, they decide.

Keyboard: **Alt+Shift+F** (Option+Shift+F on a Mac) runs Autofill on the page in front.

## Forms checked before a demo

`npm run qa:any-website -- <label>` opens each of these in a throwaway browser with the fictional profile and
clicks Autofill once ([extension QA](extension-qa.md#live-sweep-of-everyday-websites)). On 10 October 2026 it gave:

| Form | Filled | Left for the applicant |
| --- | --- | --- |
| CSI Food Pantry (Google Forms) | 4 | 5 |
| Hornets Market pantry (Google Forms) | 3 | 9 |
| Food insecurity intake (Jotform) | 7 | 8 |
| Food bank registration (Jotform template) | 11 | 28 |
| Student registration practice form | 5 | 6 |
| Pizza order sample (httpbin) | 3 | 4 |
| Food Bank of Iowa page | 3 | 4 |
| Input form demo (LambdaTest) | 5 | 5 |
| Wikipedia, BBC News, USDA SNAP, usa.gov | no card | |

Run it again the morning of the demo: third-party forms change without notice.

## If something goes wrong

- **No card on a form:** the app must be running and unlocked. Click the SecondHand icon; the side panel says
  what is missing (locked, site off, or the page needs a reload).
- **The card says to reload:** the extension was updated while the tab was open. Reload the tab.
- **No internet:** play the recordings instead: `docs/media/autofill.gif` and `docs/media/same-answers.gif`, or
  `website/public/demo/autofill.mp4`.
- **A pop-up in the app asks to share answers:** that is the privacy check. Click **Allow once**.

## Afterwards

Lock SecondHand, turn **Always allow** back off, and restore your own backup if you replaced it. Remove the demo
Chrome profile if you no longer need it.

## Say it straight

- SecondHand is an independent pilot, not part of Iowa HHS, and it doesn't decide who qualifies.
- It fills what it is sure of and leaves the rest. Gender, signatures, consent, uploads and final Submit are
  always the applicant's.
- A complete live submission on Iowa's portal has not been validated end to end.
