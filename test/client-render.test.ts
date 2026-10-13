/**
 * test/client-render.test.ts — mount the browser half under Node.
 *
 * The client (`src/client/index.ts`) is bundled for dsh's GUI loader, where
 * `react` is resolved from the shell's frozen module table through an injected
 * `require`. That indirection is why the client had NO render coverage: it
 * cannot be imported under plain Node. This harness supplies exactly what the
 * shell would (`globalThis.require` → the real react, a `window` with
 * `localStorage`), boots `apply()` with a fake ClientContext, and mounts each
 * registered slot through `react-dom/client` inside jsdom. Panels keep their
 * collapsed-by-default states (the observatory, the guide cards) testable for
 * the first time, because a click is now possible.
 *
 * What this locks down (all previously untestable):
 *   1. every slot component mounts without throwing,
 *   2. the empty / running / report states show the right copy,
 *   3. the bilingual UI dictionary is actually wired (zh and en both render),
 *   4. `apply()` degrades instead of throwing when a service is missing.
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { describe, it, before, beforeEach, afterEach } from 'node:test'
import { setLang } from '../src/client/i18n.ts'
import { noteSession } from '../src/client/session-cache.ts'

// ─── Shell emulation ─────────────────────────────────────────────────────────

const nodeRequire = createRequire(import.meta.url)

interface Registration {
  meta: { name: string; id: string; order?: number; label?: () => string; select?: (owner: unknown) => unknown }
  render: (props: Record<string, unknown>) => unknown
}

const registrations: Registration[] = []

function fakeClientContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slots: {
      inject(_slot: string, getLayer?: () => void) {
        // The real service resolves the layer lazily; the layer body performs
        // the register() call.
        try {
          getLayer?.()
        } catch {
          /* a missing layer must not break apply() */
        }
      },
      register(meta: Registration['meta'], render: Registration['render']) {
        registrations.push({ meta, render })
        return () => {}
      },
    },
    theme: { overrideTokens: () => () => {} },
    on: () => () => {},
    effect: () => () => {},
    get: () => undefined,
    ...overrides,
  }
}

type ReactApi = {
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): unknown
  act(cb: () => void | Promise<void>): void | Promise<void>
}
/**
 * The slice of the DOM API these tests use, declared locally because the root
 * tsconfig (correctly) has no `DOM` lib — the plugin's server half must never
 * reach for `window`. jsdom provides the real implementation at runtime.
 */
interface Rendered {
  textContent: string | null
  querySelector(selector: string): Rendered | null
  querySelectorAll(selector: string): Rendered[]
  getAttribute(name: string): string | null
  click(): void
  remove(): void
}

interface TestDocument {
  createElement(tag: string): Rendered
  body: { appendChild(child: Rendered): void }
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  clear(): void
}

/** The jsdom surface this harness touches — typed locally for the same reason. */
interface JSDOMLike {
  window: {
    document: TestDocument
    navigator: { language?: string }
    localStorage: StorageLike
    HTMLElement: unknown
    Element: unknown
    Node: unknown
    Blob: unknown
    URL: unknown
    getComputedStyle(el: unknown): unknown
  }
}

type Mount = (props: Record<string, unknown>) => Rendered

let client: { name: string; inject: readonly string[]; apply(ctx: unknown): void }
let React: ReactApi
let createRoot: (container: Rendered) => { render(el: unknown): void; unmount(): void }
let document: TestDocument
let localStorage: StorageLike

before(async () => {
  const { JSDOM } = nodeRequire('jsdom') as {
    JSDOM: new (html: string, opts?: { url?: string }) => JSDOMLike
  }
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://dsh.local/' })
  const define = (key: string, value: unknown) =>
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  define('window', dom.window)
  define('document', dom.window.document)
  define('navigator', dom.window.navigator)
  define('localStorage', dom.window.localStorage)
  define('HTMLElement', dom.window.HTMLElement)
  define('Element', dom.window.Element)
  define('Node', dom.window.Node)
  define('Blob', dom.window.Blob)
  define('URL', dom.window.URL)
  define('getComputedStyle', dom.window.getComputedStyle.bind(dom.window))
  // Pin a Chinese locale so the suite's copy assertions are deterministic:
  // `apply()` resolves the startup language from navigator.language, and a
  // zh-CN locale is what a Chinese user's browser reports. The English path is
  // exercised explicitly through the settings switch instead.
  Object.defineProperty(dom.window.navigator, 'language', { value: 'zh-CN', configurable: true })
  // React's act() refuses to run outside a test environment otherwise.
  define('IS_REACT_ACT_ENVIRONMENT', true)
  document = dom.window.document
  localStorage = dom.window.localStorage

  // dsh's loader injects `require`; Node ESM has none, so mirror the shell.
  define('require', (id: string) => nodeRequire(id))
  React = nodeRequire('react') as ReactApi
  createRoot = (nodeRequire('react-dom/client') as { createRoot(c: Rendered): ReturnType<Mount2Root> }).createRoot
  client = (await import('../src/client/index.ts')) as typeof client
})

