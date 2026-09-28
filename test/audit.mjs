/**
 * Rule audit for the RN Rotating Schedule.
 *
 *   npm test                 # default sizes
 *   SEEDS=300 npm test       # deeper sweep
 *
 * Loads index.html in headless Chromium and asserts the scheduling rules that
 * the app promises. Exits non-zero if any rule is broken, so CI catches
 * regressions. It unlocks the app by setting the session flag directly, so the
 * password never has to appear in this repo.
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = 'file://' + path.resolve(HERE, '..', 'index.html');
const SEEDS = +(process.env.SEEDS || 60);        // seeds for the no-request sweep
const CYCLES = +(process.env.CYCLES || 20);      // cycles per seed
const SCEN_SEEDS = +(process.env.SCEN_SEEDS || 25); // seeds per request scenario

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  -> ' + detail}`);
  if (!ok) failures++;
};

async function launch() {
  try { return await chromium.launch(); }
  catch { return await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }); }
}

const browser = await launch();
const ctx = await browser.newContext();
await ctx.addInitScript(() => sessionStorage.setItem('rn_unlocked', '1'));
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));
await page.goto(APP);
await page.waitForTimeout(700);

/* ---------------- 1. core rules, no requests ---------------- */
const reg = await page.evaluate(({ SEEDS, CYCLES }) => {
  const WORK = new Set(['D6','D7','S8','S9','S10','N7']);
  const MIN = [{D6:2,D7:2,S8:1,S9:2,S10:1},{D6:2,D7:2,S8:1,S9:2,S10:1},{D6:2,D7:2,S8:1,S9:2,S10:1},
    {D6:2,D7:2,S8:1,S9:2,S10:1},{D6:2,D7:2,S8:1,S9:2,S10:1},{D7:2},{D7:2}];
  const trail = r => { let c=0; for (let d=13; d>=0 && WORK.has(r[d]); d--) c++; return c; };
  const lead  = r => { let c=0; for (let d=0; d<14 && WORK.has(r[d]); d++) c++; return c; };
  const maxRun = r => { let m=0,x=0; for (let d=0; d<14; d++) { if (WORK.has(r[d])) { x++; if (x>m) m=x; } else x=0; } return m; };
  const cnt = (sh,d,t) => { let c=0; for (let i=0;i<sh.length;i++) if (sh[i][d]===t) c++; return c; };

  manualMode = false; overrides = {}; committedCycles = {}; cycleSeeds = {};
  const r = { boundaryRun:0, cycleRun:0, notSeven:0, belowMin:0, nightCount:0, satStruct:0, sunStruct:0 };
  for (let s = 0; s < SEEDS; s++) {
    seed = (s * 2654435761) >>> 0;
    for (let off = 0; off < CYCLES; off++) {
      const A = computeSchedule(off).sh, B = computeSchedule(off + 1).sh;
      for (let i = 0; i < A.length; i++) {
        const t = trail(A[i]), l = lead(B[i]);
        if (t > 0 && l > 0 && t + l > 3) r.boundaryRun++;              // <=3 across the cycle seam
        if (maxRun(A[i]) > 3) r.cycleRun++;                            // <=3 within a cycle
        if (A[i].filter(x => WORK.has(x)).length !== 7) r.notSeven++;  // exactly 7 shifts
      }
      for (let d = 0; d < 14; d++) if (cnt(A, d, 'N7') !== 2) r.nightCount++;   // 2 nurses per night
      for (const w of [0, 1]) {                                                 // weekend structure
        const sat = w*7+5, sun = w*7+6;
        if (cnt(A,sat,'D7') !== 2 || cnt(A,sat,'S10') !== 0) r.satStruct++;   // 2-RN turn, no surplus
        if (cnt(A,sun,'D7') !== 2) r.sunStruct++;
      }
      for (let d = 0; d < 14; d++) {                                            // daily minimums
        const need = MIN[d % 7];
        for (const t in need) if (cnt(A, d, t) < need[t]) r.belowMin++;
      }
    }
  }
  return r;
}, { SEEDS, CYCLES });

