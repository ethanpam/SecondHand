# Autofill autopilot: design

Date: 2026-09-26 · Branch: `extension-refinement` · Builds on `2026-09-26-one-click-autofill-design.md`

## Goal

One Autofill click keeps working across Iowa's application for that tab:
- It fills what it can.
- It clicks Continue on screens that are information only.
- It stops with a plain instruction wherever you're needed: CAPTCHA, consent, missing information, or checking answers before Save and Continue.

## Decisions

| Topic | Decision |
| --- | --- |
| How far it goes | It fills answers and clicks Continue on info-only screens. It never clicks Save and Continue, Submit, or anything on consent or CAPTCHA screens. |
| Scope | Per tab. On from the first Autofill click until Stop, vault lock, leaving Iowa, the tab closing, or an unknown page. |
| Where state lives | Worker memory only. A page can never turn it on. Losing the worker turns it off, and the widget says so. |

## Page registry (adapter)

`probePage` classifies each screen by its visible heading and its exact controls. It returns `kind` plus optional `continueTarget`, `fields`, and `todo` (a fixed instruction):

| Screen (visible heading) | Kind | Recorded controls (live, 2026-09-26) | Autopilot does |
| --- | --- | --- | --- |
| Household Application Information | `fill` | `form#householdApplicationForm[action=selectHouseholdInfo]`; radios `#householdApplyProgYes` (value `true`) and `#householdApplyProgNo` (value `false`), name `householdApplyProg`, `onclick="toggleCaptcha();"`; Continue runs `validateMsg()` | Picks Yes if any saved program (SNAP, FIP, Medicaid) is `yes`; otherwise the question needs you. Picking an answer reveals the CAPTCHA, so it then stops with "Solve the CAPTCHA, then click Continue." |
| Before You Start... | `info` | `button.saveButton` "Continue", `onclick="submitUrlLink('letsGetStarted');return false;"`; no visible controls | Clicks Continue |
| Let's get started | `you` | `#termChkbox` in `form#welcomeForm[action=forceLogin]`; Continue runs `welcomeSubmit()` | Stops: "Read and accept Iowa's consent, then click Continue." |
| Important Information when applying and what to expect. | `info` | Continue `submitUrlLink('instructions')`; no visible controls | Clicks Continue |
| Instructions | `info` | Continue `submitUrlLink('aboutYou')`; only illustration controls with no id or name | Clicks Continue |
| About you | `info` | Recorded during implementation | Clicks Continue |
| Assisting Organization or Person | `you` | Recorded during implementation | Stops: "If nobody is helping you, leave this blank and click Continue." |
| Enter Personal Information | `fill` | Unchanged mapping | Fills, then stops: "Check your answers, then click Save and Continue." |
| Select Address | `you` | Unchanged | Stops: "Pick the correct address, then click Continue." |
| Anything else | `unknown` | — | Stops and turns autopilot off: "SecondHand doesn't know this page yet." |

An info screen's Continue qualifies only if it is:
- visible and enabled;
- a `button.saveButton` whose text is exactly "Continue";
- the only such button;
- carrying exactly the recorded `onclick` for that heading.

The page must also have no visible named form controls outside the language menu. Illustration controls with no id and no name are ignored.

Adapter additions:
- `continuePage(doc, url)` re-verifies all of the above immediately before clicking, then clicks once.
- A household definition key `householdApplyProg` whose value is derived from the saved program choices. The worker computes it; the adapter only receives `yes` or `no`.

## Worker autopilot

`autopilot: Map<tabId, { on, visited: Set<url|pageKey>, steps }>`.

- `ui:autofill` turns autopilot on for the tab and runs one step.
- `ui:stop` turns it off.
- A step runs on `tabs.onUpdated` with `status === 'complete'` for an on tab, and on each widget `ui:pageState` poll when the page's `url|pageKey` hasn't been handled in this run.

Each step:
1. **info:** asks the content script to run `continuePage`. The `url|pageKey` is added to `visited` first, so each page gets at most one click per visit.
2. **fill:** runs the existing one-click autofill for that page. Then `result.state = 'waiting'` with `todo = "Check your answers, then click Save and Continue."`, or the CAPTCHA text on the household page.
3. **you:** sets `waiting` with the page's `todo`.
4. **unknown:** turns autopilot off with the "doesn't know this page yet" message.

Stop conditions:
- 15 steps per run.
- Vault locked: autopilot off, `locked` state.
- Desktop offline: off.
- The tab leaves the portal or closes: off.

A new page load after a waiting page resumes the next step automatically.

## Widget

- While autopilot is on, the widget shows a **Stop** button next to the status line.
- The status line shows the current step's `todo` or result ("Filled 12 · 1 need you · Check your answers, then click Save and Continue").
- The content script sizes the widget by page kind. It is full size on every registry screen (`fill`, `info`, `you`), so you can start Autofill from the first application screen and read its instructions. It is a pill on other portal pages.
- The pill is a fixed 46×46 circle, so it can't stretch into an oval.

## Testing

- **Adapter:** each registry row classifies correctly from sanitized fixtures. `continuePage` clicks only the exact button and refuses decoys, duplicates, and wrong handlers. It refuses on consent and CAPTCHA pages. The household answer is derived only from an explicit Yes.
- **Worker:** a multi-page walk with auto-continue on info pages; stops on fill, you, and unknown pages; resumes after a navigation; Stop; lock; the step cap; no double click on the same page.
- **Smoke:** a synthetic multi-page flow in Chromium (Before You Start → Important Information → Instructions → applicant page) runs from one click and stops at the applicant page with fields filled and Next not clicked.