type Mount2Root = () => { render(el: unknown): void; unmount(): void }

/** Apply the plugin once and return a mount helper per registered slot id. */
function boot(): Map<string, Mount> {
  registrations.length = 0
  client.apply(fakeClientContext())
  const byId = new Map<string, Mount>()
  for (const r of registrations) {
    byId.set(r.meta.id, (props) => {
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      React.act(() => {
        root.render(r.render(props))
      })
      return container
    })
  }
  return byId
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const FINDING_A = {
  file: 'src/app.ts',
  line: 12,
  dimension: 'correctness',
  severity: 'high',
  summary: 'Off-by-one when the list is empty',
  detail: 'The guard runs after the index is already computed.',
}
const FINDING_B = {
  file: 'src/util.ts',
  line: 4,
  dimension: 'security',
  severity: 'low',
  summary: 'Unbounded log line',
  detail: 'User input is echoed into the log without truncation.',
}

/** A review report that satisfies `isReviewReport` and survives normalization. */
function reportFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    rounds: [{ round: 1, findings: [FINDING_A, FINDING_B] }],
    findings: [FINDING_A, FINDING_B],
    convergence: { totalRounds: 3, findingsByRound: [2], converged: false },
    ...overrides,
  }
}

/** A running transcript (round 2 of 3, mid-review). */
function transcriptFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    project: '/srv/proj',
    updatedAt: '2026-10-11T00:00:00.000Z',
    active: true,
    mode: 'normal',
    taskMode: 'iterate',
    goal: 'ship it',
    phases: ['review'],
    round: 2,
    maxRounds: 3,
    rounds: [],
    convergence: [],
    findings: [],
    fixes: [],
    validations: [],
    ...overrides,
  }
}

/** Click helper that keeps React in the loop (state updates flush inside act). */
function click(el: Rendered | null | undefined): void {
  assert.ok(el, 'element to click exists')
  React.act(() => el.click())
}

function buttonByText(root: Rendered, text: string): Rendered | undefined {
  return [...root.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(text))
}

const containers: Rendered[] = []
function mountSlot(slots: Map<string, Mount>, id: string, props: Record<string, unknown> = {}): Rendered {
  const el = slots.get(id)?.(props)
  assert.ok(el, `slot ${id} registered`)
  containers.push(el)
  return el
}

beforeEach(() => {
  localStorage.clear()
  // The session cache is module state shared by every mounted slot — without
  // this the settings panel would keep reading the previous test's config.
  noteSession(null)
})

afterEach(() => {
  for (const c of containers.splice(0)) c.remove()
  localStorage.clear()
})

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('client bootstrap', () => {
  it('declares the module contract the dsh loader reads', () => {
    assert.equal(client.name, 'iterate-plugin')
    assert.deepEqual(client.inject, ['slots', 'theme'])
  })

  it('registers all five render entries across three slots', () => {
    const slots = boot()
    assert.deepEqual(
      [...slots.keys()].sort(),
      ['iterate-dashboard', 'iterate-observatory', 'iterate-progress', 'iterate-settings', 'iterate-turn-tail'],
    )
  })

  it('labels the settings slot and scopes the turn-tail chain with a selector', () => {
    boot()
    const settings = registrations.find((r) => r.meta.id === 'iterate-settings')
    const tail = registrations.find((r) => r.meta.id === 'iterate-turn-tail')
    assert.equal(settings?.meta.label?.(), 'iterate')
    assert.equal(typeof tail?.meta.select, 'function')
    assert.deepEqual(tail?.meta.select?.({ turn: {} }), null, 'no iterate data → chain not selected')
    assert.deepEqual(
      tail?.meta.select?.({ turn: { report: reportFixture() } }),
      { matched: true },
      'a report in the turn selects the chain',
    )
  })

  it('degrades without throwing when a service is missing', () => {
    assert.doesNotThrow(() => client.apply(fakeClientContext({ slots: undefined })))
    assert.doesNotThrow(() => client.apply(fakeClientContext({ slots: { inject: undefined, register: undefined } })))
    assert.doesNotThrow(() => client.apply(fakeClientContext({ theme: undefined })))
  })

  it('renders every registered slot against an empty session without throwing', () => {
    const slots = boot()
    for (const id of slots.keys()) {
      assert.doesNotThrow(() => mountSlot(slots, id, { session: {}, turn: {} }), `${id} renders an empty session`)
    }
  })
})

