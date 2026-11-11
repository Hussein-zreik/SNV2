/**
 * Cloud checks for the staff request link — run inside the Firebase emulators:
 *
 *   npm run test:cloud
 *
 * Part 1 feeds firestore.rules through the Firestore + Auth emulators as four
 * different callers (staff with only the link, an anonymous sign-in, the manager,
 * and a second manager account) and asserts who may do what.
 * Part 2 drives the real pages end to end: the manager signs in on the lock screen,
 * the roster moves from the old unit-code location into the account and syncs
 * between two devices (also after edits made offline); then the manager creates a
 * staff link, a member of staff sends a request from request.html on a phone-sized
 * screen, and it appears in the manager's Staff requests window.
 *
 * Nothing here touches the real Firebase project: the pages load the same compat
 * SDK version from node_modules (instead of the CDN) with a small patch that points
 * it at the emulators and at the throwaway project id "demo-snv2".
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import http from 'http';
import fs from 'fs';
import path from 'path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST;
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;
if (!FS_HOST || !AUTH_HOST) {
  console.error('The Firebase emulators are not running. Use: npm run test:cloud');
  process.exit(2);
}
const [FS_ADDR, FS_PORT] = FS_HOST.split(':');
const SDK = 'https://www.gstatic.com/firebasejs/10.14.1/';
const PATCH = `
;(function(){var init=firebase.initializeApp;
firebase.initializeApp=function(cfg,name){
  var app=init.call(firebase,Object.assign({},cfg,{projectId:'demo-snv2'}),name);
  app.firestore().useEmulator(${JSON.stringify(FS_ADDR)},${+FS_PORT});
  if(app.auth)app.auth().useEmulator('http://${AUTH_HOST}',{disableWarnings:true});
  return app;};})();`;

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  -> ' + detail}`);
  if (!ok) failures++;
};

/* ---------- a static server for the repo, plus a bare page holding the SDK ---------- */
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/__sdk.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><meta charset="utf-8"><script src="${SDK}firebase-app-compat.js"></script>` +
      `<script src="${SDK}firebase-auth-compat.js"></script><script src="${SDK}firebase-firestore-compat.js"></script>`);
    return;
  }
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !/^\/(index\.html|request\.html|engine\.js)$/.test(p) || !fs.existsSync(file)) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

async function launch() {
  try { return await chromium.launch(); }
  catch { return await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }); }
}
const browser = await launch();
const pageErrors = [];
async function newContext(opts = {}) {
  const ctx = await browser.newContext(opts);
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, route => {
    const url = route.request().url();
    if (url.startsWith(SDK)) {
      const name = url.slice(SDK.length);
      let body = fs.readFileSync(path.join(ROOT, 'node_modules', 'firebase', name), 'utf8');
      if (name === 'firebase-firestore-compat.js') body += PATCH;   // the last SDK file every page loads
      return route.fulfill({ contentType: 'text/javascript', body });
    }
    return route.abort();                    // fonts, ExcelJS, jsPDF: not needed here
  });
  return ctx;
}
const watch = (page, label) => page.on('pageerror', e => pageErrors.push(`${label}: ${e}`));
const until = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout }).then(() => true, () => false);

/* ---------- emulator admin access (bypasses the rules): seeding and inspection only ---------- */
const ADMIN = `http://${FS_HOST}/v1/projects/demo-snv2/databases/(default)/documents/`;
const enc = v => v === null ? { nullValue: null }
  : typeof v === 'boolean' ? { booleanValue: v }
  : typeof v === 'number' ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v })
  : typeof v === 'string' ? { stringValue: v }
  : Array.isArray(v) ? { arrayValue: { values: v.map(enc) } }
  : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])) } };
const adminSet = (doc, data) => fetch(ADMIN + doc, { method: 'PATCH', headers: { Authorization: 'Bearer owner', 'content-type': 'application/json' },
  body: JSON.stringify({ fields: enc(data).mapValue.fields }) }).then(r => r.status);
const adminHas = doc => fetch(ADMIN + doc, { headers: { Authorization: 'Bearer owner' } }).then(r => r.status === 200);
const locked = page => page.evaluate(() => !document.getElementById('lockScreen').classList.contains('unlocked'));

