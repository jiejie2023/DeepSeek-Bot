import { dirname, join } from 'node:path'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import QRCode from 'qrcode'
import { createAdapter } from './adapter.js'
import { createMobileServer } from './server.js'
import { createApprovalBroker } from './approvals.js'
import { createSkillLibrary } from './skills.js'
import { createLocalHttps } from './local-https.js'

export function install(rt) {
  const config = rt.config.mobile ?? {}
  const modeFile = join(rt.home, 'mobile', 'mode.json')
  let mode = {}
  const optionsFor = selection => {
    if (!Object.hasOwn(selection, 'publicUrl')) return { ...config }
    if (selection.publicUrl) return { ...config, enabled: config.enabled !== false, publicUrl: selection.publicUrl }
    const { publicUrl, certPath, keyPath, devAllowInsecure, ...automatic } = config
    return automatic
  }
  const fixedUrl = () => optionsFor(mode).publicUrl ?? null
  const persistMode = async selection => {
    await mkdir(dirname(modeFile), { recursive: true })
    await writeFile(modeFile + '.tmp', JSON.stringify(selection), { mode: 0o600 })
    await rename(modeFile + '.tmp', modeFile)
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
      service = await createMobileServer({ home: join(rt.home, 'mobile'), config: options, adapter })
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
  const setupLocal = async options => {
    local?.dispose()
    local = await createLocalHttps({ home: join(rt.home, 'mobile'), config: options, load: () => rt.load(), readOnly: () => rt.readOnly(), start, stop })
  }
  const manuallyEnabled = options => options.enabled === true && Boolean(options.publicUrl || options.certPath || options.keyPath || options.devAllowInsecure)
  rt.ctx.effect(() => {
    ready = (async () => {
      await rt.load()
      if (stopped) return
      try {
        const saved = JSON.parse(await readFile(modeFile, 'utf8'))
        if (!saved || typeof saved !== 'object' || Array.isArray(saved) || (Object.hasOwn(saved, 'publicUrl') && saved.publicUrl !== null && typeof saved.publicUrl !== 'string')) throw new Error('Invalid mobile access selection')
        mode = saved
      } catch (cause) { if (cause.code !== 'ENOENT') throw cause }
      const boot = optionsFor(mode)
      await setupLocal(boot)
      if (manuallyEnabled(boot)) await start(boot)
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
      return { ...state, https: local?.snapshot(), mode: { publicUrl: fixedUrl() }, ...(failure ? { error: failure } : {}), ...(config.enabled === false ? { locked: true } : {}) }
    }
    if (endpoint === 'approvals.list' && !service) return { requests: [] }
    owner()
    if (endpoint === 'mode.set') {
      const work = operation.then(async () => {
        owner()
        if (config.enabled === false) throw refused('Mobile access is disabled in this plugin configuration.')
        const raw = payload?.publicUrl
        let publicUrl = null
        if (typeof raw === 'string' && raw.trim()) {
          try {
            const url = new URL(raw.trim())
            if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid origin')
            publicUrl = url.origin
          } catch { throw refused('Use an https:// host without a path, for example https://name.tailnet.ts.net') }
        }
        const previous = mode
        const wasRunning = Boolean(service)
        const previousLocal = local?.snapshot()
        const next = { publicUrl }
        try {
          await stop()
          const chosen = optionsFor(next)
          await setupLocal(chosen)
          if (publicUrl) await start(chosen)
          else await local.enable({})
          owner()
          await persistMode(next)
          mode = next
          failure = undefined
        } catch {
          await stop()
          try {
            const previousOptions = optionsFor(previous)
            await setupLocal(previousOptions)
            if (wasRunning) {
              if (manuallyEnabled(previousOptions)) await start(previousOptions)
              else await local.enable({ address: previousLocal?.address, port: previousLocal?.port })
            }
          } catch { /* Status reports the failed recovery without exposing private paths. */ }
          failure = 'The access mode could not be switched. Check the port and the HTTPS address, then try again.'
          throw refused(failure)
        }
        return { publicUrl: fixedUrl() }
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
    const https = local?.snapshot()
    const tlsPin = https?.provider === 'local' && https.url === service.url ? https.tlsPin : undefined
    const pairing = { ...value, ...(tlsPin ? { tlsPin } : {}) }
    const qr = JSON.stringify({ url: pairing.url, code: pairing.code, serverId: pairing.serverId, ...(tlsPin ? { tlsPin } : {}) })
    return { ...pairing, qrDataUrl: await QRCode.toDataURL(qr, { errorCorrectionLevel: 'M', margin: 2, width: 256 }) }
  }
}
