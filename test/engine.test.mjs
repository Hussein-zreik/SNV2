/**
 * Fast unit tests for the pure scheduling engine (engine.js).
 *
 *   npm run test:unit
 *
 * These run in plain Node — no browser — in milliseconds, because engine.js is
 * DOM-free and takes an explicit ctx. They complement test/audit.mjs, which
 * drives the whole app (UI + persistence + sync) in headless Chromium.
 */
import assert from 'node:assert/strict';
import Engine from '../engine.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('PASS  ' + name); pass++; }
  catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.message || e)); fail++; }
}

const CORE = ['D6', 'D7', 'S8', 'S9', 'S10'];
const WORK = new Set([...CORE, 'N7']);
const ENTRY = new Set([...CORE, 'N7', 'HOL', 'VAC', 'SL']);
const DMIN = [
  { D6: 2, D7: 2, S8: 1, S9: 2, S10: 1 }, { D6: 2, D7: 2, S8: 1, S9: 2, S10: 1 },
  { D6: 2, D7: 2, S8: 1, S9: 2, S10: 1 }, { D6: 2, D7: 2, S8: 1, S9: 2, S10: 1 },
  { D6: 2, D7: 2, S8: 1, S9: 2, S10: 1 }, { D7: 2 }, { D7: 2 }
];
const MONDAY = Engine.getMonday(new Date('2026-01-05')); // a fixed anchor Monday

// build a ctx for an N-nurse roster (first half Group A, rest Group B)
function ctx(N, over = {}, opts = {}) {
  return {
    N,
    groups: Array.from({ length: N }, (_, i) => (i < Math.ceil(N / 2) ? 'A' : 'B')),
    order: Array.from({ length: N }, (_, i) => i),
    ids: Array.from({ length: N }, (_, i) => 'n' + i),
    overrides: over,
    frozen: opts.frozen || {},
    committedCycles: opts.committedCycles || {},
    cycleSeeds: opts.cycleSeeds || {},
    manualMode: opts.manualMode || false,
    seed: opts.seed ?? 12345,
    dailyMin: DMIN, coreDay: CORE, work: WORK,
    anchorMonday: MONDAY
  };
}
const maxRun = row => { let m = 0, r = 0; for (const s of row) { if (WORK.has(s)) { r++; if (r > m) m = r; } else r = 0; } return m; };
const cnt = (sh, d, t) => sh.reduce((a, row) => a + (row[d] === t ? 1 : 0), 0);

/* ---------- pure helpers ---------- */
test('getMonday snaps any day to its Monday', () => {
  assert.equal(Engine.isoKey(Engine.getMonday(new Date('2026-01-07'))), '2026-01-05'); // Wed -> Mon
  assert.equal(Engine.isoKey(Engine.getMonday(new Date('2026-01-11'))), '2026-01-05'); // Sun -> Mon
});
test('addDays / isoKey', () => {
  assert.equal(Engine.isoKey(Engine.addDays(MONDAY, 13)), '2026-01-18');
});
test('mkRng is deterministic for a seed', () => {
  const a = Engine.mkRng(42), b = Engine.mkRng(42);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
  assert.notEqual(Engine.mkRng(42)(), Engine.mkRng(43)());
});
test('maxRunLen counts the longest working run', () => {
  assert.equal(Engine.maxRunLen(['D6','D6','OFF','D7','D7','D7','OFF',...Array(7).fill('OFF')], WORK), 3);
});
test('pairAt wraps and handles tiny groups', () => {
  assert.deepEqual(Engine.pairAt([0,1,2,3], 0), [0,1]);
  assert.deepEqual(Engine.pairAt([0,1,2,3], 3), [3,0]);
  assert.deepEqual(Engine.pairAt([5], 2), [5]);
  assert.deepEqual(Engine.pairAt([], 0), []);
});
test('turnFor: weekend pair follows the night pair', () => {
  const t = Engine.turnFor(ctx(20), 0);
  assert.equal(t.nightA.length, 2);
  assert.equal(t.nightB.length, 2);
  // weekend pair is two positions after the night pair
  assert.deepEqual(t.wkndA, Engine.pairAt(Engine.groupSeq(ctx(20)).a, 2));
});