/* =====================================================================
   Part 1 — the rules, caller by caller
   ===================================================================== */
await adminSet('schedules/rules-old-unit', { state: { names: ['RN One'] }, updatedAt: 1 });
const rulesCtx = await newContext();
const rp = await rulesCtx.newPage();
watch(rp, 'rules page');
await rp.goto(BASE + '/__sdk.html');
const rules = await rp.evaluate(async () => {
  const out = [];
  const res = p => p.then(() => 'ok', e => e.code || String(e));
  const allow = async (name, p) => { const r = await res(p); out.push([name, r === 'ok', r]); };
  const deny = async (name, p) => { const r = await res(p); out.push([name, r === 'permission-denied', r]); };
  const cfg = { apiKey: 'demo', projectId: 'demo-snv2' };
  const mk = n => firebase.initializeApp(cfg, n);
  const A = { staff: mk('staff'), anon: mk('anon'), mgr: mk('mgr'), other: mk('other') };
  await A.anon.auth().signInAnonymously();
  const mgrUid = (await A.mgr.auth().createUserWithEmailAndPassword('manager@example.test', 'pw-123456')).user.uid;
  const otherUid = (await A.other.auth().createUserWithEmailAndPassword('other@example.test', 'pw-123456')).user.uid;
  const db = n => A[n].firestore();
  const ts = () => firebase.firestore.FieldValue.serverTimestamp();
  const FORM = 'RulesTestFormAAAAAAAAAAAAAAA1';             // 28 chars
  const form = (o = {}) => ({ owner: mgrUid, open: true, title: 'PACU', anchor: '2026-11-09',
    ids: ['u1', 'u2'], names: ['RN One', 'RN Two'], updatedAt: 1, ...o });
  const req = (o = {}) => ({ rnId: 'u1', name: 'RN One', dates: '2026-12-01,2026-12-02', reason: 'appointment', createdAt: ts(), ...o });
  const forms = n => db(n).collection('requestForms');
  const reqs = (n, f = FORM) => forms(n).doc(f).collection('requests');

  // --- who may create a form
  await deny('link-only visitor cannot create a form', forms('staff').doc(FORM).set(form()));
  await deny('anonymous device cannot create a form', forms('anon').doc(FORM).set(form()));
  await deny('manager cannot create a form owned by someone else', forms('mgr').doc(FORM).set(form({ owner: otherUid })));
  await deny('form id must be long (not guessable)', forms('mgr').doc('short').set(form()));
  await deny('form with an unexpected field is refused', forms('mgr').doc(FORM).set(form({ extra: 1 })));
  await deny('form whose names do not match its ids is refused', forms('mgr').doc(FORM).set(form({ names: ['only one'] })));
  await deny('form with a malformed anchor is refused', forms('mgr').doc(FORM).set(form({ anchor: 'today' })));
  await allow('manager creates their form', forms('mgr').doc(FORM).set(form()));

  // --- who may see forms
  await allow('link holder can read the form (name list)', forms('staff').doc(FORM).get());
  await deny('link-only visitor cannot list forms', forms('staff').get());
  await deny('anonymous device cannot list forms', forms('anon').where('owner', '==', mgrUid).get());
  await deny('manager cannot list every form', forms('mgr').get());
  await allow('manager can find their own form', forms('mgr').where('owner', '==', mgrUid).get());
  await deny('another manager cannot list this manager\'s forms', forms('other').where('owner', '==', mgrUid).get());

  // --- sending a request
  await allow('staff can send a valid request', reqs('staff').add(req()));
  await allow('an anonymous sign-in can send one too', reqs('anon').add(req({ rnId: 'u2', name: 'RN Two' })));
  await deny('request for someone not on the list', reqs('staff').add(req({ rnId: 'u9' })));
  await deny('request without a reason field', (() => { const r = req(); delete r.reason; return reqs('staff').add(r); })());
  await deny('request with an empty reason', reqs('staff').add(req({ reason: '' })));
  await deny('reason longer than 300 characters', reqs('staff').add(req({ reason: 'x'.repeat(301) })));
  await deny('malformed dates', reqs('staff').add(req({ dates: '01/12/2026' })));
  await deny('more than 14 dates', reqs('staff').add(req({ dates: Array.from({ length: 15 }, (_, i) => `2026-12-${String(i + 1).padStart(2, '0')}`).join(',') })));
  await deny('dates sent as a list instead of text', reqs('staff').add(req({ dates: ['2026-12-01'] })));
  await deny('request arriving already marked done', reqs('staff').add(req({ done: true })));
  await deny('request with any extra field', reqs('staff').add(req({ type: 'VAC' })));
  await deny('request with a made-up time stamp', reqs('staff').add(req({ createdAt: firebase.firestore.Timestamp.fromMillis(0) })));
  await deny('name longer than 120 characters', reqs('staff').add(req({ name: 'n'.repeat(121) })));
  await deny('request to a form that does not exist', reqs('staff', 'NoSuchFormAAAAAAAAAAAAAAAAAA1').add(req()));

  // --- reading and changing requests
  const mine = await reqs('mgr').get().then(s => s.docs.map(d => d.id), () => []);
  out.push(['manager can list what arrived', mine.length === 2, 'got ' + mine.length]);
  const rid = mine[0] || 'missing';
  for (const who of ['staff', 'anon', 'other']) {
    const label = { staff: 'link-only visitor', anon: 'anonymous device', other: 'another manager' }[who];
    await deny(`${label} cannot list requests`, reqs(who).get());
    await deny(`${label} cannot read a request`, reqs(who).doc(rid).get());
    await deny(`${label} cannot change a request`, reqs(who).doc(rid).update({ done: true }));
    await deny(`${label} cannot delete a request`, reqs(who).doc(rid).delete());
  }
  await allow('manager can read one request', reqs('mgr').doc(rid).get());
  await allow('manager can tick a request done', reqs('mgr').doc(rid).update({ done: true }));
  await deny('manager cannot rewrite the reason', reqs('mgr').doc(rid).update({ reason: 'edited' }));
  await deny('manager cannot rewrite the dates', reqs('mgr').doc(rid).update({ dates: '2027-01-01' }));
  await deny('done must be true or false', reqs('mgr').doc(rid).update({ done: 'yes' }));
  await allow('manager can delete a request', reqs('mgr').doc(rid).delete());

  // --- pausing, and protecting the form
  await deny('link-only visitor cannot change the form', forms('staff').doc(FORM).update({ open: false }));
  await deny('another manager cannot change the form', forms('other').doc(FORM).set(form({ owner: otherUid })));
  await deny('another manager cannot delete the form', forms('other').doc(FORM).delete());
  await deny('the form cannot be handed to another owner', forms('mgr').doc(FORM).update({ owner: otherUid }));
  await allow('manager pauses the form', forms('mgr').doc(FORM).set(form({ open: false })));
  await deny('a paused form accepts no requests', reqs('staff').add(req()));
  await allow('manager reopens the form', forms('mgr').doc(FORM).set(form({ open: true })));
  await allow('a reopened form accepts requests again', reqs('staff').add(req()));
  await allow('manager shrinks the name list', forms('mgr').doc(FORM).set(form({ ids: ['u2'], names: ['RN Two'] })));
  await deny('someone taken off the list can no longer be requested for', reqs('staff').add(req()));

  // --- the roster: one document per manager account
  const roster = (n, uid) => db(n).collection('rosters').doc(uid);
  await allow('manager saves their roster', roster('mgr', mgrUid).set({ state: { names: ['RN One'] }, updatedAt: 1 }));
  await allow('manager reads their roster', roster('mgr', mgrUid).get());
  await deny('roster with an unexpected field is refused', roster('mgr', mgrUid).set({ state: {}, updatedAt: 1, extra: 1 }));
  await deny('roster whose state is not an object is refused', roster('mgr', mgrUid).set({ state: 'x', updatedAt: 1 }));
  await deny('another manager cannot read this roster', roster('other', mgrUid).get());
  await deny('another manager cannot overwrite this roster', roster('other', mgrUid).set({ state: {}, updatedAt: 2 }));
  await deny('another manager cannot delete this roster', roster('other', mgrUid).delete());
  await deny('an anonymous sign-in cannot read a roster', roster('anon', mgrUid).get());
  await deny('an anonymous sign-in cannot create a roster under its own id', roster('anon', A.anon.auth().currentUser.uid).set({ state: {}, updatedAt: 1 }));
  await deny('a visitor who is not signed in cannot read a roster', roster('staff', mgrUid).get());
  await deny('nobody can list rosters', db('mgr').collection('rosters').get());

  // --- legacy: the roster once shared by unit code
  const legacy = n => db(n).collection('schedules').doc('rules-old-unit');
  await deny('old shared copy is closed to a visitor who is not signed in', legacy('staff').get());
  await deny('old shared copy is closed to an anonymous sign-in (it used to be open)', legacy('anon').get());
  await deny('nothing can be written to the old location any more', legacy('mgr').set({ state: {}, updatedAt: 2 }));
  await deny('a new unit-code document cannot be created', db('mgr').collection('schedules').doc('brand-new').set({ state: {}, updatedAt: 2 }));
  await deny('the old location cannot be listed', db('mgr').collection('schedules').get());
  await allow('a manager can read the old shared copy (to move it)', legacy('mgr').get());
  await allow('a manager can delete the old shared copy', legacy('mgr').delete());

  // --- the rest of the database
  await deny('any other collection is closed', db('mgr').collection('anything').doc('x').set({ a: 1 }));
  return out;
});
console.log('--- security rules ---');
for (const [name, ok, detail] of rules) check(name, ok, detail);
await rulesCtx.close();