console.log(`\n--- core rules (no requests, ${SEEDS} seeds x ${CYCLES + 1} cycles) ---`);
check('<=3 consecutive days across the cycle seam', reg.boundaryRun === 0, reg.boundaryRun + ' violations');
check('<=3 consecutive days within a cycle',        reg.cycleRun === 0,    reg.cycleRun + ' violations');
check('every nurse works exactly 7 shifts',         reg.notSeven === 0,    reg.notSeven + ' nurses off 7');
check('exactly 2 nurses on every night',            reg.nightCount === 0,  reg.nightCount + ' nights wrong');
check('Saturday = 2x D7, no surplus',               reg.satStruct === 0,   reg.satStruct + ' weekends wrong');
check('Sunday = 2x D7',                             reg.sunStruct === 0,   reg.sunStruct + ' weekends wrong');
check('no day below minimum staffing',              reg.belowMin === 0,    reg.belowMin + ' shortfalls');

/* ---------------- 1b. per-group week split and night counts ---------------- */
const split = await page.evaluate(({ SEEDS, CYCLES }) => {
  const WORK = new Set(['D6','D7','S8','S9','S10','N7']);
  manualMode = false; overrides = {}; committedCycles = {}; cycleSeeds = {};
  const r = { split43: 0, nightNot7: 0 };
  for (let s = 0; s < Math.min(SEEDS, 40); s++) {
    seed = (s * 2654435761) >>> 0;
    for (let off = 0; off < Math.min(CYCLES, 12); off++) {
      const sh = computeSchedule(off).sh;
      for (let i = 0; i < sh.length; i++) {
        const nights = sh[i].filter(x => x === 'N7').length;
        if (nights > 0) { if (nights !== 7) r.nightNot7++; continue; }
        // day nurses: Group A works 4 then 3, Group B works 3 then 4
        const w1 = sh[i].slice(0, 7).filter(x => WORK.has(x)).length;
        const w2 = sh[i].slice(7, 14).filter(x => WORK.has(x)).length;
        const want = groups[i] === 'A' ? [4, 3] : [3, 4];
        if (w1 !== want[0] || w2 !== want[1]) r.split43++;
      }
    }
  }
  return r;
}, { SEEDS, CYCLES });
console.log('\n--- per-group week split ---');
check('Group A works 4 then 3, Group B 3 then 4', split.split43 === 0, split.split43 + ' nurses wrong');
check('every night nurse works exactly 7 nights', split.nightNot7 === 0, split.nightNot7 + ' wrong');

