#!/usr/bin/env node
// Cheap build-sanity assertion, same idea as CI's "Runtime assets present in
// dist" step: the compiled version module must actually report the version
// package.json says, not silently resolve the wrong file or swallow a read
// error into its fallback. The root package owns the release version;
// workspace package versions and Docker build arguments must not override it.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/* eslint-disable no-console */

const expected = JSON.parse(readFileSync('package.json', 'utf8')).version;

// This check only discriminates a wrong path (e.g. resolving core/package.json
// instead of the root one) as long as the two disagree. core/package.json is
// an internal package version, not the release version — assert that
// distinction here too, since a well-meaning "keep versions in sync" tidy-up
// would otherwise turn this whole check into a silent no-op.
const coreVersion = JSON.parse(readFileSync('core/package.json', 'utf8')).version;
if (coreVersion === expected) {
  console.error(
    `core/package.json's version ('${coreVersion}') now matches the root's — this check can no ` +
      `longer tell a correct read from one that resolved the wrong file. Keep core/package.json ` +
      `distinct, or replace this assertion with one that isn't a tautology.`,
  );
  process.exit(1);
}

const modulePath = resolve('core/dist/version.js');
const { VERSION } = await import(pathToFileURL(modulePath).href);

if (VERSION !== expected) {
  console.error(`core/dist/version.js reports '${VERSION}', package.json says '${expected}'`);
  process.exit(1);
}
console.log(`core/dist/version.js correctly reports ${VERSION}`);