/* =====================================================================
   Part 2 — the two pages, end to end
   ===================================================================== */
console.log('--- lock screen: the account sign-in ---');
const mctx = await newContext({ timezoneId: 'Asia/Beirut' });
// this device used the unit-code sync before: it still remembers the code
await mctx.addInitScript(() => { try { if (!localStorage.getItem('__t')) { localStorage.setItem('__t', '1'); localStorage.setItem('rn_unit', 'old-ward'); } } catch { /* no storage */ } });
// the ward's manager account (in production: created by hand in the Firebase console)
const setup = await mctx.newPage();
await setup.goto(BASE + '/__sdk.html');
await setup.evaluate(async () => {
  const app = firebase.initializeApp({ apiKey: 'demo', projectId: 'demo-snv2' }, 'setup');
  await app.auth().createUserWithEmailAndPassword('ward@example.test', 'ward-pass-1');
  await app.auth().signOut();
});
await setup.close();

const mgr = await mctx.newPage();
watch(mgr, 'manager app');
mgr.on('dialog', d => d.accept());
await mgr.goto(BASE + '/index.html');
check('the app opens locked and nobody is signed in — not even anonymously',
  await until(mgr, () => cloudAuth === 'off' && firebase.auth().currentUser === null) && await locked(mgr));
check('the shared password is gone from the page', await mgr.evaluate(() => typeof hashPw === 'undefined' && typeof PW_HASH === 'undefined' &&
  !document.documentElement.innerHTML.includes('PW_HASH')));
