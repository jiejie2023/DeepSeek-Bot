// Third-party DSH sidebar panel entries (`sidebar.panellist`) surfaced inside DS Bot's
// own left column. DSH's built-in `plugins` and `schedules` panels already have dedicated
// entries in DS Bot's footer and account menu, so only other installed panels show here.
import { Component, createElement as h } from 'react'
import { PlugIcon } from './icons.js'
import { STORAGE } from './storage.js'

export const HIDDEN_PANEL_IDS = new Set(['plugins', 'schedules'])

const resolveLabel = (label, fallback) => {
  try {
    const value = typeof label === 'function' ? label() : label
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
  } catch {
    return fallback
  }
}

const isRenderableComponent = value => typeof value === 'function'
  || (typeof value === 'object' && value !== null && '$$typeof' in value)

export function panelRows(entries) {
  if (!Array.isArray(entries)) return []
  const seen = new Set()
  const rows = []
  for (const entry of entries) {
    const id = entry?.options?.id ?? ''
    if (!id || HIDDEN_PANEL_IDS.has(id) || seen.has(id)) continue
    seen.add(id)
    rows.push({
      id,
      order: Number.isFinite(entry.options.order) ? entry.options.order : 0,
      label: resolveLabel(entry.options.label, id),
      Icon: isRenderableComponent(entry.component) ? entry.component : null,
    })
  }
  return rows.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
}

export function panelPluginsSource(slots, localeOf) {
  let version = -1
  let revision = -1
  let rows = []
  const readEntries = () => (typeof slots?.entriesOfSlot === 'function'
    ? slots.entriesOfSlot('sidebar.panellist')
    : slots?.entries?.('sidebar.panellist') ?? [])
  return {
    getSnapshot: () => {
      const nextVersion = slots?.getVersion?.('sidebar.panellist') ?? 0
      const nextRevision = localeOf?.()?.getSnapshot?.()?.revision ?? 0
      if (nextVersion !== version || nextRevision !== revision) {
        version = nextVersion
        revision = nextRevision
        rows = panelRows(readEntries())
      }
      return rows
    },
    subscribe: (listener) => {
      const offs = []
      if (typeof slots?.subscribe === 'function') offs.push(slots.subscribe('sidebar.panellist', listener))
      const locale = localeOf?.()
      if (typeof locale?.subscribe === 'function') offs.push(locale.subscribe(listener))
      return () => { for (const off of offs) off() }
    },
  }
}

export function activePanelSource(layout) {
  const info = layout?.panelInfo
  return {
    getSnapshot: () => info?.getSnapshot?.()?.activePanelId ?? null,
    subscribe: (listener) => (typeof info?.subscribe === 'function' ? info.subscribe(listener) : () => {}),
  }
}

export function readPinnedPanels(storage = globalThis.localStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem(STORAGE.pinnedPanels) ?? '[]')
    if (!Array.isArray(parsed)) return []
    const seen = new Set()
    const out = []
    for (const item of parsed) {
      if (typeof item !== 'string' || item === '' || HIDDEN_PANEL_IDS.has(item) || seen.has(item)) continue
      seen.add(item)
      out.push(item)
    }
    return out
  } catch {
    return []
  }
}

export function writePinnedPanels(ids, storage = globalThis.localStorage) {
  try {
    if (!Array.isArray(ids) || ids.length === 0) storage?.removeItem(STORAGE.pinnedPanels)
    else storage?.setItem(STORAGE.pinnedPanels, JSON.stringify(ids))
  } catch { /* storage unavailable */ }
}

export function togglePinnedPanel(ids, id) {
  if (typeof id !== 'string' || id === '' || HIDDEN_PANEL_IDS.has(id)) return ids
  return ids.includes(id) ? ids.filter(item => item !== id) : [...ids, id]
}

const BaseComponent = typeof Component === 'function' ? Component : null
const IconGuard = BaseComponent
  ? class IconGuard extends BaseComponent {
      state = { failed: false, icon: this.props.Icon }
      static getDerivedStateFromError() { return { failed: true } }
      static getDerivedStateFromProps(props, state) {
        return props.Icon === state.icon ? null : { failed: false, icon: props.Icon }
      }
      render() {
        if (this.state.failed || !this.props.Icon) return h(PlugIcon)
        return h(this.props.Icon, { size: this.props.size, active: this.props.active })
      }
    }
  : null

export function PluginIconGlyph({ Icon, size = 16, active = false }) {
  if (!Icon) return h(PlugIcon)
  if (!IconGuard) return h(Icon, { size, active })
  return h(IconGuard, { Icon, size, active })
}
