/** Build/version identifiers, sourced from env at deploy time. */
export const VERSION = process.env.APP_VERSION ?? '0.1.0';
export const COMMIT = process.env.GIT_COMMIT ?? 'dev';