// the roster as the ward last shared it under the unit code
const legacyState = await mgr.evaluate(() => { const s = JSON.parse(JSON.stringify(cloudStateObj())); s.names[0] = 'Legacy Nurse'; return s; });
await adminSet('schedules/old-ward', { state: legacyState, updatedAt: 1794398400000 });
check('a signed-out page cannot read the old shared copy', await mgr.evaluate(() =>
  firebase.firestore().collection('schedules').doc('old-ward').get().then(() => 'ok', e => e.code)) === 'permission-denied');

await mgr.click('#lockGo');
check('empty sign-in is stopped', /email and password/i.test(await mgr.textContent('#lockErr')) && await locked(mgr));
await mgr.fill('#lockEmail', 'ward@example.test');
await mgr.fill('#pw1', 'wrong-password');
await mgr.click('#lockGo');
check('wrong password is refused with a plain message and the app stays locked',
  await until(mgr, () => /not correct/.test(document.getElementById('lockErr').textContent)) && await locked(mgr));
await mgr.fill('#pw1', 'ward-pass-1');
await mgr.press('#pw1', 'Enter');
check('the right password opens the app', await until(mgr, () => document.getElementById('lockScreen').classList.contains('unlocked') && !!mgrUser && cloudAuth === 'ok'));
check('without "keep me signed in" nothing is left for the next browser session',
  await mgr.evaluate(() => sessionStorage.getItem('rn_signed') === '1' && localStorage.getItem('rn_signed') === null));