/* ---------------- 1c. Manual mode behaves like Manual mode ---------------- */
const manual = await page.evaluate(() => {
  const WORK = new Set(['D6','D7','S8','S9','S10','N7']);
  const trail = r => { let c=0; for (let d=13; d>=0 && WORK.has(r[d]); d--) c++; return c; };
  const lead  = r => { let c=0; for (let d=0; d<14 && WORK.has(r[d]); d++) c++; return c; };
  overrides = {}; frozen = {}; seed = 4242;
  // a generated fortnight must look the same to a device in Auto
  let identical = 0, total = 0;
  for (let off = 0; off < 5; off++) {
    manualMode = true; committedCycles = {}; cycleSeeds = {}; cycleOffset = off; render(); generateFortnight();
    const m = JSON.stringify(sched.sh);
    manualMode = false; render();
    total++; if (m === JSON.stringify(sched.sh)) identical++;
  }
  // the seam rule must hold in Manual mode too
  manualMode = true; committedCycles = {}; cycleSeeds = {};
  for (let off = 0; off < 6; off++) { cycleOffset = off; render(); generateFortnight(); }
  let seam = 0;
  for (let off = 0; off < 5; off++) {
    const A = computeSchedule(off).sh, B = computeSchedule(off + 1).sh;
    for (let i = 0; i < A.length; i++) { const t = trail(A[i]), l = lead(B[i]); if (t > 0 && l > 0 && t + l > 3) seam++; }
  }
  // an ungenerated fortnight stays blank
  cycleOffset = 40; render();
  const blank = sched.sh.reduce((a, r) => a + r.filter(x => x !== 'OFF').length, 0);
  // a remote push from a device still in Auto must not flip this device
  manualMode = true;
  applyStateObject({ names:[...names], groups:[...groups], holBal:[...holBal], vacBal:[...vacBal],
    order:[...order], ids:[...ids], seed:1, startDate:startDateStr, overrides:{}, history:[],
    manualMode:false, committedCycles:{}, cycleSeeds:{} });
  const stillManual = manualMode;
  manualMode = false; committedCycles = {}; cycleSeeds = {}; overrides = {}; frozen = {}; cycleOffset = 0; render();
  return { identical, total, seam, blank, stillManual };
});
console.log('\n--- Manual mode ---');
check('generated fortnight matches what an Auto device shows', manual.identical === manual.total, manual.identical + '/' + manual.total);
check('<=3 across the cycle seam holds in Manual too', manual.seam === 0, manual.seam + ' violations');
check('an ungenerated fortnight stays blank', manual.blank === 0, manual.blank + ' filled cells');
check('a synced Auto device cannot flip this one to Auto', manual.stillManual === true);

/* ---------------- 1d. Manual Generate fills, then FREEZES (edits don't cascade) ---------------- */
const handGen = await page.evaluate(() => {
  manualMode = true; committedCycles = {}; cycleSeeds = {}; overrides = {}; frozen = {}; seed = 9; cycleOffset = 0;
  render(); generateFortnight();                       // fill the gaps + bake to a fixed grid
  const g1 = sched.sh.map(r => r.slice());
  const filled = g1.reduce((a, r) => a + r.filter(x => x !== 'OFF').length, 0);
  // the 2A+2B night turn is placed automatically: exactly 2 per night, and each
  // night nurse works 7 nights
  const perNight = []; for (let d = 0; d < 14; d++) { let c = 0; for (let i = 0; i < g1.length; i++) if (g1[i][d] === 'N7') c++; perNight.push(c); }
  const nightsCovered = perNight.every(x => x === 2);
  let nightNot7 = 0; for (let i = 0; i < g1.length; i++) { const n = g1[i].filter(x => x === 'N7').length; if (n > 0 && n !== 7) nightNot7++; }
  const weekendSurplus = (() => { let bad = 0; for (const wd of [5,6,12,13]) { let d7=0,s10=0; for (let i=0;i<g1.length;i++){ if(g1[i][wd]==='D7')d7++; if(g1[i][wd]==='S10')s10++; } if (d7!==2||s10!==0) bad++; } return bad; })();
  // now edit ONE cell through the real cell-editor path
  mStaffId = null; mRn = 3; mDay = 4; mSel = (sched.sh[3][4] === 'OFF' ? 'D6' : 'OFF');
  saveCell();
  const g2 = sched.sh.map(r => r.slice());
  let changed = 0, list = [];
  for (let i = 0; i < g1.length; i++) for (let d = 0; d < 14; d++) if (g1[i][d] !== g2[i][d]) { changed++; list.push(i+':'+d); }
  // a frozen fortnight renders identically on an Auto device
  const mine = JSON.stringify(g2);
  manualMode = false; render();
  const asAuto = JSON.stringify(sched.sh);
  manualMode = false; committedCycles = {}; cycleSeeds = {}; overrides = {}; frozen = {}; cycleOffset = 0; render();
  return { filled, nightsCovered, nightNot7, weekendSurplus, changed, list, sameOnAuto: mine === asAuto };
});
check('Manual Generate fills the fortnight', handGen.filled > 50, handGen.filled + ' cells filled');
check('Manual Generate places the night turn (2 per night)', handGen.nightsCovered === true, 'some nights not 2');
check('Manual Generate: each night nurse works 7 nights', handGen.nightNot7 === 0, handGen.nightNot7 + ' wrong');
check('no weekend surplus in a generated fortnight', handGen.weekendSurplus === 0, handGen.weekendSurplus + ' weekend days wrong');
check('editing a cell changes ONLY that cell (no cascade)', handGen.changed === 1, handGen.changed + ' cells changed: ' + handGen.list.join(','));
check('a frozen fortnight looks identical on an Auto device', handGen.sameOnAuto === true);

