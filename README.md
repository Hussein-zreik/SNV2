# SNV2 — RN rotating shift scheduler

A duty roster for a hospital ward: about 19 RNs plus support staff, in two-week cycles.
The nurse manager builds the roster; the app keeps every rule it can and says plainly
when one cannot be kept.

It is a single web page with no server of its own. It runs in the browser, keeps a copy
of the roster on each device so it also works offline, and syncs to the manager's own
Firebase account.

**Live:** https://hussein-zreik.github.io/SNV2/ (sign in with the manager account)

## What it does

- **Generates the fortnight** around the requests you enter, in Auto or Manual mode, in
  one go or part by part (Settings → Generate).
- **Keeps the rules, in priority order:**
  1. every RN works exactly their weekly split (Group A 4 then 3, Group B 3 then 4);
  2. weekday staffing minimums per shift;
  3. nights at the N7 minimum, from a rotating night turn;
  4. no more than 3 days in a row and no weekend surplus, where that costs no duty.
- **Requests and leave** (Req off, Day off, Holiday, Vacation, Sick leave) with a reason,
  and a request report to Excel.
- **Staff request link:** staff send a day-off request with a reason from their phone;
  you read them in **Staff requests**. Nothing they send changes the roster by itself.
- **Lock** a published fortnight as a view-only record.
- **Reports:** monthly duties, a fairness dashboard (nights, weekends, holidays per
  nurse), leave balances, and PDF/Excel exports of everything.
- **Two devices at once:** edits from different devices are merged; if both changed the
  same cell, the later one wins and both devices are told.

How the night and weekend turns rotate: [NIGHT_SHIFT_ROTATION.md](./NIGHT_SHIFT_ROTATION.md).

## Setting it up

The cloud side is a Firebase project you control. Creating the manager account and
publishing the security rules are done by hand in the Firebase console; follow
[SECURITY.md](./SECURITY.md) step by step. It also says what is protected and what is not.

**Back up regularly:** Cloud → **Export**. Cloud sync is not a backup: a wrong change
syncs everywhere, and the export file is how you get back.

## For developers

```bash
npm ci                 # dev tools only; the app's libraries are already in vendor/
npm run lint           # bug-catching rules only
npm run test:unit      # engine tests (in two timezones) + library and security-policy checks
npm test               # the app in headless Chromium
npm run test:cloud     # security rules, sign-in, sync and the staff link, in the
                       # Firebase emulators (needs Java 11+)
```

| File | What it is |
|---|---|
| `index.html` | The app: markup, styles and the whole UI in one file |
| `engine.js` | The scheduler itself, with no UI, unit-tested in Node |
| `request.html` | The staff request page |
| `firestore.rules` | Who may read and write what in the database |
| `vendor/` | Excel, PDF and Firebase libraries, checksummed copies of the npm files |
| `test/` | `engine.test.mjs`, `vendor.test.mjs`, `audit.mjs`, `cloud.mjs` |

[CLAUDE.md](./CLAUDE.md) explains the architecture, the scheduling rules and their
conflicts, and what to check before changing anything. CI
(`.github/workflows/test.yml`) runs all of the above on every pull request.

**Whatever is on `main` is what the ward uses.**