console.log('--- the roster moves into the account ---');
check('roster sync connects to the account', await until(mgr, () => cloudStatus === 'synced'));
const moved = await mgr.evaluate(async () => {
  const d = await firebase.firestore().collection('rosters').doc(mgrUser.uid).get();
  return { local: names[0], cloud: d.exists && d.data().state.names[0], uid: mgrUser.uid, undo: history.some(h => /moving the shared roster/.test(h.label)) };
});
check('the old shared roster was taken over, on the device and in the account', moved.local === 'Legacy Nurse' && moved.cloud === 'Legacy Nurse', JSON.stringify(moved));
check('what was on the device before is kept as an undo step', moved.undo === true);
check('the rules check reports the database as closed', await until(mgr, () => cloudSecure === true));
await mgr.click('#cloudBtn');
check('Cloud window warns that the old shared copy still exists',
  await until(mgr, () => /still stored under “old-ward”/.test(document.getElementById('legacyMsg').textContent) && document.getElementById('legacyActions').style.display === 'flex'));
check('Cloud window says where the roster is saved and that the rules check passed',
  (await mgr.textContent('#cloudStatusMsg')).includes('ward@example.test') && /Rules check passed/.test(await mgr.textContent('#cloudSecureMsg')));
await mgr.click('#legacyActions .btn.danger');
check('"Delete old copy" removes it from the database', await until(mgr, () => /deleted/i.test(document.getElementById('legacyMsg').textContent)) &&
  !(await adminHas('schedules/old-ward')) && await mgr.evaluate(() => localStorage.getItem('rn_unit') === null));
check('the roster in the account is untouched by that', await adminHas('rosters/' + moved.uid));
await mgr.evaluate(() => closeCloud());

console.log('--- a second device, and edits made offline ---');
const dctx = await newContext({ timezoneId: 'Asia/Beirut' });
const dev2 = await dctx.newPage();
watch(dev2, 'second device');
dev2.on('dialog', d => d.accept());
await dev2.goto(BASE + '/index.html');
await until(dev2, () => cloudAuth === 'off');
await dev2.fill('#lockEmail', 'ward@example.test');
await dev2.fill('#pw1', 'ward-pass-1');
await dev2.check('#lockKeep');
await dev2.click('#lockGo');
check('second device signs in and receives the account\'s roster',
  await until(dev2, () => cloudStatus === 'synced' && names[0] === 'Legacy Nurse'));
check('its own earlier roster is kept as an undo step', await dev2.evaluate(() => history.some(h => /loading the roster from your account/.test(h.label))));
check('"keep me signed in" is remembered on that device', await dev2.evaluate(() => localStorage.getItem('rn_signed') === '1'));
await mgr.evaluate(() => { const b = snapshot(); names[1] = 'Edited On One'; pushHistory('rename', b); render(); saveState(); });
check('an edit on one device reaches the other', await until(dev2, () => names[1] === 'Edited On One'));
await dev2.close();
// the same device with no internet: Firebase cannot load at all
const off = await dctx.newPage();
watch(off, 'second device, offline');
await off.route(u => u.href.startsWith(SDK), r => r.abort());
await off.goto(BASE + '/index.html');
check('a device that stays signed in opens with no internet', !(await locked(off)) && await until(off, () => cloudStatus === 'unavailable') && !(await locked(off)));
check('offline, it shows the roster it last synced', await off.evaluate(() => names[0] === 'Legacy Nurse' && names[1] === 'Edited On One'));
await off.evaluate(() => { const b = snapshot(); names[2] = 'Edited Offline'; pushHistory('rename', b); render(); saveState(); });
await off.close();
const back = await dctx.newPage();
watch(back, 'second device, back online');
back.on('dialog', d => d.accept());
await back.goto(BASE + '/index.html');
check('back online, the offline edit is sent up instead of being overwritten',
  await until(back, () => cloudStatus === 'synced' && names[2] === 'Edited Offline') && await until(mgr, () => names[2] === 'Edited Offline'));