/* ---------------- 2. requests must not break the rules ---------------- */
const scen = await page.evaluate((NS) => {
  const WORK = new Set(['D6','D7','S8','S9','S10','N7']);
  const ENTRY = new Set(['D6','D7','S8','S9','S10','N7','HOL','VAC']);
  const MIN = [{D6:2,D7:2,S8:1,S9:2,S10:1},{D6:2,D7:2,S8:1,S9:2,S10:1},{D6:2,D7:2,S8:1,S9:2,S10:1},
    {D6:2,D7:2,S8:1,S9:2,S10:1},{D6:2,D7:2,S8:1,S9:2,S10:1},{D7:2},{D7:2}];
  const K = d => { const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), dd=String(d.getDate()).padStart(2,'0'); return `${y}-${m}-${dd}`; };
  const maxRun = r => { let m=0,x=0; for (let d=0;d<14;d++){ if (WORK.has(r[d])){x++;if(x>m)m=x;} else x=0; } return m; };
  const cnt = (sh,d,t) => { let c=0; for (let i=0;i<sh.length;i++) if (sh[i][d]===t) c++; return c; };
  const days = computeSchedule(0).days;

  // A run over 3 days only counts against the scheduler when no requested
  // working day sits inside it — otherwise the manager caused it deliberately
  // (and the health banner reports it).
  function violations(sh, reqs) {
    const v = [];
    for (const [rn, d, ty] of reqs) if (sh[rn][d] !== ty) v.push('request not honored');
    for (let i = 0; i < sh.length; i++) {
      if (maxRun(sh[i]) <= 3) continue;
      const asked = new Set(reqs.filter(r => r[0] === i && WORK.has(r[2])).map(r => r[1]));
      let run = [];
      for (let d = 0; d <= 14; d++) {
        if (d < 14 && WORK.has(sh[i][d])) run.push(d);
        else { if (run.length > 3 && !run.some(x => asked.has(x))) v.push('run over 3 days'); run = []; }
      }
    }
    // NOTE: a request may pull a day below minimum staffing. That is now
    // acceptable by design — the turn quota is absolute, so rather than hand
    // someone an extra duty the day is left short for a manual fix. So we do
    // NOT flag below-minimum here (it is still flagged in the no-request core
    // suite, where the roster has the capacity to meet every minimum).
    for (let i = 0; i < sh.length; i++)
      if (!reqs.some(r => r[0] === i) && sh[i].filter(x => ENTRY.has(x)).length < 7)
        v.push('unrequested nurse under 7');
    // the turn quota (4/3-3/4) is absolute: no non-night nurse works MORE than
    // their weekly quota, unless the manager explicitly requested extra working
    // shifts on them. This is the guard against "extra duty when not their turn".
    for (let i = 0; i < sh.length; i++) {
      if (sh[i].some(x => x === 'N7')) continue;                 // night nurses excluded
      for (const w of [0, 1]) {
        const lo = w*7, hi = lo+7;
        const actual = sh[i].slice(lo, hi).filter(x => WORK.has(x)).length;
        const locked = reqs.filter(r => r[0]===i && WORK.has(r[2]) && r[1]>=lo && r[1]<hi).length;
        const quota = (groups[i] === 'A' ? [4,3] : [3,4])[w];
        if (actual > Math.max(quota, locked)) v.push('over quota (extra duty)');
      }
    }
    return v;
  }

  const results = {};
  const scenario = (name, build) => {
    const seen = {}; let total = 0;
    for (let s = 0; s < NS; s++) {
      seed = (s * 7919 + 13) >>> 0; overrides = {};
      const reqs = build();
      for (const [rn, d, ty] of reqs) {
        const k = K(days[d]);
        if (!overrides[k]) overrides[k] = {};
        overrides[k][rid(rn)] = ty;
      }
      for (const v of violations(computeSchedule(0).sh, reqs)) { seen[v] = (seen[v]||0)+1; total++; }
    }
    overrides = {};
    results[name] = { total, seen };
  };

  scenario('single requested duty',        () => [[3,1,'D7']]);
  scenario('Mon,Tue,Sat,Sun all D7',       () => [[3,0,'D7'],[3,1,'D7'],[3,5,'D7'],[3,6,'D7']]);
  scenario('one requested day off',        () => [[4,2,'OFF']]);
  scenario('three requested days off',     () => [[4,0,'OFF'],[4,1,'OFF'],[4,2,'OFF']]);
  scenario('five-day vacation block',      () => [[5,0,'VAC'],[5,1,'VAC'],[5,2,'VAC'],[5,3,'VAC'],[5,4,'VAC']]);
  scenario('Req off Monday of week 2',     () => [[15,7,'REQ']]);
  scenario('three nurses Req off week 2',  () => [[15,7,'REQ'],[16,8,'REQ'],[17,9,'REQ']]);
  scenario('weekend Sat+Sun requested',    () => [[6,5,'D7'],[6,6,'D7']]);
  scenario('Saturday S10 requested',       () => [[7,5,'S10']]);
  scenario('three nurses off same day',    () => [[2,3,'OFF'],[3,3,'OFF'],[4,3,'OFF']]);
  scenario('mixed duty/off/vacation',      () => [[2,0,'D6'],[3,1,'OFF'],[8,2,'VAC'],[9,5,'D7']]);
  scenario('eight mixed requests',         () => { const T=['D6','D7','S8','S9','S10','OFF','VAC','REQ'],o=[];
    for (let q=0;q<8;q++) o.push([(q*2+1)%19,(q*3)%14,T[q%T.length]]); return o; });
  scenario('fifteen mixed requests',       () => { const T=['D6','D7','S8','S9','OFF','VAC','REQ'],o=[];
    for (let q=0;q<15;q++) o.push([(q*3+2)%19,(q*5+1)%14,T[q%T.length]]); return o; });
  return results;
}, SCEN_SEEDS);