describe('ConvergenceDashboard', () => {
  it('renders the onboarding empty state with both start commands', () => {
    const html = mountSlot(boot(), 'iterate-dashboard', { session: {} }).textContent ?? ''
    assert.match(html, /完整迭代/)
    assert.match(html, /仅评审/)
    assert.match(html, /运行一次评审后/)
  })

  it('hides the start buttons and shows the running state while a run is live', () => {
    const html = mountSlot(boot(), 'iterate-dashboard', { session: { transcript: transcriptFixture() } }).textContent ?? ''
    assert.doesNotMatch(html, /完整迭代/, 'no start button mid-run')
    assert.match(html, /运行中/)
    assert.match(html, /第 2 轮进行中/)
    assert.match(html, /阶段「review」/)
  })

  it('shows the task_mode chip only while a transcript is around', () => {
    const strip = mountSlot(boot(), 'iterate-dashboard', {
      session: { report: reportFixture(), transcript: transcriptFixture({ taskMode: 'code' }) },
    }).textContent ?? ''
    assert.match(strip, /● code/)

    const noTranscript = mountSlot(boot(), 'iterate-dashboard', {
      session: { report: reportFixture() },
    }).textContent ?? ''
    assert.doesNotMatch(noTranscript, /● code/, 'no transcript → the chip stays hidden')
  })

  it('renders the convergence strip for a finished report', () => {
    const html = mountSlot(boot(), 'iterate-dashboard', { session: { report: reportFixture() } }).textContent ?? ''
    assert.match(html, /Round 1 \/ 3/)
    assert.match(html, /HIGH 1/)
    assert.match(html, /correctness/)
    assert.doesNotMatch(html, /完整迭代/, 'start buttons are hidden once a report exists')
  })

  it('marks a converged report', () => {
    const html = mountSlot(boot(), 'iterate-dashboard', {
      session: { report: reportFixture({ convergence: { totalRounds: 2, findingsByRound: [2, 0], converged: true } }) },
    }).textContent ?? ''
    assert.match(html, /已收敛/)
  })

  it('surfaces attached images as a chip', () => {
    const html = mountSlot(boot(), 'iterate-dashboard', {
      session: { report: reportFixture(), messages: [{ role: 'user', content: [{ type: 'image', attachment: {} }] }] },
    }).textContent ?? ''
    assert.match(html, /附件图片/)
  })
})

describe('TurnTailEntry', () => {
  it('renders nothing for a turn that carries no iterate data', () => {
    assert.equal(mountSlot(boot(), 'iterate-turn-tail', { turn: {}, session: {} }).textContent, '')
  })

  it('renders the triage panel with per-finding verdict actions', () => {
    const html = mountSlot(boot(), 'iterate-turn-tail', { turn: { report: reportFixture() } }).textContent ?? ''
    assert.match(html, /Off-by-one when the list is empty/)
    assert.match(html, /src\/app\.ts/)
    assert.match(html, /HIGH/, 'severity is rendered in its display form')
  })
})

