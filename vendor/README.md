# vendor/

Third-party libraries served with the app, so that no code is loaded from another
website at run time.

Every file is an exact copy of a file in the published npm package. Package, version,
licence and checksum are in `manifest.json`; `test/vendor.test.mjs` (part of
`npm run test:unit`) fails if a file differs from the manifest, if the Firebase files
differ from `node_modules/firebase`, or if a page loads a script from another site.

Do not edit these files. To update one, copy the new file from the npm package, change
its `version` in `manifest.json`, and run `node test/vendor.test.mjs --write`.

| File | Package | Licence |
|---|---|---|
| `firebase-*-compat.js` | firebase | Apache-2.0 |
| `exceljs.min.js` | exceljs | MIT |
| `jspdf.umd.min.js` | jspdf | MIT |
| `jspdf.plugin.autotable.min.js` | jspdf-autotable | MIT |

The full licence texts are in each package on npm (and in `node_modules/` after `npm ci`
for Firebase).