check('the app opened without asking for the password again', !(await locked(back)) && await back.evaluate(() => !!mgrUser));
await back.evaluate(() => lockApp());
check('the padlock signs out and locks, and forgets the device',
  await until(back, () => !mgrUser && cloudUid === '' && firebase.auth().currentUser === null) && await locked(back) &&
  await back.evaluate(() => localStorage.getItem('rn_signed') === null && sessionStorage.getItem('rn_signed') === null));
await back.reload();
check('after signing out, a reload stays locked', await until(back, () => cloudAuth === 'off') && await locked(back));
await dctx.close();
// a device that only claims to be signed in (the marker without a session)
const fctx = await newContext();
await fctx.addInitScript(() => { try { localStorage.setItem('rn_signed', '1'); } catch { /* no storage */ } });
const fake = await fctx.newPage();
watch(fake, 'forged marker');
await fake.goto(BASE + '/index.html');
check('a forged "signed in" marker gets no session: the app locks and the cloud stays closed',
  await until(fake, () => cloudAuth === 'off' && !document.getElementById('lockScreen').classList.contains('unlocked')) &&
  await fake.evaluate(uid => firebase.firestore().collection('rosters').doc(uid).get().then(() => 'ok', e => e.code), moved.uid) === 'permission-denied');
await fctx.close();
const nctx = await newContext();
const cold = await nctx.newPage();
watch(cold, 'new device, offline');
await cold.route(u => u.href.startsWith(SDK), r => r.abort());
await cold.goto(BASE + '/index.html');
check('a device that never signed in stays locked without internet, and says why',
  await until(cold, () => /No internet connection/.test(document.getElementById('lockErr').textContent)) && await locked(cold));
await nctx.close();

console.log('--- manager creates the staff link ---');
const before = await mgr.evaluate(() => ({ state: JSON.stringify(cloudStateObj()), hist: history.length, people: sreqPeople().length, rn0: names[order[0]] }));
await mgr.click('#sreqBtn');
check('Staff requests opens for the signed-in manager, with no second sign-in',
  await until(mgr, () => sreqState === 'ready' && !document.getElementById('sreqSetup').hidden) && !(await mgr.isVisible('#sreqOff')));
check('window shows who is signed in', (await mgr.textContent('#sreqWho')).includes('ward@example.test'));
await mgr.fill('#sreqTitle', 'PACU');
await mgr.click('#sreqSetup button');
check('link is created', await until(mgr, () => !!sreqForm && !document.getElementById('sreqLinkBox').hidden && sreqState === 'ready'));
const link = await mgr.inputValue('#sreqUrl');
check('link points at the request page with a long random id', new RegExp('^' + BASE + '/request\\.html\\?f=[A-Za-z0-9]{28}$').test(link), link);
check('link gives away neither the old unit code nor the account', !link.includes('old-ward') && !link.includes(moved.uid) && !link.includes('ward@'));

console.log('--- staff send a request (phone) ---');
const sctx = await newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'America/Los_Angeles', isMobile: true, hasTouch: true });
const staff = await sctx.newPage();
watch(staff, 'staff page');
await staff.goto(link);
check('request page opens the form', await until(staff, () => !document.getElementById('vForm').hidden));
check('ward name is shown', (await staff.textContent('#wardTitle')) === 'PACU');
const opts = await staff.$$eval('#who option', o => o.map(x => x.textContent));
check('name list holds every RN and support-staff member', opts.length - 1 === before.people, `${opts.length - 1} vs ${before.people}`);
check('names are in the roster\'s display order', opts[1] === before.rn0, `${opts[1]} vs ${before.rn0}`);
const cal = await staff.evaluate(() => {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const days = [...document.querySelectorAll('#days .day')];
  const base = plusDays(form.anchor, viewOff * 14);
  return { n: days.length, monday: form.anchor.getDay() === 1,
    pastOpen: days.filter((b, i) => plusDays(base, i) <= t && !b.disabled).length,
    futureShut: days.filter((b, i) => plusDays(base, i) > t && b.disabled).length,
    prevDisabled: document.getElementById('prevBtn').disabled,
    fits: document.documentElement.scrollWidth <= window.innerWidth };
});
check('fortnight shows 14 days starting on a Monday', cal.n === 14 && cal.monday, JSON.stringify(cal));
check('today and past days cannot be picked; every future day can', cal.pastOpen === 0 && cal.futureShut === 0, JSON.stringify(cal));
check('cannot browse back into past fortnights', cal.prevDisabled);
check('page fits a phone screen without sideways scrolling', cal.fits);

