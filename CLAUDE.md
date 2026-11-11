# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A nursing rotating-shift scheduler for a hospital ward, used by a nurse manager to build
a 2-week duty roster for ~19 RNs plus support staff. It is a static site — no build step,
no server. `index.html` is opened directly (or served by GitHub Pages from `main`), so
**whatever is on `main` is what the ward is using.**

## Commands

```bash
npm install            # devDependencies only; the app's own libraries are checked in under vendor/
npm run lint           # ESLint — bug rules only, never style (see eslint.config.mjs)
npm run test:unit      # 54 engine unit tests (twice: local time + Los Angeles) + 27 vendor/policy checks, ~2s
npm test               # 168 checks driving the app in headless Chromium, ~70s
npm run test:cloud     # 170 checks of firestore.rules, sign-in, roster sync + the staff link, in the
                       # Firebase emulators (needs Java 11+; downloads firebase-tools via npx)
```

Run the first three before committing, and `test:cloud` as well after touching
`firestore.rules`, `request.html` or the cloud code in `index.html`; CI
(`.github/workflows/test.yml`) runs all four on
push to `main` and on PRs, after `npm ci` — `package-lock.json` is committed, so update it
(`npm install`) in the same commit as any `package.json` change.

There is no test-name filter. To run one case, comment out the others in
`test/engine.test.mjs`, or write a throwaway script that imports `engine.js` directly —
it is a CommonJS module in Node, so `import Engine from './engine.js'` works.

**Throwaway diagnostic scripts must live inside the repo**, or Node cannot resolve the
`playwright` package from `node_modules`. `.gitignore` already covers `_*.mjs` and
generated `*.png`/`*.pdf`/`*.xlsx`, so name scratch scripts `_something.mjs`, keep them at
the repo root, and delete them when done.

**Browser for ad-hoc Playwright scripts:** if `chromium.launch()` fails, pass
`{ executablePath: '/opt/pw-browsers/chromium' }` — this is what `launch()` in
`test/audit.mjs` already does. Never run `playwright install` here.

**Libraries are served from `vendor/`, not a CDN** (audit H5). ExcelJS, jsPDF,
jspdf-autotable and the Firebase compat SDK are exact copies of the published npm files;
`vendor/manifest.json` records package, version and checksum, and `test/vendor.test.mjs`
fails if a file changes or a page loads a script from another site. To update one: copy the
new file from the npm package, set its version in the manifest, run
`node test/vendor.test.mjs --write`, and keep the `firebase` devDependency on the same
version (the cloud tests run those very files). So in the audit the real Excel and PDF
writers run; only the Firebase files are withheld there (`/vendor/firebase-` is aborted).

**Both pages carry a Content-Security-Policy `<meta>`.** Nothing loads or connects unless
it is listed: scripts from this site only, connections to `*.googleapis.com` only. If you
add a resource from somewhere new it will be blocked — and shown in the red problem
banner — until the policy lists it. `index.html` needs `'unsafe-inline'` for its inline
`onclick` handlers, so there the policy limits where data can go rather than what can run.
`request.html` has no inline handlers: its single inline `<script>` is allowed by checksum,
so **after any edit to that script run `node test/vendor.test.mjs --write`** or the page
stops working (the test catches it). Do not use `eval`/`new Function` anywhere.

## Architecture

Three files matter.

### `engine.js` — the pure scheduler (~430 lines)

DOM-free and global-free. Every function takes an explicit `ctx` (documented in the header
comment), which is why it can be unit-tested in Node in milliseconds instead of only
through a browser. Dual-mode: CommonJS in Node, `window.Engine` in the browser, where it
also exposes the pure date/RNG helpers as bare globals.

**Put scheduling logic here, not in `index.html`.** `index.html` holds thin adapters
(`schedCtx()`, and wrappers around `computeSchedule`/`turnFor`) that build the `ctx` from
live app state.

`<script src="engine.js">` is **not** deferred and must stay above the inline `<script>`,
which runs immediately and calls into it.

### `index.html` — everything else (~3.4k lines)

One deliberately dense file: markup, CSS custom properties, and the whole UI layer in a
single inline `<script>`. Splitting it has been considered and rejected. Two consequences:

- **Functions must be global.** ~190 of them are called only from inline `onclick=""`
  handlers, which ESLint sees as text — hence `no-unused-vars` is off. Do not convert one
  to a `const` arrow or scope it inside another function.
- **No formatter.** Prettier would produce an unreviewable diff and fight the intended
  compact style. ESLint is scoped to catch bugs a human misses in a file this size
  (typos, duplicate object keys, unreachable code), not to enforce layout.

