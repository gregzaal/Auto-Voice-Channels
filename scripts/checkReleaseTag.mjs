#!/usr/bin/env node
// Validates a release tag per plans/versioning.md §5:
//   - the tag name matches the root package.json's version at that commit
//   - it's strictly greater (real SemVer ordering) than the previous release
//   - at least one change under the versioned paths exists since the
//     previous release (blocks an accidental empty release)
// Wired into .github/workflows/release.yml on `push: tags: ['v*']`. Also
// runnable locally (`pnpm run release:check`) as a preflight right after
// creating a tag, before pushing it — reads the tagged commit via `git show`,
// not the working tree, so it validates what will actually be pushed even
// with unrelated uncommitted edits sitting around.
//
// Deliberately single-branch: "previous" is the highest other vX.Y.Z tag in
// the whole repo, not the highest ancestor of this commit. That's correct for
// this project's one-branch, no-backport workflow and wrong for a project
// that maintains older release lines — see plans/versioning.md §5's own
// framing of what this checks and doesn't.
import { execFileSync } from 'node:child_process';

/* eslint-disable no-console */

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;

function parseTag(tag) {
  const m = TAG_RE.exec(tag);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isGreater(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

let tagName;
try {
  tagName = process.env.TAG_NAME || git(['describe', '--tags', '--exact-match', 'HEAD']);
} catch {
  console.error(
    'HEAD has no tag pointing at it. Create the release tag first, then run this from that commit.',
  );
  process.exit(1);
}

const parsed = parseTag(tagName);
if (!parsed) {
  console.error(`Tag '${tagName}' isn't in the expected vMAJOR.MINOR.PATCH form.`);
  process.exit(1);
}

const pkgVersion = JSON.parse(git(['show', 'HEAD:package.json'])).version;
if (`v${pkgVersion}` !== tagName) {
  console.error(`Tag is '${tagName}' but package.json's version at HEAD is '${pkgVersion}'.`);
  process.exit(1);
}

// Every vX.Y.Z tag except this one, in real SemVer order (newest first).
let allTags = [];
try {
  allTags = git(['tag', '--list', 'v*']).split('\n').filter(Boolean);
} catch {
  allTags = [];
}
const previousTags = allTags
  .filter((t) => t !== tagName)
  .map((t) => ({ tag: t, parsed: parseTag(t) }))
  .filter((t) => t.parsed !== null)
  .sort((a, b) => (isGreater(a.parsed, b.parsed) ? -1 : isGreater(b.parsed, a.parsed) ? 1 : 0));

const previous = previousTags[0];

if (!previous) {
  console.log(`No previous release tag — '${tagName}' is the first. Nothing further to check.`);
  process.exit(0);
}

if (!isGreater(parsed, previous.parsed)) {
  console.error(
    `'${tagName}' is not greater than '${previous.tag}', the highest existing release tag. ` +
      `(Checked against every vX.Y.Z tag in the repo, not just this commit's ancestry — ` +
      `backporting a patch to an older release line isn't supported.)`,
  );
  process.exit(1);
}

// Deliberately the self-hoster's product surface, not just the bot's source:
// bot/package.json and core/package.json signal a real dependency or config
// change (the root package.json's own version bump is NOT in this list — it
// changes on every valid release by construction, which would make this
// check pass unconditionally and defeat the point of having it).
const VERSIONED_PATHS = [
  /^bot\/src\//,
  /^core\/src\//,
  /^bot\/package\.json$/,
  /^core\/package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^Dockerfile$/,
  /^core\/drizzle\//,
  /^docker-compose\.yml$/,
  /^\.env\.example$/,
  /^bot\/scripts\/copy-assets\.mjs$/,
  /^README\.md$/,
];
const TEST_SUFFIX = /\.(unit|integration)\.test\.ts$/;

let changed;
try {
  changed = git(['diff', '--name-only', previous.tag, tagName]).split('\n').filter(Boolean);
} catch (err) {
  console.error(`Could not diff '${previous.tag}'..'${tagName}': ${err.message}`);
  process.exit(1);
}
const relevant = changed.filter(
  (f) => VERSIONED_PATHS.some((re) => re.test(f)) && !TEST_SUFFIX.test(f),
);

if (relevant.length === 0) {
  console.error(
    `'${tagName}' changes nothing under the versioned paths since '${previous.tag}' — looks like an empty release.`,
  );
  process.exit(1);
}

console.log(
  `'${tagName}' is a valid release: bumped from '${previous.tag}', ${relevant.length} relevant file(s) changed.`,
);
