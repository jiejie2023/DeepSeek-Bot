import { dirname, join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import QRCode from 'qrcode'
import { createAdapter } from './adapter.js'
import { createMobileServer } from './server.js'
import { createApprovalBroker } from './approvals.js'
import { createSkillLibrary } from './skills.js'
import { createLocalHttps } from './local-https.js'

export function install(rt) {
  const config = rt.config.mobile ?? {}
  // The settings page can pick how phones reach this host: the one-click address
  // picker (no publicUrl) or a fixed HTTPS origin behind a reverse proxy
  // (Tailscale Serve, a tunnel). That choice lives beside the certificate so it
  // survives restarts and never rewrites the DSH profile config.
  const modeFile = join(rt.home, 'mobile', 'mode.json')
  let mode = (() => { try { return JSON.parse(readFileSync(modeFile, 'utf8')) ?? {} } catch { return {} } })()
  const fixedUrl = () => Object.hasOwn(mode, 'publicUrl') ? mode.publicUrl ?? undefined : config.publicUrl ?? undefined
  const withMode = options => {
    if (!Object.hasOwn(mode, 'publicUrl')) return options
    const next = { ...options }
    if (mode.publicUrl) next.publicUrl = mode.publicUrl
    else delete next.publicUrl
    return next
  }
  let service, adapter, stopApprovals, skillLibrary, local, ready, failure
  let stopped = false
  let operation = Promise.resolve()
  rt.mobileApprovalsView = () => []
  const refused = message => Object.assign(new Error(message), { code: 'bot/refused' })
  const owner = () => {
    if (stopped || rt.readOnly() !== undefined) throw refused('Use the DSH host that owns this Bot team.')
  }
  const stop = async () => {
    stopApprovals?.(); stopApprovals = undefined
    rt.mobileApprovalsView = () => []
    await service?.close(); service = undefined
    await adapter?.dispose?.(); adapter = undefined
    await skillLibrary?.dispose?.(); skillLibrary = undefined
    rt.mobileSkills = undefined
  }
  const start = async options => {
    owner()
    const chosen = withMode(options)
    try {
      const skills = rt.ctx.get('skills')
      if (skills?.registerProvider) {
        skillLibrary = await createSkillLibrary({ home: join(rt.home, 'mobile'), service: skills, readOnly: () => rt.readOnly(), redact: value => rt.redactSecrets?.(value) ?? value })
        rt.mobileSkills = skillLibrary
      }
      adapter = createAdapter(rt)
      const approvals = createApprovalBroker({
        resolveConversation: sessionId => adapter.conversationForSession(sessionId),
        enabled: () => service?.hasActiveDevices() ?? false,
        authorizeDevice: deviceId => service?.isDeviceAuthorized(deviceId) ?? false,
        redact: text => rt.redactSecrets?.(text) ?? text,
      })
      adapter.setApprovalBroker(approvals, { authorizeDevice: deviceId => service?.isDeviceAuthorized(deviceId) ?? false })
      service = await createMobileServer({ home: join(rt.home, 'mobile'), config: chosen, adapter })
      owner()
      rt.mobileApprovalsView = () => approvals.list().requests.flatMap(request => {
        const botId = rt.chatOwners?.get(request.sessionId)
        return botId ? [{ id: request.id, botId, sessionId: request.sessionId, tool: request.toolName, reason: request.reason, at: request.createdAt, answerable: false }] : []
      })
      stopApprovals = rt.ctx.on('approval/request', (request, next) => {
        const sessionId = request.agent?.session?.id ?? request.agent?.id
        if (rt.groupOwners?.has(sessionId)) return next()
        const owned = rt.chatOwners?.has(sessionId)
        if (owned) rt.noteApproval?.(sessionId, { tool: String(request.toolName ?? ''), reason: rt.redactSecrets?.(String(request.reason ?? '').slice(0, 200)) ?? '' })
        return Promise.resolve(approvals.handle(request, next)).finally(() => { if (owned) rt.noteApproval?.(sessionId, undefined) })
      }, { prepend: true })
    } catch (error) { await stop(); throw error }
  }
  rt.ctx.effect(() => {
    ready = (async () => {
      await rt.load()
      if (stopped) return
      local = await createLocalHttps({ home: join(rt.home, 'mobile'), config, load: () => rt.load(), readOnly: () => rt.readOnly(), start, stop })
      const boot = withMode(config)
      if (boot.enabled === true && (boot.publicUrl || boot.certPath || boot.keyPath || boot.devAllowInsecure)) await start(boot)
      else await local.restore()
    })().catch(() => { failure = 'Mobile access could not start. Check its port, HTTPS settings, and the Bot team lock.' })
    return () => {
      stopped = true; local?.dispose()
      return ready.then(() => operation).then(stop)
    }
  }, 'ds-bot: mobile bridge')
  rt.mobileOperator = async (endpoint, payload) => {
    await ready
    if (endpoint === 'status') {
      const state = service ? await service.operator('status') : { enabled: false, pending: [], devices: [] }
      return { ...state, https: local?.snapshot(), mode: { publicUrl: fixedUrl() ?? null }, ...(failure ? { error: failure } : {}), ...(config.enabled === false ? { locked: true } : {}) }
    }
    if (endpoint === 'approvals.list' && !service) return { requests: [] }
    owner()
    // Switch how phones reach this host without touching the DSH profile config:
    // an empty publicUrl returns to the block-by-address UI, an https origin keeps
    // the reverse proxy (Tailscale Serve, tunnel) in front of this bridge.
    if (endpoint === 'mode.set') {
      const work = operation.then(async () => {
        owner()
        const raw = payload?.publicUrl
        const next = typeof raw === 'string' ? raw.trim() : ''
        if (next && !/^https:\/\/[^\s/]+$/.test(next)) throw refused('Use an https:// host without a path, for example https://name.tailnet.ts.net')
        if (next) mode = { ...mode, publicUrl: next }
        else delete mode.publicUrl
        mkdirSync(dirname(modeFile), { recursive: true })
        writeFileSync(modeFile, JSON.stringify(mode))
        await stop()
        failure = undefined
        if (next || config.enabled === true) await start(config)
        return { publicUrl: fixedUrl() ?? null }
      })
      operation = work.catch(() => {})
      return work
    }
    if (endpoint === 'https.enable' || endpoint === 'https.disable') {
      if (!local) throw refused(failure ?? 'Mobile connection setup is unavailable.')
      const work = operation.then(async () => {
        owner()
        const result = await local[endpoint === 'https.enable' ? 'enable' : 'disable'](payload)
        failure = undefined
        return result
      })
      operation = work.catch(() => {})
      return work
    }
    if (!service) throw refused(failure ?? 'Enable phone connection on this computer first.')
    const value = await service.operator(endpoint, payload)
    if (endpoint !== 'pairing.create') return value
    const tlsPin = local?.snapshot().tlsPin
    const pairing = { ...value, ...(tlsPin ? { tlsPin } : {}) }
    const qr = JSON.stringify({ url: pairing.url, code: pairing.code, serverId: pairing.serverId, ...(tlsPin ? { tlsPin } : {}) })
    return { ...pairing, qrDataUrl: await QRCode.toDataURL(qr, { errorCorrectionLevel: 'M', margin: 2, width: 256 }) }
  }
}