### `test/`

`engine.test.mjs` is the fast net over scheduling rules. `audit.mjs` drives the real app
in Chromium and covers what the engine cannot: persistence, the state registry, undo,
import/export, the merge function, and "no page errors". `cloud.mjs` covers what needs a
database: the security rules caller by caller, sign-in, two devices syncing and clashing,
and the staff request link through both pages.

## The three ideas you need before changing anything

### 1. `PERSIST` — the state registry

A single declarative array near the top of the inline script is the source of truth for
every piece of persisted state. Each entry declares `get`/`apply`/`set` accessors and
membership flags `sync` (goes to the cloud), `device` (local only), `undo` (captured by
snapshots).

It drives `saveState`, `cloudStateObj`, `applyStateObject`, `snapshot` and `restore` at
once. **Adding new persisted state means adding one row here — nothing else.** Forgetting
it means the field silently fails to sync or to undo; the audit's registry round-trip
section catches that.

**Loaded state is untrusted.** localStorage, a backup file and the cloud document can all
have been written by someone else, and state values reach the page (cell text, CSS
classes, inline `onclick` strings). `sanitizeState()` is the one boundary: it runs at the
end of `applyStateObject()` and of `restore()` and drops anything that is not the expected
shape (ISO date keys, `ID_RE` ids, `CODE_RE` shift codes, numeric balances and minimums).
It checks format, not membership, so a grid holding a since-deleted custom shift keeps it.
A new persisted field needs its row in `PERSIST` **and** its shape in `sanitizeState()`;
anything interpolated into HTML still goes through `escapeHtml()`. The audit's "loaded
data cannot inject" section feeds hostile values through every field.

**Undo history is stored as deltas.** `history` entries are `{t,label,snap,d?}`. Only the
newest holds a full `snapshot()`; `pushHistory()` seals the previous one (`d:1`) into
`snapDelta()` — just the fields, and inside date-keyed maps just the keys, that action
changed (`{$patch:{set,del}}`), which `restore()` applies. 100 full copies used to fill
the browser's ~5 MB storage after ~8 months, and saves then failed silently. So: take the
snapshot **before** mutating, call `pushHistory` once per action, and end the action with
`saveState()`. `saveState()` keeps history within `HIST_BYTES`, drops the oldest undo
steps first if storage is full, and shows the `#saveWarn` banner if a save still fails —
never swallow a storage error.

### 2. `overrides` are locks; `frozen` is a baked grid

- `overrides[iso][id]` is what the manager typed in. The generator places these and
  **never** overwrites them. They are applied both before and after generation.
- `frozen[cycleMonday][id]` is a whole fortnight baked at Generate time, so later edits
  change only the edited cell instead of cascading through the roster.

`frozen` takes priority over recomputation and returns early. **This is the usual cause of
"I changed a rule and the grid didn't update."** The remedies already exist: `regen()`
drops `frozen`/`cycleSeeds` for the visible cycle, `rebuildAllCycles()` drops them all, and
`clearCycle()` wipes a fortnight completely.

A cycle is keyed throughout by `cycleStartISO(off)` — the ISO date of its Monday.

### 3. Shift types live in several places at once

Adding or changing a shift/leave type touches a fixed set of sites. Follow the existing
`SL` (sick leave) or `VAC` entries as the template:

- CSS custom properties in **three** blocks — dark `:root`, `[data-theme=light]`, and the
  `@media print` override
- `.b-XX` (legend badge), `.sc.s-XX` (grid cell), `.mbtn[data-s=XX].sel` (cell editor)
- the legend markup, and `CORE_LABELS`
- the reserved-code sets in `ensureCustomShifts()` and `addCustomShift()`
- `rebuildShifts()` — `ENTRY_TYPES`, `ALL_TYPES`, `REQ_TYPES`, `SHIFT_GROUPS`
- exports: `XL_PAL` (light **and** dark) and `PDF_COL`
- the tracker, the monthly report, and the fairness dashboard if it should be counted
- `engine.js` if it affects the duty quota — a leave type that replaces a duty is listed
  alongside `VAC`/`HOL`/`SL` in `assignWeek`

`WORK_TYPES` means "staffs a shift". `ENTRY_TYPES` means "counts toward the 7 per
fortnight". Leave is an entry but not work.

## Scheduling rules, and the conflicts between them

The rules, **in priority order** — set by the ward's nurse manager. A lower rule always
gives way to a higher one:

