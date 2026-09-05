import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The root `package.json`'s `version` field. Unlike `GIT_COMMIT`, this needs no
 * build-arg: the file is already copied into the runtime image alongside
 * `core/dist` and `bot/dist` (see the Dockerfile), two directories up from this
 * module in dev, under vitest, and in the container alike, so there is nowhere
 * for it to drift out of sync with what's actually running.
 *
 * Lives in `core`, not `bot`, because `core/src/backup/cli.ts` needs it too —
 * the manifest it writes has its own `appVersion` field. One read serves both.
 * Caught, not eager: a packaging slip here shouldn't be able to take the whole
 * bot down at boot over a cosmetic version string.
 */
function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(here, '../../package.json'), 'utf8')) as {
      version: string;
    };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

/**
 * Build/version identifiers, surfaced on `/health`, `/diagnostics`, `/ping`,
 * and backup manifests. `||`, not `??`: an env var explicitly set to `''` is
 * "unset" here, not a real override — `??` only catches `null`/`undefined`
 * and would otherwise report a blank version or commit.
 */
export const VERSION = process.env.APP_VERSION || readPackageVersion();
export const COMMIT = process.env.GIT_COMMIT || 'dev';