/* ---------- core generation guarantees (deterministic sweep) ---------- */
test('every nurse works exactly 7 shifts (no requests, 40 seeds x 6 cycles)', () => {
  for (let s = 0; s < 40; s++) for (let off = 0; off < 6; off++) {
    const c = ctx(19, {}, { seed: (s * 2654435761) >>> 0 });
    const { sh } = Engine.computeSchedule(c, off);
    for (let i = 0; i < sh.length; i++)
      assert.equal(sh[i].filter(x => WORK.has(x)).length, 7, `seed ${s} off ${off} nurse ${i}`);
  }
});
test('exactly 2 nurses on every night; <=3 consecutive; minimums met', () => {
  for (let s = 0; s < 40; s++) for (let off = 0; off < 6; off++) {
    const c = ctx(19, {}, { seed: (s * 2654435761) >>> 0 });
    const { sh } = Engine.computeSchedule(c, off);
    for (let d = 0; d < 14; d++) assert.equal(cnt(sh, d, 'N7'), 2, `nights seed ${s} off ${off} day ${d}`);
    for (let i = 0; i < sh.length; i++) assert.ok(maxRun(sh[i]) <= 3, `run seed ${s} off ${off} nurse ${i}`);
    for (let d = 0; d < 14; d++) { const need = DMIN[d % 7]; for (const t in need) assert.ok(cnt(sh, d, t) >= need[t], `min seed ${s} day ${d} ${t}`); }
  }
});
test('weekend = exactly 2x D7, no surplus', () => {
  for (let s = 0; s < 25; s++) for (let off = 0; off < 4; off++) {
    const { sh } = Engine.computeSchedule(ctx(19, {}, { seed: s * 99991 }), off);
    for (const w of [0, 1]) {
      assert.equal(cnt(sh, w*7+5, 'D7'), 2); assert.equal(cnt(sh, w*7+5, 'S10'), 0);
      assert.equal(cnt(sh, w*7+6, 'D7'), 2);
    }
  }
});
test('same seed -> identical schedule (determinism)', () => {
  const a = Engine.computeSchedule(ctx(19, {}, { seed: 777 }), 2).sh;
  const b = Engine.computeSchedule(ctx(19, {}, { seed: 777 }), 2).sh;
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});
test('<=3 consecutive holds across the cycle seam', () => {
  const trail = r => { let c = 0; for (let d = 13; d >= 0 && WORK.has(r[d]); d--) c++; return c; };
  const lead = r => { let c = 0; for (let d = 0; d < 14 && WORK.has(r[d]); d++) c++; return c; };
  for (let s = 0; s < 20; s++) {
    const c = ctx(19, {}, { seed: s * 40503 });
    for (let off = 0; off < 5; off++) {
      const A = Engine.computeSchedule(c, off).sh, B = Engine.computeSchedule(c, off + 1).sh;
      for (let i = 0; i < A.length; i++) { const t = trail(A[i]), l = lead(B[i]); if (t && l) assert.ok(t + l <= 3, `seam seed ${s} off ${off} nurse ${i}`); }
    }
  }
});