1. **The 4/3 · 3/4 split is the golden rule.** Every RN, night-turn nurses included,
   works exactly their weekly count — Group A 4 then 3, Group B 3 then 4 — strictly per
   week (never 5 + 2). If a nurse is under their count, they don't get paid. The manager's entries count toward it (duties, and
   Hol/Vac/SL, which replace a duty), so only the difference is added.
2. **Weekday staffing minimums** per shift type.
3. **Nights at the N7 minimum** (default 2). The night turn is `size` RNs from Group A on
   `NA_DAYS` and `size` from Group B on `NB_DAYS`; turns *tile* the night list and reroll.
   A turn nurse gets nights **only up to their weekly count**, so a manual day duty costs
   them a night (the one the evening before it goes first — no night→day turnaround).
   The lost night is then handled in this order:
   - if the manager already staffed that night by hand (another RN's `N7` entry), the
     turn nurse is simply handed day duties instead;
   - otherwise it is **backfilled** from the same group's night list: an RN off the
     night and weekend turns, free that night, with room in that week's split, and no
     locked day duty the next morning;
   - if nobody fits, the night is left short and the banner says so.
4. **Everything else, only where it costs no duty** — ≤3 consecutive days (also across
   the cycle seam), no weekend surplus. **4 in a row is allowed** when it is the only way
   to reach the count (e.g. a Monday or Friday off in a 4-duty week leaves Tue–Fri); the
   banner reports it. Before calling a 4-day run a defect, check that nurse's entries —
   every remaining one in the request sweeps is forced by them.

Never a day duty the morning after a night, in any pass.

**Entries are never moved or removed.** A week the manager over-fills by hand (e.g. 5
duties in a 4-duty week) is kept as entered, nothing more is added to it, and the banner
shows a red `RN: 5 duties in week 1 (max 4)`.

**Edits on a generated (frozen) fortnight** differ by mode:
- **Auto mode:** the edit becomes an entry and `Engine.rebalanceRow()` brings **only that
  nurse's row** back to the split (removing or adding app-made duties in the same week).
  A night it drops is **not** backfilled — it shows as short for the manager.
- **Manual mode:** the cell is changed exactly as typed, with no rebalancing.

**Partial Generate (Settings → Generate, Manual mode only).** Ticks for Weekdays /
Weekends / Nights (`genParts`, synced). A cell's part comes from `Engine.partOf()`. The
first Generate **plans the whole fortnight once** (`Engine.planFortnight`) and shows only
the ticked parts (`pickParts`). The full plan is kept in `genPlan[cycleMonday]`, and
`genDone[cycleMonday]` records which parts are in. Unticked parts are therefore
*reserved*: a night/weekend-turn nurse gets only the rest of their split on weekdays.
A later Generate with a new part ticked **reveals** that part from the same plan
(`revealParts`), keeping the grid and never taking a nurse over their split. Do not
re-plan per pass — each pass would pick different RNs than the slots the earlier pass
reserved (a sweep showed ~100 split breaks per 150 seeds when it did). Once every ticked
part is in, the button reads **Regenerate** and re-plans only the ticked parts around the
rest. `genPlan` is dropped when all three parts are in. `genDone`/`genPlan` are cleared
wherever `frozen` is (Clear, Regenerate in Auto, Rebuild, Free the night turn). While a
fortnight is partly generated, the banner shows what is left instead of staffing checks.
Per-shift ticks (D6, D7, S8, S9, S10 in `genParts.shifts`) **combine** with the part ticks,
so everything is tracked in *units* — `'weekdays:D6'`, `'weekends:D7'`, `'nights:N7'`
(`Engine.unitOf`, `ALL_UNITS`, `tickedUnits()`); `pickParts`/`revealParts` accept a unit
array as `fill`. Weekends only has the D7 unit (the weekend turn); N7 is the Nights tick
alone. `genDone` holds units; an older entry of bare part names means all their units.

**Locked fortnights (the Lock button).** `lockedCycles[cycleMonday]` is a view-only
*record* taken at lock time: RN rows in display order with their names, groups and
shifts, plus that fortnight's support staff, staff shifts, flags and comments. It is
the highest-priority layer — above `frozen` and requests:
- the engine returns it first (`ctx.locked`, built in `schedCtx()`), so the next
  fortnight's seam, reports and fairness all read the locked shifts;
- the grid and the PDF/Excel/CSV exports render it through `withLockedView(fn)`,
  which swaps the roster globals for the record and **always restores them**. Only
  wrap code that reads the *current* fortnight — anything that recomputes other
  cycles (`computeSchedule`, `turnFor`, `monthlyReport`, `ensureNightList`) must run
  outside it, or it will see the record's roster as the live one;
- every edit path is blocked while locked: cell/name editors, drag reorder, requests
  (`reqAdd`/`reqDelete`), `setFlag`/`setNote`/`setStaffShift` (via `dayLocked()`),
  Generate, Regenerate, Clear and Free the night turn. The turn panel is hidden;
- **Unlock** (confirm) bakes the record back into `frozen` (+ its staff shifts, flags
  and comments), so nothing on screen changes. RNs removed while it was locked drop
  out at that point.

**Request report (Requests window → Request report).** `requestReportRows(off)` lists the
fortnight's time-off entries (`REQ_REPORT_TYPES`: Req off, Day off, Hol, Vac, SL — not
requested duties), one row per day, RNs in display order, with the reason = that day's
comment (`notes`). The Requests form's **Reason** box writes that same comment. It runs
inside `withLockedView`, so a locked fortnight reports its record. The `.xlsx` writes
dates as `Date.UTC(y,m,d)` — a local-midnight Date shows one day early in Excel for any
timezone ahead of UTC (verified with `timezoneId: 'Asia/Beirut'`).