console.log(`\n--- requests respect the rules (${SCEN_SEEDS} seeds per scenario) ---`);
for (const [name, r] of Object.entries(scen))
  check(name, r.total === 0, JSON.stringify(r.seen));

/* ---------------- 3. stable ids: requests follow the nurse ---------------- */
const idTest = await page.evaluate(() => {
  const days = computeSchedule(0).days;
  overrides = {}; seed = 4242;
  const target = names[6];
  overrides[isoKey(days[2])] = { [rid(6)]: 'VAC' };
  render();
  const before = sched.sh[6][2];
  removeRN(0);                                   // delete a nurse ABOVE the requester
  const i1 = names.indexOf(target);
  const afterRemove = i1 >= 0 ? sched.sh[i1][2] : 'LOST';
  addRN('B');                                    // and add one
  const i2 = names.indexOf(target);
  const afterAdd = i2 >= 0 ? sched.sh[i2][2] : 'LOST';
  overrides = {}; render();
  return { before, afterRemove, afterAdd };
});
console.log('\n--- requests bind to the nurse, not the row ---');
check('request survives removing a nurse above it', idTest.afterRemove === 'VAC', 'got ' + idTest.afterRemove);
check('request survives adding a nurse',            idTest.afterAdd === 'VAC',    'got ' + idTest.afterAdd);