/* ---------- requests (locks) ---------- */
test('a requested VAC is placed and never overwritten', () => {
  const day = Engine.isoKey(Engine.addDays(MONDAY, 2)); // Wed of cycle 0
  const { sh } = Engine.computeSchedule(ctx(19, { [day]: { n5: 'VAC' } }), 0);
  assert.equal(sh[5][2], 'VAC');
});
test('sick leave is placed and never overwritten', () => {
  const day = Engine.isoKey(Engine.addDays(MONDAY, 2)); // Wed of cycle 0
  const { sh } = Engine.computeSchedule(ctx(19, { [day]: { n5: 'SL' } }), 0);
  assert.equal(sh[5][2], 'SL');
});
test('sick leave uses up a duty, like Hol and Vac', () => {
  // SL on two days of week 1 -> two fewer day shifts that week, still 7 entries
  const d0 = Engine.isoKey(Engine.addDays(MONDAY, 2));
  const d1 = Engine.isoKey(Engine.addDays(MONDAY, 3));
  const { sh } = Engine.computeSchedule(ctx(19, { [d0]: { n5: 'SL' }, [d1]: { n5: 'SL' } }), 0);
  const w1 = sh[5].slice(0, 7);
  assert.equal(w1.filter(x => x === 'SL').length, 2);
  assert.ok(w1.filter(x => WORK.has(x)).length <= 2, 'SL should displace duties, not add to them');
  assert.equal(sh[5].filter(x => ENTRY.has(x)).length, 7);
});
test('a requested duty stays put and the nurse still totals 7', () => {
  const day = Engine.isoKey(Engine.addDays(MONDAY, 3)); // Thu
  const { sh } = Engine.computeSchedule(ctx(19, { [day]: { n8: 'S10' } }), 0);
  assert.equal(sh[8][3], 'S10');
  assert.equal(sh[8].filter(x => ENTRY.has(x)).length, 7);
});

/* ---------- frozen fortnight ---------- */
test('a frozen fortnight returns its baked grid, with requests on top', () => {
  const gk = Engine.isoKey(MONDAY);
  const row = Array(14).fill('OFF'); row[0] = 'D6'; row[1] = 'D6';
  const frozen = { [gk]: { n3: row.slice() } };
  const wed = Engine.isoKey(Engine.addDays(MONDAY, 2));
  const { sh } = Engine.computeSchedule(ctx(19, { [wed]: { n3: 'HOL' } }, { frozen }), 0);
  assert.equal(sh[3][0], 'D6');   // from the frozen grid
  assert.equal(sh[3][1], 'D6');
  assert.equal(sh[3][2], 'HOL');  // request applied on top
});
test('manual mode: an ungenerated fortnight stays blank', () => {
  const { sh } = Engine.computeSchedule(ctx(19, {}, { manualMode: true }), 0);
  assert.equal(sh.reduce((a, r) => a + r.filter(x => x !== 'OFF').length, 0), 0);
});
test('manual mode: a GENERATED fortnight places the 2A+2B night turn', () => {
  // committed (generated) manual cycle: nights auto-placed, 2 per night, 7 each
  const c = ctx(19, {}, { manualMode: true, committedCycles: { [Engine.isoKey(MONDAY)]: true } });
  const { sh } = Engine.computeSchedule(c, 0);
  for (let d = 0; d < 14; d++) assert.equal(cnt(sh, d, 'N7'), 2, `manual night day ${d}`);
  const t = Engine.turnFor(c, 0);
  assert.deepEqual(t.nightA, [0, 1]); assert.deepEqual(t.nightB, [10, 11]);
  for (let i = 0; i < 19; i++) { const n = sh[i].filter(x => x === 'N7').length; if (n) assert.equal(n, 7, `n${i}`); }
});

/* ---------- custom night cycle (the Night-cycle Settings tab) ---------- */
function ctxNL(N, nightList, seed = 12345) { const c = ctx(N, {}, { seed }); c.nightList = nightList; return c; }
const nightsOf = (sh, i) => sh[i].filter(x => x === 'N7').length;

