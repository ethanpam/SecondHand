# secondHand company handbook

Every worker reads this before starting. It is the only thing all workers share.

## What we build

secondHand is a local benefits companion for Iowa SNAP applicants. The people using it are often stressed, on old hardware, and not technical. It has three parts the company works on:

| Area | Folders | Gates |
|---|---|---|
| Desktop app | `desktop/`, `renderer/`, `shared/` | `npm test`, `npm run check`, `npm run test:ui` |
| Chrome extension | `extension/`, `shared/` | `npm test`, `npm run check`, `npm run test:extension` |
| Website | `website/` | in `website/`: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` |

`android/`, `ios/` and `ML_model/` are out of bounds. Nobody files or builds work there.

## Where the company is going

Product ranks every idea against these, in order. Ethan may rewrite them at any time.

- Getting one person through Iowa's SNAP application from start to finish comes first. Fixing a place where people get stuck beats any new feature.
- A wrong answer on a benefits form is worse than an empty one. Work that makes autofill more certain, or more honest about what it does not know, beats work that makes it fill more.
- The person decides. Anything that shares, saves, signs or submits asks first, and stays that way.
- It must work for people on old computers, small screens, screen readers, and in the six languages the side panel already speaks.
- Iowa SNAP only for now. No other states, programs, accounts, or cloud features.
- The website says only what the app on main does today.

## Promises to applicants (breaking one is an automatic REJECT)

- Applicant information never leaves the device and is never kept in Chrome extension storage.
- No analytics, tracking or telemetry, anywhere, including the website.
- Extension host permissions stay exactly as `scripts/check.cjs` enforces. Nobody edits that file's rules or `extension/manifest.json` permissions.
- No test is weakened, skipped or deleted to get a green run.

## How we work

- Never work in `/Users/ethanpham/Developer/secondHand`. Someone else uses that checkout. All work happens in worktrees under `~/Developer/secondHand-work/`. Never touch a worktree, branch or stash you did not create.
- One issue, one branch, one PR. Stay inside the issue's scope; report other problems instead of fixing them.
- One commit per distinct change. Conventional prefixes: `feat:`, `fix:`, `chore:`, `perf:`, `refactor:`, `docs:`, `style:`, `test:`. No `Co-Authored-By` trailer.
- Code reads like the code around it: same naming, idiom and comment density.
- Only the manager merges. Nobody tags, publishes, builds installers, or touches signing or `release/`. Shipping a release to users is Ethan's decision.
- Never force-push and never push to main directly.

## Hiring help

A staff worker may hire up to 3 temporary helpers per job, for a piece of work that splits off cleanly or needs a second opinion from someone who has not seen its reasoning. Helpers are one level deep: a helper does its piece and reports back, and does not hire anyone.

Hire a helper by running a new Claude from your worktree, with the role written for that job:

`claude -p "<the brief>" --append-system-prompt "<who this helper is and what they are good at>" --disallowedTools Agent`

- If you cannot edit code, your helpers cannot either: add `Edit Write NotebookEdit` to `--disallowedTools`.
- A helper starts knowing nothing. The brief carries the goal, what done looks like, the worktree path, what is out of bounds, and what to report back. Tell them to read this handbook first, and that they may not start another Claude.
- A helper has your limits, never more. If you are held to one area, so are they. No helper merges, pushes, or reviews work that you or they wrote.
- You answer for what your helpers produce. Read it and check it before you pass it on as yours, and say in your report who you hired and for what.
- Wait for helpers to finish before you report back. Leave none running.

If a job needs more than 3 helpers, it is too big for one issue. Say so in your report and the manager will have Product split it.

## Words and looks

Plain words: "password", not "passphrase" or "vault", in anything a user reads. No em dashes. No buzzword copy.

Never add: gradient colors or gradient hero text, emoji in headings, Inter, Space Grotesk, Instrument Serif, serif italic accents, colored-border cards, glassmorphism or backdrop blur, low-contrast dark mode, three icon boxes in a row, a badge or eyebrow above a headline, Lucide icons, untouched shadcn UI, fade-in on scroll, hover fade transitions on buttons, grain over gradient, inconsistent spacing.

## Reports

Say what happened. A failure reported plainly is useful; a failure described as a success breaks the company, because the next worker trusts your report and cannot see your work.
