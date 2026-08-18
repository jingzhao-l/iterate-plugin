/**
 * scripts/build-client.mjs — build `lib/client.js` for the dsh web shell.
 *
 * Bundles `src/client/index.ts` (plus the pure parse helpers from
 * `lib/parse.js`) into a single artifact matching the dsh GUI loader protocol:
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ... return module.exports; } })
 *
 * - All local code is inlined (no relative imports at runtime).
 * - `react` (and friends) are externals: resolved by the injected `require`
 *   against the shell's frozen platform module table.
 * - The factory returns `module.exports`, from which the loader reads the
 *   standard module contract: `name`, `inject`, `apply`.
 *
 * This mirrors the proven dsh-hooks client build (its tsdown config uses the
 * same message: banner + `var module/exports` intro + `return module.exports`
 * footer + externals). esbuild emits CommonJS, so `var module = { exports: {} };
 * var exports = module.exports;` declared at factory scope is what the bundle's
 * `module.exports`/`exports` references resolve to.
 */

import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const id = 'iterate-plugin'
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outfile = resolve(root, 'lib/client.js')

async function main() {
  const banner = `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {
var module = { exports: {} };
var exports = module.exports;`

  const footer = `return module.exports; } });
`

  const result = await build({
    entryPoints: [resolve(root, 'src/client/index.ts')],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    // Externals must live in the shell's frozen platform module table
    // (react, react/jsx-runtime, react-dom/client are seed entries).
    external: ['react', 'react/jsx-runtime', 'react-dom/client'],
    // The source bundle referencing `import * as React` must NOT go through a
    // `__toESM(...).default` indirection (react's module.exports is the React
    // object itself, there is no `.default`). `import * as React` already maps
    // to the module object directly for `export =`-style CJS deps, which is the
    // shape esbuild emits for external `require("react")`.
    jsx: 'transform',
    banner: { js: banner },
    footer: { js: footer },
    legalComments: 'none',
    sourcemap: false,
    write: true,
    logLevel: 'info',
    metafile: false,
  })

  if (!result.outputFiles?.[0]) {
    // `write: true` doesn't return outputFiles; nothing to report here.
  }
  return result
}

main().catch((err) => {
  console.error('[build-client] failed:', err)
  process.exitCode = 1
})