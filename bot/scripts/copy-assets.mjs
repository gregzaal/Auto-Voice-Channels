import { cpSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Non-TS runtime assets. `tsc` only emits `.js`/`.d.ts`, and the Docker runtime
// stage copies `bot/dist` alone, so anything read at runtime has to be placed
// beside its module in `dist/` exactly as it sits in `src/`.
//
// `cpSync` throws on a missing source, so renaming an asset without updating
// this list fails the build instead of shipping a container that dies on boot.
const assets = ['features/templateAssistant/systemPrompt.md'];

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

for (const rel of assets) {
  const to = resolve(pkgRoot, 'dist', rel);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(resolve(pkgRoot, 'src', rel), to);
}
