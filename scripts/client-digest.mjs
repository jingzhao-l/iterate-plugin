/**
 * scripts/client-digest.mjs — reproducible source digest for the client bundle.
 *
 * `lib/client.js` is a *committed* build artifact: the dsh web shell loads it
 * through `package.json` `exports["./client"]`, and a git-clone install ships
 * whatever is in the tree. That means an edit to `src/client/index.ts` (or the
 * parse helpers it inlines) without a `npm run build:client` publishes a stale
 * UI. The digest is embedded in the bundle header by `build-client.mjs` and
 * re-computed by `test/package-contract.test.ts`, so a stale bundle fails the
 * test suite instead of shipping.
 *
 * The digest covers every file esbuild inlines: the whole `src/client/` tree
 * plus the `lib/parse.js` helpers — hashing those inputs, in a fixed order, as
 * read from disk, fully determines the user-visible bundle inputs.
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Files esbuild inlines into `lib/client.js`: the whole client source tree plus the parse helpers. */
export const clientSourceFiles = (root) => {
  const clientDir = resolve(root, 'src/client')
  const stack = ['']
  const rels = []
  while (stack.length > 0) {
    const dir = stack.pop()
    for (const entry of readdirSync(join(clientDir, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name
      if (entry.isDirectory()) stack.push(rel)
      else if (/\.(ts|tsx|css)$/.test(entry.name)) rels.push(`src/client/${rel}`)
    }
  }
  return [...rels.sort(), 'lib/parse.js']
}

/** Marker the built bundle carries so tests can extract the recorded digest. */
export const DIGEST_MARKER = 'iterate-plugin client source-digest: '

/**
 * SHA-256 over the client bundle's source inputs.
 *
 * @param {string} root package root (directory containing `package.json`)
 * @returns {string} lowercase hex digest
 */
export function clientSourceDigest(root) {
  const hash = createHash('sha256')
  for (const rel of clientSourceFiles(root)) {
    hash.update(rel)
    hash.update('\0')
    hash.update(readFileSync(resolve(root, rel)))
    hash.update('\0')
  }
  return hash.digest('hex')
}

/** Package root of the iterate-plugin checkout. */
export function packageRoot() {
  return dirname(dirname(fileURLToPath(import.meta.url)))
}
