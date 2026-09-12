/**
 * The channel-name template engine, published as `@avc/core/template`.
 *
 * **This barrel must stay free of the database client and of every node
 * builtin.** It is imported by `'use client'` React components on the marketing
 * site, and core's main entry point re-exports the Drizzle/`pg` client, so a
 * value imported from `@avc/core` in the browser bundle dies on
 * `Can't resolve 'fs'`. That is the entire reason this is a separate subpath
 * export rather than another line in `core/src/index.ts`, and it is why nothing
 * here may reach for `process`, `crypto`, `Date.now()` or a repository.
 *
 * Before this existed the site carried a hand-maintained 1:1 port of the
 * renderer, which had already drifted from the engine in two places with both
 * test suites green.
 */
export * from './nameTemplate.js';
export * from './stringTransforms.js';
export * from './types.js';