`nightBlockers()` finds entries sitting on a night-turn nurse's night days. The banner
only raises them when the night actually ended up short (most are backfilled).
Genuine absences (Hol/Vac/SL/Req off) are reported separately from entries that should
be cleared.

## Verifying a scheduler change

Unit tests alone are not enough for anything touching `engine.js`. Sweep many seeds and
cycles and **compare against the previous engine as a control** — `git stash`, run the same
sweep, `git stash pop`. Count the three things that matter: nurses off the 4/3 or 3/4 split,
nurses working 4+ days in a row, and nights staffed below the minimum. A change that fixes
one rule by quietly loosening another will otherwise look like a success.

## Nothing fails silently

`noteProblem(text, detail)` (top of the inline script) writes to the console **and** shows
the red `#errNote` banner, which stays until dismissed. It is fed by uncaught errors,
unhandled promise rejections and security-policy violations, and by `loadState()` when the
saved roster cannot be read (the unreadable copy is kept under `STORE_KEY+'_unreadable'`
rather than overwritten by a blank roster). When you add a `catch`, either handle the
failure in a way the user can see, call `noteProblem`, or leave a comment saying why it is
safe to ignore (e.g. storage unavailable in a private window). The audit asserts the
banner stayed empty for the whole run.

## Sign-in, the lock screen and the cloud roster

One **manager account** (Firebase email + password, created by hand in the console)
does everything: it opens the app, owns the cloud roster and reads the staff requests.
There is no shared password and no anonymous sign-in; do not reintroduce either.

- **`onAuthStateChanged` in `initCloud()` is the only switch.** A user → `lockOpen()`,
  `connectRoster(uid)`, `sreqSetManager(user)`. No user → `lockShow()` and everything
  disconnects. A leftover anonymous session is signed out.
- **The lock screen is honest about what it is.** The server enforces access to cloud
  data (`firestore.rules`); the screen cannot protect the copy in this browser's
  storage. So a device that has signed in (`rn_signed`, in sessionStorage, or in
  localStorage with *Keep me signed in*) opens at once and **also offline**; if
  Firebase then reports no session, it locks again. That marker is not a security
  boundary and must never gate anything the rules do not also gate.
- **Roster location:** `rosters/{uid}` = `{state, updatedAt, rev, clashes}`, readable
  and writable only by that account. `schedules/{unitCode}` is legacy: no writes; a
  manager may `get` it once (`seedRoster()` takes it over when the account has no roster
  yet and the device still remembers `rn_unit`) and delete it from the Cloud window
  (`legacyCheck/Use/Delete`).
- **Every save is a versioned transaction** (`pushCloud`): read the document, merge,
  write with `rev+1`. The rules refuse any other `rev`, so no client — including an
  out-of-date copy of the app — can write over a roster it has not read. Never go back
  to a plain `.set()`.
