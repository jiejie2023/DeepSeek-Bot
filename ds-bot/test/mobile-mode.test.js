import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import { install } from '../src/mobile/index.js'

async function fixture(t, config = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dsbot-mode-review-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const probe = net.createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  let cleanup
  const rt = { home, config: { mobile: { port, ...config } }, load: async () => {}, readOnly: () => undefined,
    ctx: { get: () => undefined, on: () => () => {}, effect: run => { cleanup = run() } } }
  install(rt)
  await rt.mobileOperator('status')
  let closed = false
  const stop = async () => { if (!closed) { closed = true; await cleanup() } }
  t.after(stop)
  return { home, rt, stop, port, call: (endpoint, payload) => rt.mobileOperator(endpoint, payload) }
}

test('returning to the address picker overrides a publicUrl from the profile, including after restart', async t => {
  const f = await fixture(t, { enabled: true, publicUrl: 'https://profile.example.invalid' })
  await f.call('mode.set', { publicUrl: '' })
  const state = await f.call('status')
  assert.equal(state.mode.publicUrl, null)
  assert.equal(state.https.provider, 'local')
  assert.equal(state.enabled, true)
  assert.equal(state.url, state.https.url)
  assert.match(state.url, /^https:\/\/(\[|\d)/)
  await f.stop()
  let cleanup
  const rt = { ...f.rt, ctx: { ...f.rt.ctx, effect: run => { cleanup = run() } } }
  install(rt); t.after(() => cleanup())
  const restored = await rt.mobileOperator('status')
  assert.equal(restored.mode.publicUrl, null)
  assert.equal(restored.https.provider, 'local')
  assert.equal(restored.url, state.url)
})

test('a UI fixed HTTPS choice restores on restart without enabled in the profile', async t => {
  const f = await fixture(t)
  await f.call('mode.set', { publicUrl: 'https://phone.example.invalid' })
  const chosen = await f.call('status')
  assert.equal(chosen.https.provider, 'manual')
  assert.equal(chosen.url, 'https://phone.example.invalid')
  await f.stop()
  let cleanup
  const rt = { ...f.rt, ctx: { ...f.rt.ctx, effect: run => { cleanup = run() } } }
  install(rt); t.after(() => cleanup())
  const restored = await rt.mobileOperator('status')
  assert.equal(restored.enabled, true)
  assert.equal(restored.url, chosen.url)
  assert.equal(restored.https.provider, 'manual')
})

test('a failed return to local HTTPS restores the fixed service and its persisted selection', async t => {
  const f = await fixture(t, { enabled: true, publicUrl: 'https://profile.example.invalid' })
  await f.call('mode.set', { publicUrl: 'https://phone.example.invalid' })
  await writeFile(join(f.home, 'mobile', 'local-https.json'), 'broken-local-test-settings')
  await assert.rejects(f.call('mode.set', { publicUrl: '' }), /could not be switched/)
  const state = await f.call('status')
  assert.equal(state.mode.publicUrl, 'https://phone.example.invalid')
  assert.equal(state.enabled, true)
  assert.equal(state.url, state.mode.publicUrl)
  assert.equal(JSON.parse(await readFile(join(f.home, 'mobile', 'mode.json'), 'utf8')).publicUrl, state.mode.publicUrl)
})

test('explicit plugin disable prevents a fixed HTTPS choice from starting the service', async t => {
  const f = await fixture(t, { enabled: false })
  await assert.rejects(f.call('mode.set', { publicUrl: 'https://phone.example.invalid' }), /disabled/)
  assert.equal((await f.call('status')).enabled, false)
})

test('invalid fixed origins are rejected before changing the active service', async t => {
  const f = await fixture(t, { enabled: true, publicUrl: 'https://profile.example.invalid' })
  for (const publicUrl of ['https://user:password@example.invalid', 'https://example.invalid?x=1', 'https://example.invalid#x', 'https://example.invalid:bad']) {
    await assert.rejects(f.call('mode.set', { publicUrl }))
    assert.equal((await f.call('status')).url, 'https://profile.example.invalid')
  }
})

test('failure to save the selection leaves the previous mode and service intact', async t => {
  const f = await fixture(t, { enabled: true, publicUrl: 'https://profile.example.invalid' })
  await mkdir(join(f.home, 'mobile', 'mode.json'))
  await assert.rejects(f.call('mode.set', { publicUrl: 'https://phone.example.invalid' }))
  const state = await f.call('status')
  assert.equal(state.mode.publicUrl, 'https://profile.example.invalid')
  assert.equal(state.url, state.mode.publicUrl)
  assert.equal(state.enabled, true)
})
