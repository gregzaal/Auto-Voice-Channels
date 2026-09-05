/**
 * Re-exported from `@avc/core` so every existing `bot/src` import of
 * `VERSION`/`COMMIT` from `./version.js` keeps working unchanged. The read
 * itself lives in `core` because `core/src/backup/cli.ts` needs it too — see
 * `plans/versioning.md` §6.
 */
export { COMMIT, VERSION } from '@avc/core';
