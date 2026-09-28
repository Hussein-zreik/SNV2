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
npm run test:unit      # 33 engine unit tests in plain Node, ~0.5s
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

The hard rules, in the order the engine enforces them:

1. Every night is staffed by the N7 minimum (default 2) — **never leave a night short.**
2. The night turn is 2 RNs from Group A on `NA_DAYS` and 2 from Group B on `NB_DAYS`,
   7 nights each. Turns *tile* the night list and reroll; they do not drift.
3. Each RN works exactly 7 duties per fortnight — Group A 4 then 3, Group B 3 then 4.
4. No more than 3 consecutive working days, enforced across the cycle seam too.
5. Weekday staffing minimums per shift type.

**Rules 3 and 4 genuinely conflict, and the result looks like a bug when it is not.**
Weekends are a separate fixed turn, so a nurse has only five weekday slots. A requested day
off on a **Tuesday, Wednesday or Thursday** still allows 4 duties; one on a **Monday or
Friday** leaves the four remaining weekdays contiguous, which would be 4 in a row, so that
nurse can only reach 3. Before treating an off-quota nurse as a defect, check whether their
locks make the quota arithmetically impossible.

Likewise, a day duty requested for a nurse who is on the night turn puts them over 7. That
is reported in the banner rather than silently fixed, because the only alternative is
dropping one of their nights — which rule 1 forbids.

`nightBlockers()` exists for a related trap: a locked entry sitting on a night-turn nurse's
night day silently cancels that night. Genuine absences (Hol/Vac/SL/Req off) are reported
separately from entries that should be cleared.

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