describe('ObservatoryPanel', () => {
  it('offers the disk-snapshot pull when nothing has been observed yet', () => {
    const panel = mountSlot(boot(), 'iterate-observatory', { session: {} })
    assert.match(panel.textContent ?? '', /观测台/)
    assert.match(panel.textContent ?? '', /暂无运行时观测数据/)
    assert.ok(buttonByText(panel, '拉取磁盘快照'), 'the pull instruction button is offered')
  })

  it('expands from its collapsed header into the full tab strip', () => {
    const panel = mountSlot(boot(), 'iterate-observatory', { session: { transcript: transcriptFixture() } })
    const head = panel.querySelector('.iterate-obs-head')
    assert.ok(head, 'a live manifest renders the expandable header')
    assert.doesNotMatch(panel.textContent ?? '', /F10/, 'tabs are hidden while collapsed')

    click(head)
    const open = panel.textContent ?? ''
    for (const tab of ['实时活动流', '审查线程', '收敛趋势', '发现定位', '修复与回滚', '断点恢复', '运行控制台', '决策时间线', '质量门禁', '经验银行', '防御事件']) {
      assert.ok(open.includes(tab), `tab "${tab}" is rendered`)
    }
  })

  it('renders a quality-gate snapshot pulled from the session stream', () => {
    const session = {
      toolCalls: [
        {
          tool: 'iterate_quality_gate',
          result: {
            operation: 'compute',
            overallStatus: 'pass',
            overallScore: 92,
            dimensions: [{ dimension: 'correctness', convergenceRate: 1, totalFindings: 3, fixedFindings: 3 }],
          },
        },
      ],
      transcript: transcriptFixture(),
    }
    const panel = mountSlot(boot(), 'iterate-observatory', { session })
    click(panel.querySelector('.iterate-obs-head'))
    click(buttonByText(panel, '质量门禁'))
    assert.match(panel.textContent ?? '', /correctness/)
  })
})

describe('SettingsPanel', () => {
  it('renders every settings card', () => {
    const html = mountSlot(boot(), 'iterate-settings', {}).textContent ?? ''
    assert.match(html, /配置管理/)
    assert.match(html, /状态概览/)
    assert.match(html, /分诊持久化/)
    assert.match(html, /迭代主题/)
  })

  it('arms the destructive clear button before it clears anything', () => {
    const panel = mountSlot(boot(), 'iterate-settings', {})
    const clear = buttonByText(panel, '清除分诊')
    assert.ok(clear, 'clear button is rendered')
    click(clear)
    assert.match(panel.textContent ?? '', /确认清除？/)
  })
})

describe('config read-back (settings)', () => {
  const configSession = (config: Record<string, unknown>): Record<string, unknown> => ({
    toolCalls: [{ tool: 'iterate_config', result: { found: true, config } }],
  })

  it('starts un-read and still hands over the instruction when the clipboard refuses', async () => {
    const slots = boot()
    const settings = mountSlot(slots, 'iterate-settings', {})
    assert.match(settings.textContent ?? '', /尚未回读当前配置/)
    // No VALUE line yet — only the "you will see it here" promise (which
    // literally mentions 当前值, hence matching the value-shaped prefix).
    assert.doesNotMatch(settings.textContent ?? '', /当前值 验证命令：/)

    // jsdom has no clipboard, so this exercises the FAILURE path: the button
    // must not be a dead end — the instruction is revealed for manual copy.
    const btn = buttonByText(settings, '回读当前配置')
    assert.ok(btn, 'read-back button is rendered')
    await React.act(async () => btn!.click())

    const body = settings.textContent ?? ''
    assert.match(body, /回读指令（粘贴给模型）/)
    assert.match(body, /iterate_config/)
    assert.match(body, /"operation": "read"/)
    assert.match(body, /剪贴板写入被拒绝/, 'the refused clipboard is reported, not swallowed')
  })

  it('shows the current value once a session-scoped slot published a read-back', () => {
    const slots = boot()
    // The real wiring: the DASHBOARD (session scope) publishes what the host
    // handed it; the ROOT-scoped settings panel only ever reads the cache.
    mountSlot(slots, 'iterate-dashboard', {
      session: configSession({
        goal: 'ship it',
        dimensions: ['correctness'],
        max_rounds: 3,
        validation: { commands: ['npm test', 'npm run lint'] },
      }),
    })
    const settings = mountSlot(slots, 'iterate-settings', {})
    const text = settings.textContent ?? ''
    assert.match(text, /当前值 验证命令：\["npm test","npm run lint"\]/)
    assert.doesNotMatch(text, /尚未回读当前配置/)
  })

  it('distinguishes "never read" from "read, but this field is absent"', () => {
    const slots = boot()
    mountSlot(slots, 'iterate-dashboard', {
      session: configSession({ goal: 'ship it', dimensions: ['correctness'], max_rounds: 3, language: 'zh' }),
    })
    const settings = mountSlot(slots, 'iterate-settings', {})
    // validation.commands is the default selection and the read-back has no
    // `validation` section — say so instead of showing a fabricated value.
    assert.match(settings.textContent ?? '', /回读结果中没有 验证命令/)
    assert.doesNotMatch(settings.textContent ?? '', /尚未回读当前配置/)
  })

  it('translates the read-back block to English', () => {
    localStorage.setItem('iterate-ui-lang', 'en')
    const slots = boot()
    const empty = mountSlot(slots, 'iterate-settings', {})
    assert.match(empty.textContent ?? '', /No config read back yet/)
    assert.ok(buttonByText(empty, 'Read back current config'), 'the button is localized')

    mountSlot(slots, 'iterate-dashboard', {
      session: configSession({ goal: 'ship it', dimensions: [], max_rounds: 5, validation: { commands: ['npm test'] } }),
    })
    const settings = mountSlot(slots, 'iterate-settings', {})
    assert.match(settings.textContent ?? '', /Current value for Validation commands: \["npm test"\]/)
    assert.doesNotMatch(settings.textContent ?? '', /回读/)
  })
})

