/**
 * src/client/lang.ts — the React binding for the language layer.
 *
 * Kept in its own module because two client surfaces need it: the slot
 * components in `index.ts` (wrapped by `withLang`) and the Markdown-fence
 * report card in `fence.ts` (its own slot layer, not wrapped by `apply()`).
 * The dependency direction stays one-way — i18n.ts remains React-free — and
 * every component that renders `t()` / `tf()` subscribes here, so a language
 * switch repaints it.
 */

// dsh's __ModuleLoader__ provides require(); see index.ts for the contract.
declare function require(name: string): unknown
const React = require('react') as typeof import('react')
import { getLang, subscribeLang, type Lang } from './i18n.ts'

/** Current UI language, repainting the caller when it changes. */
export function useLang(): Lang {
  const [lang, set] = React.useState<Lang>(getLang())
  React.useEffect(() => subscribeLang(set), [])
  return lang
}