await staff.click('#sendBtn');
check('sending with no name is stopped', /name/i.test(await staff.textContent('#err')) && await staff.isVisible('#err'));
await staff.selectOption('#who', { index: 3 });
const who = opts[3];
await staff.click('#sendBtn');
check('sending with no day is stopped', /day/i.test(await staff.textContent('#err')));
await staff.click('#nextBtn');                              // a fortnight that is wholly in the future
const pickedDays = await staff.$$eval('#days .day:not([disabled])', b => [b[1], b[2], b[4]].map(x => x.getAttribute('aria-label')));
for (const i of [1, 2, 4]) await staff.locator('#days .day:not([disabled])').nth(i).click();
await staff.click('#sendBtn');
check('sending with no reason is stopped', /reason/i.test(await staff.textContent('#err')));
const expectIso = await staff.evaluate(() => [...picked].sort());
const REASON = 'Medical appointment — cardiology follow-up';
await staff.fill('#reason', REASON);
await staff.click('#sendBtn');
check('request is sent and confirmed', await until(staff, () => !document.getElementById('done').hidden) && (await staff.textContent('#done')).includes(who));
const sent = await staff.evaluate(() => ({ items: document.querySelectorAll('#sentList li').length, text: document.getElementById('sentBox').textContent,
  cleared: picked.size === 0 && document.getElementById('reason').value === '' }));
check('form clears and the device keeps a record of dates only', sent.items === 1 && sent.cleared && !sent.text.includes('cardiology'), JSON.stringify(sent));
const leak = await staff.evaluate(async id => {
  const res = p => p.then(() => 'ok', e => e.code);
  const col = firebase.firestore().collection('requestForms').doc(id).collection('requests');
  return { list: await res(col.get()) };
}, link.split('f=')[1]);
check('the staff page itself cannot read requests back', leak.list === 'permission-denied', JSON.stringify(leak));

console.log('--- it reaches the manager ---');
check('request appears in the manager\'s window by itself',
  await until(mgr, () => sreqItems.length === 1 && document.querySelectorAll('#sreqList .sreq-row').length === 1));
const row = await mgr.evaluate(() => ({ text: document.querySelector('#sreqList .sreq-row').textContent, item: sreqItems[0],
  badge: document.getElementById('sreqBadge').textContent, badgeHidden: document.getElementById('sreqBadge').hidden }));
check('row shows the RN and the reason', row.text.includes(who) && row.text.includes(REASON), row.text);
check('dates arrive as the calendar days the nurse tapped (Los Angeles → Beirut)',
  JSON.stringify(row.item.dates) === JSON.stringify(expectIso), `${row.item.dates} vs ${expectIso}`);
check('consecutive days read as one range', row.text.includes(' – ') && pickedDays.every((l, i) => i === 1 || row.text.includes(l.slice(0, 3))), row.text);
check('toolbar badge counts the new request', row.badge === '1' && !row.badgeHidden);
const after = await mgr.evaluate(() => ({ state: JSON.stringify(cloudStateObj()), hist: history.length }));
check('receiving a request changes nothing in the roster or its history', after.state === before.state && after.hist === before.hist);

// hostile text sent straight to the database, bypassing the page
await staff.evaluate(async id => {
  const f = firebase.firestore().collection('requestForms').doc(id);
  const first = (await f.get()).data().ids[0];
  await f.collection('requests').add({ rnId: first, name: '<img src=x onerror="window.__pwn=1">',
    dates: '2030-01-07', reason: '<img src=x onerror="window.__pwn=1"><script>window.__pwn=1</script>\'"); window.__pwn=1;//',
    createdAt: firebase.firestore.FieldValue.serverTimestamp() });
}, link.split('f=')[1]);
check('second request arrives', await until(mgr, () => sreqItems.length === 2));
const hostile = await mgr.evaluate(() => ({ pwn: window.__pwn, tags: document.querySelectorAll('#sreqList img, #sreqList script').length,
  text: document.getElementById('sreqList').textContent.includes('<img src=x') }));
