import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import {
  HIDDEN_PANEL_IDS,
  activePanelSource,
  panelPluginsSource,
  panelRows,
  readPanelsCollapsed,
  writePanelsCollapsed,
} from '../src/client/panel-plugins.js'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const FakeIcon = () => null

test('panelRows hides built-in plugins/schedules, deduplicates, resolves labels and sorts by order', () => {
  assert.equal(HIDDEN_PANEL_IDS.has('plugins'), true)
  assert.equal(HIDDEN_PANEL_IDS.has('schedules'), true)
  const rows = panelRows([
    { options: { id: 'plugins', order: 0, label: () => 'Plugins' }, component: FakeIcon },
    { options: { id: 'schedules', order: 1, label: () => 'Automation' }, component: FakeIcon },
    { options: { id: 'media-desk', order: 40, label: 'Media Desk' }, component: FakeIcon },
    { options: { id: 'life-wiki', order: 25, label: () => 'Life Wiki' }, component: FakeIcon },
    { options: { id: 'life-wiki', order: 99, label: () => 'Duplicate' }, component: FakeIcon },
    { options: { id: 'broken-label', order: 50, label: () => { throw new Error('boom') } }, component: null },
    { options: { id: '', order: 1, label: 'Empty id' }, component: FakeIcon },
  ])
  assert.deepEqual(
    rows.map(({ id, order, label, Icon }) => ({ id, order, label, hasIcon: Icon === FakeIcon })),
    [
      { id: 'life-wiki', order: 25, label: 'Life Wiki', hasIcon: true },
      { id: 'media-desk', order: 40, label: 'Media Desk', hasIcon: true },
      { id: 'broken-label', order: 50, label: 'broken-label', hasIcon: false },
    ],
  )
})

test('panelPluginsSource caches snapshots and refreshes on slot or locale change', () => {
  let version = 1
  let revision = 1
  let entries = [{ options: { id: 'life-wiki', order: 25, label: () => (revision === 1 ? 'Life Wiki' : '人生知识库') }, component: FakeIcon }]
  const slotListeners = new Set()
  const localeListeners = new Set()
  const slots = {
    getVersion: () => version,
    entriesOfSlot: () => entries,
    subscribe: (_name, fn) => { slotListeners.add(fn); return () => slotListeners.delete(fn) },
  }
  const locale = {
    getSnapshot: () => ({ revision }),
    subscribe: (fn) => { localeListeners.add(fn); return () => localeListeners.delete(fn) },
  }
  const source = panelPluginsSource(slots, () => locale)
  let notified = 0
  const off = source.subscribe(() => { notified += 1 })

  const first = source.getSnapshot()
  assert.equal(source.getSnapshot(), first)
  assert.equal(first.length, 1)
  assert.equal(first[0].label, 'Life Wiki')

  revision = 2
  for (const fn of localeListeners) fn()
  const second = source.getSnapshot()
  assert.notEqual(second, first)
  assert.equal(second[0].label, '人生知识库')
  assert.equal(notified, 1)

  version = 2
  entries = [
    ...entries,
    { options: { id: 'workflow-lite', order: 10, label: () => 'Workflow' }, component: FakeIcon },
  ]
  for (const fn of slotListeners) fn()
  const third = source.getSnapshot()
  assert.deepEqual(third.map(row => row.id), ['workflow-lite', 'life-wiki'])
  assert.equal(notified, 2)

  off()
  assert.equal(slotListeners.size, 0)
  assert.equal(localeListeners.size, 0)
})

test('activePanelSource reads layout.panelInfo and degrades safely when absent', () => {
  assert.equal(activePanelSource(undefined).getSnapshot(), null)
  let activePanelId = null
  const listeners = new Set()
  const source = activePanelSource({
    panelInfo: {
      getSnapshot: () => ({ activePanelId }),
      subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    },
  })
  let hits = 0
  const off = source.subscribe(() => { hits += 1 })
  assert.equal(source.getSnapshot(), null)
  activePanelId = 'life-wiki'
  for (const fn of listeners) fn()
  assert.equal(source.getSnapshot(), 'life-wiki')
  assert.equal(hits, 1)
  off()
  assert.equal(listeners.size, 0)
})

test('readPanelsCollapsed and writePanelsCollapsed persist to storage', () => {
  const map = new Map()
  const storage = {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
  }
  assert.equal(readPanelsCollapsed(storage), false)
  writePanelsCollapsed(true, storage)
  assert.equal(readPanelsCollapsed(storage), true)
  writePanelsCollapsed(false, storage)
  assert.equal(readPanelsCollapsed(storage), false)
})

const { outputFiles } = await build({
  stdin: { contents: "export { PanelPluginsDock, TeamSidebar } from './src/client/sidebar.js'", resolveDir: PLUGIN },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const reactStub = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useCallback: fn => fn,
  useSyncExternalStore: (_sub, get) => get(),
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  Fragment: Symbol('Fragment'),
  useEffect() {},
  useLayoutEffect() {},
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useMemo: make => make(),
  useRef: current => ({ current }),
  useId: () => 'id',
}
const vmMod = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module: vmMod,
  exports: vmMod.exports,
  window: { innerWidth: 1280 },
  require: name => (name === 'react' ? reactStub : {}),
})
const { PanelPluginsDock } = vmMod.exports

const walk = (node, match, out = []) => {
  if (Array.isArray(node)) { for (const child of node) walk(child, match, out); return out }
  if (!node || typeof node !== 'object') return out
  if (match(node)) out.push(node)
  walk(node.props?.children, match, out)
  return out
}

test('PanelPluginsDock renders null when empty, wide rows when open, and rail buttons when narrow', () => {
  assert.equal(PanelPluginsDock({ wide: true, panels: [], activePanelId: null, onSelect: () => {} }), null)

  const selected = []
  const panels = [
    { id: 'life-wiki', order: 25, label: 'Life Wiki', Icon: FakeIcon },
    { id: 'media-desk', order: 40, label: 'Media Desk', Icon: null },
  ]
  const wideTree = PanelPluginsDock({ wide: true, panels, activePanelId: 'life-wiki', onSelect: id => selected.push(id) })
  const rows = walk(wideTree, n => n.type === 'button' && n.props?.['data-panel-id'])
  assert.deepEqual(rows.map(r => r.props['data-panel-id']), ['life-wiki', 'media-desk'])
  assert.equal(rows[0].props['aria-current'], 'page')
  assert.equal(rows[1].props['aria-current'], undefined)
  rows[0].props.onClick()
  assert.deepEqual(selected, ['life-wiki'])

  const railTree = PanelPluginsDock({ wide: false, panels, activePanelId: 'media-desk', onSelect: id => selected.push(id) })
  const railButtons = walk(railTree, n => n.type === 'button' && n.props?.className === 'bt-plugin-rail-btn')
  assert.deepEqual(railButtons.map(b => b.props['data-panel-id']), ['life-wiki', 'media-desk'])
  assert.equal(railButtons[0].props['aria-current'], undefined)
  assert.equal(railButtons[1].props['aria-current'], 'page')
  railButtons[1].props.onClick()
  assert.deepEqual(selected, ['life-wiki', 'media-desk'])
})