/* ---------------- 4. backup round-trip ---------------- */
const backup = await page.evaluate(() => {
  const days = computeSchedule(0).days;
  names[0] = 'Backup Probe';
  overrides = { [isoKey(days[2])]: { [rid(3)]: 'VAC' } };
  render();
  const saved = JSON.stringify({ app:'rn-rotating-schedule', version:1, state: cloudStateObj() });
  names[0] = 'wiped'; overrides = {}; render();
  applyStateObject(JSON.parse(saved).state); render();
  const ok = names[0] === 'Backup Probe' && sched.sh[3][2] === 'VAC';
  overrides = {}; names[0] = 'RN 1'; render();
  return ok;
});
console.log('\n--- backup ---');
check('export/import restores roster and requests', backup === true);

/* ---------------- 4b. state registry round-trips (guards drift) ---------------- */
const reg2 = await page.evaluate(() => {
  const out = {};
  // structural: every sync field must actually serialize into the cloud object
  const cs = cloudStateObj();
  out.missingFromCloud = PERSIST.filter(f => f.sync && !(f.k in cs)).map(f => f.k);

  // behavioural: mutate a representative value in each kind of sync field, then
  // serialize -> wipe -> applyStateObject. Anything the read side forgot to load
  // fails to come back. This is exactly the class of bug the registry prevents.
  const days = computeSchedule(0).days;
  flags = { [isoKey(days[1])]: { [rid(2)]: true } };
  defHol = 9; defVac = 27;
  DAILY_MIN[0].D6 = 5;
  fatigue.maxNights = 3;
  staffLabels = { AIDE: 'Probe Aids' };
  overrides = { [isoKey(days[2])]: { [rid(3)]: 'VAC' } };
  const before = customShifts.length;
  const saved = JSON.parse(JSON.stringify(cloudStateObj()));
  // wipe every one
  flags = {}; defHol = 14; defVac = 21; DAILY_MIN[0].D6 = 2;
  fatigue.maxNights = 8; staffLabels = {}; overrides = {};
  applyStateObject(saved); render();
  out.roundTrip = {
    flags: !!(flags[isoKey(days[1])] && flags[isoKey(days[1])][rid(2)]),
    defHol: defHol === 9, defVac: defVac === 27,
    dailyMin: DAILY_MIN[0].D6 === 5,
    fatigue: fatigue.maxNights === 3,
    staffLabels: staffLabels.AIDE === 'Probe Aids',
    overrides: sched.sh[3][2] === 'VAC',
    customShifts: customShifts.length === before
  };

  // undo round-trip: snapshot -> mutate -> restore reverts every undo field
  overrides = {}; flags = {}; render();
  const snap = snapshot();
  flags = { [isoKey(days[4])]: { [rid(1)]: true } };
  overrides = { [isoKey(days[5])]: { [rid(0)]: 'HOL' } };
  restore(snap); render();
  out.undoReverted = Object.keys(flags).length === 0 && Object.keys(overrides).length === 0;

  // reset
  flags = {}; overrides = {}; defHol = 14; defVac = 21; DAILY_MIN[0].D6 = 2;
  fatigue.maxNights = 8; staffLabels = {}; render();
  return out;
});
console.log('\n--- state registry round-trips ---');
check('every sync field serializes to the cloud object', reg2.missingFromCloud.length === 0, 'missing: ' + reg2.missingFromCloud.join(','));
for (const [k, ok] of Object.entries(reg2.roundTrip))
  check('sync field survives save->load: ' + k, ok === true);
check('undo restores every field', reg2.undoReverted === true);

/* ---------------- 5. no runtime errors ---------------- */
console.log('\n--- runtime ---');
check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));

await browser.close();
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