check('hostile request text is shown as text, never run', hostile.pwn === undefined && hostile.tags === 0 && hostile.text, JSON.stringify(hostile));

console.log('--- manager works the list ---');
await mgr.locator('#sreqList .sreq-row', { hasText: REASON }).locator('input[type=checkbox]').check();
check('ticking done hides the request and lowers the badge',
  await until(mgr, () => sreqItems.filter(r => r.done).length === 1 && document.querySelectorAll('#sreqList .sreq-row').length === 1 && document.getElementById('sreqBadge').textContent === '1'));
await mgr.check('#sreqShowDone');
check('"Show done" brings it back, struck through', await mgr.locator('#sreqList .sreq-row.done', { hasText: REASON }).count() === 1);
await mgr.locator('#sreqList .sreq-row', { hasText: '<img src=x' }).locator('.rr-del').click();
check('deleting a request removes it', await until(mgr, () => sreqItems.length === 1 && sreqItems[0].done === true));
await mgr.reload();
check('after a reload the manager is still signed in and the list returns',
  await until(mgr, () => !!mgrUser && !!sreqForm && sreqState === 'ready' && sreqItems.length === 1 && document.getElementById('sreqBadge').hidden));
await mgr.click('#sreqBtn');
check('the same link is shown after the reload', (await mgr.inputValue('#sreqUrl')) === link);

await mgr.click('#sreqPauseBtn');
check('manager pauses the link', await until(mgr, () => sreqForm && sreqForm.open === false && document.getElementById('sreqPauseBtn').textContent === 'Resume'));
await staff.reload();
check('paused link tells staff requests are closed', await until(staff, () => !document.getElementById('vClosed').hidden));
await mgr.click('#sreqPauseBtn');
await until(mgr, () => sreqForm && sreqForm.open === true);
await mgr.evaluate(() => { const b = snapshot(); names[order[0]] = 'Zed Renamed'; pushHistory('rename', b); render(); saveState(); });
await mgr.waitForTimeout(2600);                             // the debounced publish
await staff.reload();
check('resumed link works, and a renamed RN shows under the new name',
  await until(staff, () => !document.getElementById('vForm').hidden) && (await staff.$$eval('#who option', o => o[1].textContent)) === 'Zed Renamed');
check('the nurse\'s name is remembered on their device', (await staff.inputValue('#who')) !== '');

await mgr.click('#sreqLinkBox .btn.danger');
check('a new link replaces the old one', await until(mgr, l => !!sreqForm && sreqState === 'ready' && document.getElementById('sreqUrl').value !== l && sreqItems.length === 0, link));
const link2 = await mgr.inputValue('#sreqUrl');
await staff.reload();
check('the old link stops working', await until(staff, () => !document.getElementById('vInvalid').hidden));
await staff.goto(link2);
check('the new link works', await until(staff, () => !document.getElementById('vForm').hidden) && (await staff.textContent('#wardTitle')) === 'PACU');
await staff.goto(BASE + '/request.html?f=abc');
check('a malformed link shows "not valid"', await until(staff, () => !document.getElementById('vInvalid').hidden));
await staff.goto(BASE + '/request.html');
check('a link with no id shows "not valid"', await until(staff, () => !document.getElementById('vInvalid').hidden));

await mgr.evaluate(() => closeStaffReq());
await mgr.click('button[aria-label="Sign out and lock the app"]');
check('signing out locks the app and empties the list',
  await until(mgr, () => !mgrUser && sreqItems.length === 0 && document.getElementById('sreqBadge').hidden && firebase.auth().currentUser === null) && await locked(mgr));
const shut = await mgr.evaluate(async ({ id, uid }) => {
  const res = p => p.then(() => 'ok', e => e.code), db = firebase.firestore();
  return [await res(db.collection('requestForms').doc(id).collection('requests').get()), await res(db.collection('rosters').doc(uid).get())];
}, { id: link2.split('f=')[1], uid: moved.uid });
check('a signed-out device can read neither the requests nor the roster', shut.every(r => r === 'permission-denied'), shut.join());

check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
await browser.close();
server.close();
console.log(failures ? `\n${failures} FAILED` : '\nAll cloud checks passed.');
process.exit(failures ? 1 : 0);