describe('language switch', () => {
  it('flips every panel to English and persists the choice', () => {
    const slots = boot()
    const settings = mountSlot(slots, 'iterate-settings', {})

    assert.match(settings.textContent ?? '', /配置管理/, 'the zh-CN locale starts in Chinese')

    const toggle = [...settings.querySelectorAll('button[role="switch"]')].find(
      (b) => b.getAttribute('aria-label') === '切换界面语言',
    )
    assert.ok(toggle, 'the language switch is rendered')
    click(toggle)

    assert.match(settings.textContent ?? '', /Configuration/)
    assert.doesNotMatch(settings.textContent ?? '', /配置管理/)
    assert.equal(localStorage.getItem('iterate-ui-lang'), 'en', 'the choice is persisted')

    // A fresh boot (as after a reload) picks the persisted language back up
    // even though the browser locale still says zh-CN.
    const dashboard = mountSlot(boot(), 'iterate-dashboard', { session: {} })
    assert.match(dashboard.textContent ?? '', /Full iteration/)
    assert.doesNotMatch(dashboard.textContent ?? '', /完整迭代/)
  })

  it('translates the dashboard, triage panel and observatory tabs', () => {
    // The persisted preference beats the locale — the English-README reader on
    // a zh machine, or the reverse, gets the language they chose.
    localStorage.setItem('iterate-ui-lang', 'en')
    const slots = boot()

    const running = mountSlot(slots, 'iterate-dashboard', { session: { transcript: transcriptFixture() } })
      .textContent ?? ''
    assert.match(running, /Running/)
    assert.match(running, /Round 2 in progress/)

    const triage = mountSlot(slots, 'iterate-turn-tail', { turn: { report: reportFixture() } }).textContent ?? ''
    assert.match(triage, /Findings triage \(2\/2\)/)
    assert.doesNotMatch(triage, /分诊/)

    // A live manifest renders the collapsed header (running badge + hotkey hint).
    const obs = mountSlot(slots, 'iterate-observatory', { session: { transcript: transcriptFixture() } })
    assert.match(obs.textContent ?? '', /Running/)
    assert.match(obs.textContent ?? '', /keys 1-9\/0 switch Fn/)
    click(obs.querySelector('.iterate-obs-head'))
    for (const tab of ['Review threads', 'Convergence trend', 'Quality gate', 'Defense events']) {
      assert.ok((obs.textContent ?? '').includes(tab), `tab "${tab}" is rendered in English`)
    }
    assert.doesNotMatch(obs.textContent ?? '', /审查线程/)

    // Settings: CONFIG_EDIT_FIELDS labels/hints reach the UI through the config
    // picker, so they must follow the language too (parse.js ships both halves).
    const settings = mountSlot(slots, 'iterate-settings', {})
    const settingsText = settings.textContent ?? ''
    assert.match(settingsText, /Validation commands \(validation\.commands\)/)
    assert.match(settingsText, /An empty array = no verification/)
    assert.doesNotMatch(settingsText, /验证命令/)

    // The expanded guides stay Chinese on purpose — they are the contract text
    // pasted back to the model — so the panel says so rather than looking like
    // a missed translation.
    click(buttonByText(settings, 'Expand'))
    assert.match(settings.textContent ?? '', /Chinese \(contract text to paste to the model\)/)
  })
})
