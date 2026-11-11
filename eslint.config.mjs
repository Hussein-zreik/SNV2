// ESLint flat config for the single-file scheduler.
//
// Scope on purpose: this catches BUGS, not style. The app is one deliberately
// dense inline <script>; running a formatter (Prettier) over it would produce a
// huge unreviewable diff and fight the intended compact style, so we don't. What
// we DO want automated is the class of mistakes a human misses in a 3k-line file:
// typos in identifiers, duplicate object keys (easy in DAILY_MIN / the registry),
// unreachable code, self-assignments, duplicate function args, etc.
//
// no-unused-vars is OFF: ~200 functions are called only from data-on-* attributes
// in the HTML (see "buttons without inline code" in index.html), which the parser
// sees as text, so they would all look unused.
import js from '@eslint/js';
import html from 'eslint-plugin-html';

// browser + CDN library globals this file legitimately uses
const browser = {
  window: 'readonly', document: 'readonly', navigator: 'readonly',
  localStorage: 'readonly', sessionStorage: 'readonly', location: 'readonly',
  console: 'readonly', alert: 'readonly', confirm: 'readonly', prompt: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
  requestAnimationFrame: 'readonly', fetch: 'readonly', crypto: 'readonly',
  Blob: 'readonly', File: 'readonly', Element: 'readonly', FileReader: 'readonly', URL: 'readonly', Image: 'readonly',
  structuredClone: 'readonly', getComputedStyle: 'readonly', matchMedia: 'readonly',
  TextEncoder: 'readonly', TextDecoder: 'readonly', btoa: 'readonly', atob: 'readonly',
  // CDN libs loaded via <script> tags
  firebase: 'readonly', ExcelJS: 'readonly', jspdf: 'readonly', jsPDF: 'readonly',
  // provided by engine.js (loaded before the inline script)
  Engine: 'readonly', getMonday: 'readonly', parseLocal: 'readonly', addDays: 'readonly', isoKey: 'readonly',
  mkRng: 'readonly', shuffleArr: 'readonly', maxRunLen: 'readonly'
};

const bugRules = {
  ...js.configs.recommended.rules,
  'no-unused-vars': 'off',        // functions live behind inline onclick handlers
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-cond-assign': ['error', 'except-parens'],
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-control-regex': 'off',
  'no-prototype-builtins': 'off'
};

export default [
  // exact copies of published libraries (see vendor/manifest.json): not ours to lint
  { ignores: ['vendor/**'] },
  {
    files: ['**/*.html'],
    plugins: { html },
    languageOptions: { ecmaVersion: 2022, sourceType: 'script', globals: browser },
    rules: bugRules
  },
  {
    // engine.js: a classic browser script (IIFE) that is ALSO a CommonJS module
    // when imported by the Node unit tests — so it needs both browser and module
    // globals in scope.
    files: ['engine.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...browser, module: 'readonly', globalThis: 'readonly' }
    },
    rules: bugRules
  },
  {
    // The audit drives the app through page.evaluate(() => { ... }); those bodies
    // run in the browser and reference the app's globals (computeSchedule, sched,
    // overrides, ...), which ESLint can't resolve here — so no-undef is off. The
    // real check on this file is running it (npm test).
    files: ['test/**/*.mjs', '*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { console: 'readonly', process: 'readonly', URL: 'readonly' }
    },
    rules: { ...bugRules, 'no-undef': 'off' }
  }
];
