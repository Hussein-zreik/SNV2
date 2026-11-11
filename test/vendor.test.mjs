/**
 * Checks on the third-party code this site serves and on the security policy (audit H5).
 *
 *   node test/vendor.test.mjs            # part of `npm run test:unit`
 *   node test/vendor.test.mjs --write    # after an intended change: update the manifest
 *                                        # checksums and both pages' inline-script checksums
 *
 * - every file in vendor/ is byte-for-byte what vendor/manifest.json records, and the
 *   Firebase files are the ones in node_modules/firebase (what test/cloud.mjs runs);
 * - neither page loads a script from another site;
 * - both pages carry a Content-Security-Policy that allows no inline script except
 *   the page's own, by checksum; no element carries inline event-handler code, and
 *   every data-on-* attribute calls a function the page declares.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRITE = process.argv.includes('--write');
const read = f => fs.readFileSync(path.join(ROOT, f));
const sha = (buf, algo) => `${algo}-${crypto.createHash(algo).update(buf).digest('base64')}`;
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  -> ' + detail}`); if (!ok) failures++; };

const manifestPath = path.join(ROOT, 'vendor', 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const pkg = JSON.parse(read('package.json'));

if (WRITE) {
  for (const f of manifest.files) f.sha384 = sha(read('vendor/' + f.file), 'sha384');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

// ---- vendor/ is exactly what the manifest says
const onDisk = fs.readdirSync(path.join(ROOT, 'vendor')).filter(f => f.endsWith('.js')).sort();
check('vendor/ holds exactly the files in the manifest', JSON.stringify(onDisk) === JSON.stringify(manifest.files.map(f => f.file).sort()), onDisk.join(', '));
for (const f of manifest.files) {
  const buf = read('vendor/' + f.file);
  check(`vendor/${f.file} is unchanged (${f.package}@${f.version})`, sha(buf, 'sha384') === f.sha384, 'checksum differs from vendor/manifest.json');
  if (f.package === 'firebase') {
    const src = path.join(ROOT, 'node_modules', 'firebase', f.file);
    check(`vendor/${f.file} is the npm package's file`, fs.existsSync(src) && buf.equals(fs.readFileSync(src)), 'differs from node_modules/firebase — run npm ci');
  }
}
const fb = manifest.files.find(f => f.package === 'firebase');
check('the Firebase version served is the one the tests install', !!fb && pkg.devDependencies.firebase === fb.version, `${fb && fb.version} vs ${pkg.devDependencies.firebase}`);

// ---- the pages
for (const page of ['index.html', 'request.html']) {
  let html = read(page).toString('utf8');
  const srcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map(m => m[1]);
  check(`${page}: every script is served from this site`, srcs.length > 0 && srcs.every(s => !/^(https?:)?\/\//.test(s)), srcs.join(', '));
  check(`${page}: every vendor script it loads is in the manifest`, srcs.filter(s => s.startsWith('vendor/')).every(s => manifest.files.some(f => 'vendor/' + f.file === s)), srcs.join(', '));
  const csp = (html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/) || [])[1] || '';
  const dir = name => (csp.split(';').map(x => x.trim()).find(x => x.startsWith(name + ' ')) || '').slice(name.length + 1);
  check(`${page}: has a security policy, placed before any script`, !!csp && html.indexOf('Content-Security-Policy') < html.indexOf('<script'));
  check(`${page}: anything not listed is refused`, dir('default-src') === "'none'" && dir('object-src') === "'none'" && dir('base-uri') === "'none'" && dir('form-action') === "'none'", csp);
  check(`${page}: may only talk to Google's API servers`, dir('connect-src') === 'https://*.googleapis.com', dir('connect-src'));
  check(`${page}: no script may come from a CDN`, !/jsdelivr|gstatic|cdnjs|unpkg/.test(dir('script-src')) && !dir('script-src').includes('*'), dir('script-src'));
  check(`${page}: scripts cannot be built from text (no eval)`, !dir('script-src').includes('unsafe-eval'));
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const want = inline.map(x => `'${sha(Buffer.from(x, 'utf8'), 'sha256')}'`);
  if (WRITE && inline.length === 1) {
    html = html.replace(/'sha256-[A-Za-z0-9+/=]+'|'sha256-PENDING'/, want[0]);
    fs.writeFileSync(path.join(ROOT, page), html);
  }
  html = fs.readFileSync(path.join(ROOT, page), 'utf8');
  const now = (html.match(/script-src ([^;]+)/) || [])[1] || '';
  check(`${page}: its one inline script is allowed by checksum, and no other inline code is`,
    inline.length === 1 && now.includes(want[0]) && !now.includes('unsafe-inline'),
    now.includes(want[0]) ? now : 'checksum out of date — run: node test/vendor.test.mjs --write');
  const handlers = [...html.matchAll(/\son[a-z]+\s*=\s*["']/g)].map(m => m[0].trim());
  check(`${page}: no inline event handlers anywhere, markup or generated HTML`, handlers.length === 0, handlers.slice(0, 5).join(' '));
  const declared = new Set([...html.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]));
  const calls = [...html.matchAll(/data-on-[a-z]+="\s*([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]);
  const unknown = [...new Set(calls.filter(n => !declared.has(n)))];
  check(`${page}: every data-on-* attribute calls a function the page declares`, unknown.length === 0, unknown.join(', '));
  if (page === 'index.html') check('index.html: buttons are wired through data-on-* attributes', calls.length > 100, String(calls.length));
}

console.log(failures ? `\n${failures} FAILED` : '\nVendor and security-policy checks passed.');
process.exit(failures ? 1 : 0);
