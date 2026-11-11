/**
 * The contract between the app and its browser tests (audit M4).
 *
 *   node test/contract.test.mjs            # part of `npm run test:unit`, well under a second
 *   node test/contract.test.mjs --write    # after renaming or adding something on purpose
 *
 * test/audit.mjs and test/cloud.mjs drive the app through its global functions and
 * variables (computeSchedule, overrides, pushCloud, ...). That is deliberate — the app
 * is one file with no module boundary to test through — but it means renaming one of
 * them used to break a browser test halfway through a long run, with a bare
 * "x is not defined". test/app-api.json lists every app global the browser tests use.
 * This check fails at once, naming the test file, when one of them is no longer
 * declared by index.html or engine.js; and when a test starts using another one, it asks
 * for the list to be updated, so the dependency stays visible in review.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRITE = process.argv.includes('--write');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const TESTS = ['test/audit.mjs', 'test/cloud.mjs'];
const LIST = path.join(ROOT, 'test', 'app-api.json');
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  -> ' + detail}`); if (!ok) failures++; };

// what the app declares at the top level of its page script, plus engine.js's globals
function declared() {
  const html = read('index.html');
  const js = html.slice(html.indexOf('<script src="engine.js"></script>'));
  const out = new Set();
  for (const line of js.split('\n')) {
    const fn = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (fn) { out.add(fn[1]); continue; }
    const v = /^(?:let|const|var)\s+(.*)$/.exec(line);
    if (!v) continue;
    // names at nesting depth 0 followed by = or , or ; (e.g. `let a=1,b={x:2},c;`)
    let depth = 0, tok = '', expectName = true;
    for (const ch of v[1] + ';') {
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) depth--;
      if (depth) { tok = ''; continue; }
      if (/[\w$]/.test(ch)) { tok += ch; continue; }
      if (expectName && tok && /^[A-Za-z_$]/.test(tok)) { out.add(tok); expectName = false; }
      if (ch === ',' ) expectName = true;
      if (ch === ';') break;
      tok = '';
    }
  }
  const eng = /for\s*\(const k of \[([^\]]+)\]\)\s*root\[k\]/.exec(read('engine.js'));
  if (eng) for (const m of eng[1].matchAll(/'([\w$]+)'/g)) out.add(m[1]);
  out.add('Engine');
  return out;
}
// identifiers the tests use, minus what they define themselves
function usedBy(file) {
  const src = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const words = new Set(src.match(/(?<![\w$.'"`])[A-Za-z_$][\w$]*/g));
  return words;
}

const app = declared();
const lists = Object.fromEntries(TESTS.map(f => [f, [...usedBy(f)].filter(w => app.has(w)).sort()]));
if (WRITE) fs.writeFileSync(LIST, JSON.stringify({
  about: 'App globals (index.html / engine.js) that the browser tests use. Checked by test/contract.test.mjs; update with --write after an intended rename.',
  ...lists }, null, 2) + '\n');

check('the app declares a sensible number of globals (the parser still works)', app.size > 300 && app.has('computeSchedule') && app.has('overrides') && app.has('names'), String(app.size));
const saved = JSON.parse(fs.readFileSync(LIST, 'utf8'));
for (const f of TESTS) {
  const want = saved[f] || [];
  const gone = want.filter(n => !app.has(n));
  check(`${f}: every app global it relies on still exists (${want.length})`, gone.length === 0,
    `${gone.join(', ')} — renamed or removed in index.html/engine.js; update the test, then run: node test/contract.test.mjs --write`);
  const fresh = lists[f].filter(n => !want.includes(n));
  check(`${f}: no new reliance on app globals without recording it`, fresh.length === 0,
    `${fresh.join(', ')} — run: node test/contract.test.mjs --write`);
}
console.log(failures ? `\n${failures} FAILED` : '\nApp/test contract checks passed.');
process.exit(failures ? 1 : 0);
