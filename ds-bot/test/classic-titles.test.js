import assert from 'node:assert/strict'
import test from 'node:test'
import { syncClassicTitles } from '../src/host/classic-titles.js'

function runtime(sessionTitle) {
  const calls = []
  const bot = { id: 'b', name: 'Chief' }
  const rt = {
    ctx: { sessionTitle }, state: { bots: { b: bot }, rooms: {} },
    readOnly: () => undefined, chatOf: () => 'chat', botOf: () => bot,
    resolveAgent: async id => { calls.push(id); return { session: { id } } },
    warn: () => { throw new Error('unexpected warning') },
  }
  return { rt, calls }
}

test('classic titles do not resolve Agents without the title service', async () => {
  for (const service of [undefined, {}]) {
    const { rt, calls } = runtime(service)
    await syncClassicTitles(rt)
    assert.deepEqual(calls, [])
  }
})

test('classic titles resolve and rename when the title service exists', async () => {
  const renamed = []
  const { rt, calls } = runtime({ rename: async (session, title) => renamed.push([session.id, title]) })
  await syncClassicTitles(rt)
  await syncClassicTitles(rt)
  assert.deepEqual(calls, ['chat'])
  assert.deepEqual(renamed, [['chat', '【私聊】Chief']])
})

test('a failed title rename warns and retries until successful', async () => {
  const renamed = []
  let attempts = 0
  const { rt, calls } = runtime({ rename: async (session, title) => {
    if (++attempts === 1) throw new Error('rename failed')
    renamed.push([session.id, title])
  } })
  const warnings = []
  rt.warn = (...args) => warnings.push(args)
  await syncClassicTitles(rt)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0][0], /Classic title/)
  assert.equal(warnings[0][1], 'chat')
  assert.match(warnings[0][2].message, /rename failed/)
  await syncClassicTitles(rt)
  await syncClassicTitles(rt)
  assert.deepEqual(calls, ['chat', 'chat'])
  assert.deepEqual(renamed, [['chat', '【私聊】Chief']])
})
