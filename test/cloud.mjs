/**
 * Cloud checks for the staff request link — run inside the Firebase emulators:
 *
 *   npm run test:cloud
 *
 * Part 1 feeds firestore.rules through the Firestore + Auth emulators as four
 * different callers (staff with only the link, an anonymous roster device, the
 * manager, and a second manager account) and asserts who may do what.
 * Part 2 drives the two real pages end to end: the manager creates a link in
 * index.html, a member of staff sends a request from request.html on a phone-sized
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
  await ctx.addInitScript(() => { try { sessionStorage.setItem('rn_unlocked', '1'); } catch { /* no storage */ } });
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

/* =====================================================================
   Part 1 — the rules, caller by caller
   ===================================================================== */
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
  await allow('an anonymous roster device can send one too', reqs('anon').add(req({ rnId: 'u2', name: 'RN Two' })));
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

  // --- the rest of the database
  await deny('roster document is closed to a visitor who is not signed in', db('staff').collection('schedules').doc('some-unit').get());
  await allow('roster document still opens for a signed-in device', db('anon').collection('schedules').doc('some-unit').get());
  await deny('any other collection is closed', db('mgr').collection('anything').doc('x').set({ a: 1 }));
  return out;
});
console.log('--- security rules ---');
for (const [name, ok, detail] of rules) check(name, ok, detail);
await rulesCtx.close();

/* =====================================================================
   Part 2 — the two pages, end to end
   ===================================================================== */
console.log('--- manager creates the link ---');
const mctx = await newContext({ timezoneId: 'Asia/Beirut' });
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
check('app signs in anonymously by default', await until(mgr, () => cloudAuth === 'ok' && firebase.auth().currentUser && firebase.auth().currentUser.isAnonymous));
await mgr.evaluate(() => connectCloud('cloud-test-unit'));
check('roster cloud sync connects', await until(mgr, () => cloudStatus === 'synced'));
const before = await mgr.evaluate(() => ({ state: JSON.stringify(cloudStateObj()), hist: history.length, people: sreqPeople().length, rn0: names[order[0]] }));

await mgr.click('#sreqBtn');
check('window asks the manager to sign in', await mgr.isVisible('#sreqSignin') && !(await mgr.isVisible('#sreqMain')));
await mgr.fill('#sreqEmail', 'ward@example.test');
await mgr.fill('#sreqPw', 'wrong-password');
await mgr.click('#sreqSigninBtn');
check('wrong password is refused with a plain message',
  await until(mgr, () => /not correct/.test(document.getElementById('sreqSigninMsg').textContent)) && await mgr.isVisible('#sreqSignin'));
await mgr.fill('#sreqPw', 'ward-pass-1');
await mgr.click('#sreqSigninBtn');
check('manager signs in', await until(mgr, () => !!mgrUser && sreqState === 'ready' && !document.getElementById('sreqSetup').hidden));
check('window shows who is signed in', (await mgr.textContent('#sreqWho')).includes('ward@example.test'));
await mgr.fill('#sreqTitle', 'PACU');
await mgr.click('#sreqSetup button');
check('link is created', await until(mgr, () => !!sreqForm && !document.getElementById('sreqLinkBox').hidden && sreqState === 'ready'));
const link = await mgr.inputValue('#sreqUrl');
check('link points at the request page with a long random id', new RegExp('^' + BASE + '/request\\.html\\?f=[A-Za-z0-9]{28}$').test(link), link);
check('link does not contain the unit code', !link.includes('cloud-test-unit'));
check('roster sync still connected as the manager', await until(mgr, () => cloudStatus === 'synced' && cloudAuth === 'ok'));

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

await mgr.click('#sreqSignoutBtn');
check('signing out closes the list and falls back to the anonymous sign-in',
  await until(mgr, () => !mgrUser && sreqItems.length === 0 && !document.getElementById('sreqSignin').hidden &&
    document.getElementById('sreqBadge').hidden && firebase.auth().currentUser && firebase.auth().currentUser.isAnonymous));
check('roster sync is connected again after signing out', await until(mgr, () => cloudStatus === 'synced' && cloudAuth === 'ok'));
check('a signed-out device cannot read the requests', await mgr.evaluate(id =>
  firebase.firestore().collection('requestForms').doc(id).collection('requests').get().then(() => 'ok', e => e.code), link2.split('f=')[1]) === 'permission-denied');

check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
await browser.close();
server.close();
console.log(failures ? `\n${failures} FAILED` : '\nAll cloud checks passed.');
process.exit(failures ? 1 : 0);