test('custom night list: only listed RNs ever work nights', () => {
  const list = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5']; // only these 6 eligible
  const inList = new Set(list);
  for (let off = 0; off < 8; off++) {
    const { sh } = Engine.computeSchedule(ctxNL(19, list), off);
    for (let i = 0; i < 19; i++)
      if (nightsOf(sh, i) > 0) assert.ok(inList.has('n' + i), `off ${off}: n${i} worked nights but isn't in the list`);
  }
});
test('removed RNs never work nights', () => {
  const list = ['n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9']; // n0, n1 removed
  for (let off = 0; off < 8; off++) {
    const { sh } = Engine.computeSchedule(ctxNL(19, list), off);
    assert.equal(nightsOf(sh, 0), 0, `off ${off}: n0 removed but has nights`);
    assert.equal(nightsOf(sh, 1), 0, `off ${off}: n1 removed but has nights`);
  }
});
test('custom list keeps 2 from Group A + 2 from Group B on nights', () => {
  // everyone eligible (roster order): A = n0..n9, B = n10..n18
  const all = Array.from({ length: 19 }, (_, i) => 'n' + i);
  const t = Engine.turnFor(ctxNL(19, all), 0);
  assert.deepEqual(t.nightA, [0, 1]);   // 2 from Group A
  assert.deepEqual(t.nightB, [10, 11]); // 2 from Group B — NOT 4 from A
});
test('custom order sets whose turn is first, within each group', () => {
  const list = ['n7', 'n12', 'n2', 'n15', 'n4']; // A: 7,2,4  B: 12,15
  const t = Engine.turnFor(ctxNL(19, list), 0);
  assert.deepEqual(t.nightA, [7, 2]);   // first two Group-A entries in list order
  assert.deepEqual(t.nightB, [12, 15]); // first two Group-B entries in list order
});
test('night turns TILE the list and reroll (1-2, 3-4, 5-6, 7-8, back to 1-2)', () => {
  // the manager's order: 1,2,11,12, 3,4,13,14, 5,6,15,16, 7,8,17,18 (RN9/10/19 off nights)
  const list = [1, 2, 11, 12, 3, 4, 13, 14, 5, 6, 15, 16, 7, 8, 17, 18].map(r => 'n' + (r - 1));
  const expect = [[[0, 1], [10, 11]], [[2, 3], [12, 13]], [[4, 5], [14, 15]], [[6, 7], [16, 17]]];
  for (let off = 0; off < 8; off++) {
    const t = Engine.turnFor(ctxNL(19, list), off);
    const [eA, eB] = expect[off % 4];               // rerolls every 4 cycles
    assert.deepEqual(t.nightA, eA, `cycle ${off} group A`);
    assert.deepEqual(t.nightB, eB, `cycle ${off} group B`);
  }
  // the specific case: cycle 5 must be RN3,RN4 + RN13,RN14
  const t5 = Engine.turnFor(ctxNL(19, list), 5);
  assert.deepEqual([...t5.nightA, ...t5.nightB], [2, 3, 12, 13]);
});
test('night pattern: 4-duty week Mon/Tue/Sat/Sun, 3-duty week Wed/Thu/Fri', () => {
  const list = [1, 2, 11, 12, 3, 4, 13, 14, 5, 6, 15, 16, 7, 8, 17, 18].map(r => 'n' + (r - 1));
  const { sh } = Engine.computeSchedule(ctxNL(19, list), 5);
  const days = i => { const d = []; for (let x = 0; x < 14; x++) if (sh[i][x] === 'N7') d.push(x); return d; };
  assert.deepEqual(days(2), [0, 1, 5, 6, 9, 10, 11]);   // RN3 (A): Mon,Tue,Sat,Sun | Wed,Thu,Fri
  assert.deepEqual(days(12), [2, 3, 4, 7, 8, 12, 13]);  // RN13 (B): Wed,Thu,Fri | Mon,Tue,Sat,Sun
  for (let d = 0; d < 14; d++) assert.equal(cnt(sh, d, 'N7'), 2, `day ${d} must have exactly 2 on nights`);
});
test('N7 minimum sets how many RNs staff each night', () => {
  const mins = n7 => [0, 1, 2, 3, 4].map(() => ({ D6: 2, D7: 2, S8: 1, S9: 2, S10: 1, N7: n7 }))
    .concat([{ D7: 2, N7: n7 }, { D7: 2, N7: n7 }]);
  for (const n7 of [2, 3]) {
    const c = ctx(19); c.dailyMin = mins(n7); c.nightMin = n7;
    const { sh } = Engine.computeSchedule(c, 0);
    for (let d = 0; d < 14; d++) assert.equal(cnt(sh, d, 'N7'), n7, `N7=${n7} day ${d}`);
  }
});
test('N7 minimum is never filled with day shifts', () => {
  const c = ctx(19);
  c.dailyMin = [0, 1, 2, 3, 4].map(() => ({ D6: 2, D7: 2, S8: 1, S9: 2, S10: 1, N7: 2 }))
    .concat([{ D7: 2, N7: 2 }, { D7: 2, N7: 2 }]);
  const { sh } = Engine.computeSchedule(c, 0);
  // nobody works both a night and a day shift in the same fortnight
  for (let i = 0; i < 19; i++) {
    const n = sh[i].filter(x => x === 'N7').length;
    const dd = sh[i].filter(x => CORE.includes(x)).length;
    assert.ok(!(n > 0 && dd > 0), `n${i} has ${n} nights and ${dd} days`);
  }
});
test('a group with <2 eligible comes up short, no borrowing', () => {
  const list = ['n0', 'n1', 'n2', 'n10']; // A: 0,1,2  B: only 10
  const t = Engine.turnFor(ctxNL(19, list), 0);
  assert.equal(t.nightA.length, 2);
  assert.deepEqual(t.nightB, [10]);      // only one Group-B night nurse — left short
});
test('custom list keeps <=3 consecutive and never over-quota', () => {
  const lists = [
    Array.from({ length: 19 }, (_, i) => 'n' + i),        // everyone, roster order
    ['n0', 'n10', 'n1', 'n11', 'n2', 'n12', 'n3', 'n13'], // curated 8
    ['n0', 'n1', 'n2', 'n3', 'n4']                        // just 5
  ];
  for (const list of lists) for (let s = 0; s < 15; s++) for (let off = 0; off < 6; off++) {
    const { sh } = Engine.computeSchedule(ctxNL(19, list, s * 7919), off);
    for (let i = 0; i < 19; i++) {
      assert.ok(maxRun(sh[i]) <= 3, `run > 3: list ${list.length} seed ${s} off ${off} n${i}`);
      const w = sh[i].filter(x => WORK.has(x)).length;
      const nights = nightsOf(sh, i);
      assert.ok(w <= 7, `over 7: n${i}`);                 // never over quota
      if (nights > 0) assert.equal(nights, 7, `night nurse n${i} not 7 nights`);
    }
  }
});
test('fewer than 4 eligible: nights are short, not reused', () => {
  const { sh } = Engine.computeSchedule(ctxNL(19, ['n0', 'n1']), 0); // only 2 eligible
  // at most 2 distinct nurses ever on nights; some nights uncovered (short), never a 3rd
  const nightNurses = new Set();
  for (let d = 0; d < 14; d++) { let c = 0; for (let i = 0; i < 19; i++) if (sh[i][d] === 'N7') { c++; nightNurses.add(i); } assert.ok(c <= 2); }
  assert.ok(nightNurses.size <= 2);
});
test('empty night list: no nights at all', () => {
  const { sh } = Engine.computeSchedule(ctxNL(19, []), 0);
  let n7 = 0; for (let i = 0; i < 19; i++) n7 += nightsOf(sh, i);
  assert.equal(n7, 0);
});
test('absent night list falls back to the default group rotation', () => {
  const c = ctx(19, {}, { seed: 5 });      // no nightList property at all
  const { sh } = Engine.computeSchedule(c, 0);
  for (let d = 0; d < 14; d++) assert.equal(cnt(sh, d, 'N7'), 2); // default: 2/night
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
