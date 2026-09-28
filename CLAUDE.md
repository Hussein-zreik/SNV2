# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A nursing rotating-shift scheduler for a hospital ward, used by a nurse manager to build
a 2-week duty roster for ~19 RNs plus support staff. It is a static site — no build step,
no server. `index.html` is opened directly (or served by GitHub Pages from `main`), so
**whatever is on `main` is what the ward is using.**

## Commands

```bash
npm install            # devDependencies only; the app itself has no dependencies
npm run lint           # ESLint — bug rules only, never style (see eslint.config.mjs)
npm run test:unit      # 48 engine unit tests in plain Node, ~0.5s
npm test               # full rule audit driving the app in headless Chromium, ~30s
```

Run all three before committing; CI (`.github/workflows/test.yml`) runs exactly these on
push to `main` and on PRs.

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

**CDN libraries (ExcelJS, jsPDF, Firebase) will not load offline.** `exportExcel()`
silently falls back to CSV when `window.ExcelJS` is missing, so an offline test of the
Excel path is really testing CSV. To exercise the real `.xlsx` writer, install `exceljs`
somewhere outside the repo and inject it with `page.addScriptTag({ path: ... })`.

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
import/export, and "no page errors".

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

## Stale documentation

`NIGHT_SHIFT_ROTATION.md` describes an **older** night rotation (pairs advancing by 2
positions, resetting every 5 and 9 cycles). The engine now tiles a configurable night list
with a configurable N7 minimum, and RNs can be removed from the rotation in
Settings → Night cycle. Treat that file as historical; trust `engine.js` and
`test/engine.test.mjs`.

## Security

`SECURITY.md` and `firestore.rules` are the complete setup for the Firebase-backed cloud
sync. The rules file is **not** applied by anything in this repo — it must be pasted into
the Firebase console and published by hand, and the account and membership steps in
`SECURITY.md` have to be done in order. Do not describe the cloud data as protected until
those steps have actually been carried out.
