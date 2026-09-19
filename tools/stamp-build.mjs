#!/usr/bin/env node
/**
 * Stamp a build id onto the app and make its URLs unique.
 *
 * Two jobs, both about cache:
 *
 *   1. Replace the placeholder in build.js so the running app can say which
 *      commit it is.
 *   2. Append `?v=<build>` to every relative module import, script and
 *      stylesheet URL, so a new deploy cannot be served from a cache holding
 *      the old one.
 *
 * GitHub Pages serves assets with a ten-minute max-age and its headers are not
 * configurable, so changing the URL is the only lever available. ES modules
 * resolve each import as its own request, which is why the rewrite has to
 * reach inside the JavaScript rather than only touching the entry point.
 *
 * Run against a checkout that is about to be uploaded. It edits in place and
 * is not meant to be committed.
 *
 *   node tools/stamp-build.mjs <app-dir> <build-id>
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const [, , appDir = 'app', build = 'dev'] = process.argv;

/** Relative import specifiers ending in .js, in static import/export clauses. */
const IMPORT = /(\bfrom\s+['"])(\.{1,2}\/[^'"]+\.js)(['"])/g;

/** src/href attributes pointing at local js and css. */
const ASSET = /((?:src|href)=")((?:\.\/)?(?:js|css)\/[^"]+\.(?:js|css))(")/g;

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

let stamped = 0;
let rewritten = 0;

for await (const path of walk(appDir)) {
  const ext = extname(path);
  if (ext !== '.js' && ext !== '.html') continue;
  // Tests never ship, and rewriting them would break running them locally.
  if (path.endsWith('.test.js')) continue;

  const before = await readFile(path, 'utf8');
  let after = before;

  if (path.endsWith('/build.js')) {
    after = after.replace("export const BUILD = 'dev';", `export const BUILD = '${build}';`);
    stamped++;
  }

  after = after
    .replace(IMPORT, (_, open, specifier, close) => `${open}${specifier}?v=${build}${close}`)
    .replace(ASSET, (_, open, url, close) => `${open}${url}?v=${build}${close}`);

  if (after !== before) {
    await writeFile(path, after);
    rewritten++;
  }
}

console.log(`Stamped build ${build}: ${stamped} marker, ${rewritten} files rewritten.`);