- **Three-way merge** (`mergeState(base, mine, theirs)`). `base` is the roster as it
  was when this device and the account last agreed (`syncBaseStr`, kept in `rn_base`).
  A change on one side only is kept. Where both changed the same thing, **the device
  saving now wins** (the manager chose "last saved wins + notice"); the clash goes into
  the document's `clashes` log (last 5) and every device shows it in the `#syncNote`
  banner until dismissed. Objects merge key by key; a flat array of equal length (a
  nurse's 14 cells) element by element; any other array is taken whole. The parallel
  roster arrays (`ROSTER_KEYS`) always come from one side when RNs were added or removed.
- **When the account's roster arrives** (`onRemote`): first time on a device → take it,
  keeping the device's previous state as an undo step. Device has unsent changes
  (`localAhead()`, e.g. made offline) → save, which merges. Otherwise → take it.
  Compare rosters with `stable()` (key order differs between devices), and after taking
  a roster set the base to what the device now shows — loading can tidy a state, and
  treating that as an edit would make two devices send each other the same roster forever.
- **`adoptCloudState()`** is the one place a cloud roster is applied; it also saves it
  to the device (`saveState()` skips the cloud while `applyingRemote`).
- **No save before the first read:** `cloudSave`/`pushCloud` do nothing until
  `rosterReady`. Offline, a save fails, the status reads "Not sent yet", and it is
  retried on a timer and on the browser's `online` event.
- **`probeRules()`** asks for a roster that is not ours. Refused → `cloudSecure=true`;
  answered → the Cloud window says the database is NOT secured. This is how the app
  can tell whether the rules were published; never replace it with an assumption.
- **`test/audit.mjs` runs with the network blocked** and the `rn_signed` marker, i.e.
  as a signed-in device that is offline. Anything needing Firebase is `test/cloud.mjs`.

## Staff request link (`request.html`)

A second, standalone page for staff: `request.html?f=<form id>`. They pick their name,
day(s) from tomorrow onward and a reason, and send a **Req off** — nothing else. The
manager reads the result in **Staff requests** (`openStaffReq()`), a reference list that
**never changes the roster** (no `overrides`, no history entry).

- **Data:** `requestForms/{formId}` = `{owner, open, title, anchor, ids[], names[],
  updatedAt}`; `requestForms/{formId}/requests/{auto}` = `{rnId, name, dates:'iso,iso',
  reason, createdAt, done?}`. The form id is 28 random characters and is **not** the unit
  code. The form belongs to the manager's account (found by `where('owner','==',uid)`),
  so it is **not** in `PERSIST` — undo, backups and the roster sync never touch it.
- **Who may do what is in `firestore.rules`, not in the pages.** Link holders can `get`
  the form and `create` a request; only the password-account owner can read, tick
  `done`, delete, pause (`open:false`) or replace the form. Change the rules and
  `test/cloud.mjs` together.
- **Same sign-in as the app.** The window needs `mgrUser` (set from
  `onAuthStateChanged`); opened offline it only says it needs a connection.
- **The name list is published from the roster** (`sreqPeople()`: RNs in display order,
  then support staff) by `sreqPublish()`, debounced from `saveState()`.
- **Everything received is untrusted** — `sreqClean()` then `escapeHtml()`, and the name
  shown is the roster's (by `rnId`), not the one that was sent. `request.html` uses
  `textContent` only.
- **Dates are local calendar days on both pages** (`fromIso`, `new Date(k+'T00:00:00')`),
  never `new Date('YYYY-MM-DD')`, which is UTC and lands a day early west of Greenwich.
- `test/cloud.mjs` serves the pages as they are, appending a patch to
  `vendor/firebase-firestore-compat.js` that points the SDK at the emulators, and adding
  `http://127.0.0.1:*` to the policy's `connect-src`. Any policy violation fails the run.

## Dates are local calendar days

A stored date is a `'YYYY-MM-DD'` string meaning a day on the wall calendar, not an
instant. Parse it with `parseLocal()` (from `engine.js`, also a global in the page) or
`new Date(iso+'T00:00:00')`, **never** `new Date('YYYY-MM-DD')`: that is midnight UTC,
which west of Greenwich is the evening before, so `getMonday()` snapped back a week and
the whole roster started 7 days early (audit H1). `test:unit` runs the engine tests in
`America/Los_Angeles` as well as the machine's timezone, and the audit checks the start
date in five timezones.

## Documentation

`README.md` is the overview for a new reader. `NIGHT_SHIFT_ROTATION.md` describes the
night and weekend turns as `turnFor()` computes them; its example table came from running
the engine, so regenerate it if the rotation changes.

## Security

`SECURITY.md` and `firestore.rules` are the complete setup for sign-in, the Firebase-backed
cloud sync and the staff request link. The rules file is **not** applied by anything in this repo — it must be pasted into
the Firebase console and published by hand, and the account and membership steps in
`SECURITY.md` have to be done in order. Do not describe the cloud data as protected until
those steps have actually been carried out.
