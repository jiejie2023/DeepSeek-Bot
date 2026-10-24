// Local patch: stable Classic-mode titles for Bot chats.
// Bot identities and the shared room's own title are deliberately unchanged.
export const classicTitle = (bot, room) => `${room ? '【群聊】' : '【私聊】'}${bot.name}`

const synced = new WeakMap()
const running = new WeakMap()

const currentTitles = (rt) => {
  const titles = new Map()
  for (const bot of Object.values(rt.state.bots)) {
    titles.set(rt.chatOf(bot.id), classicTitle(bot))
  }
  for (const room of Object.values(rt.state.rooms)) {
    for (const [botId, sessionId] of Object.entries(room.sessions ?? {})) {
      const bot = rt.botOf(botId)
      if (bot && room.members.includes(botId)) titles.set(sessionId, classicTitle(bot, room))
    }
  }
  return titles
}

// Called on team bootstrap, including the first read after a restart. Only current
// sessions are migrated; archived parts, messages and state.json are never edited.
// The cache avoids duplicate rename events on every sidebar poll. Failed sessions
// are not cached and can retry on the next read. Each runtime keeps its own cache.
export function syncClassicTitles(rt) {
  if (rt.readOnly() !== undefined) return Promise.resolve()
  const pending = running.get(rt)
  // A request made during a pass may carry a new Bot name or current session.
  // Recheck after that pass settles, rather than merely joining its old snapshot.
  if (pending) return pending.then(() => syncClassicTitles(rt))
  let done = synced.get(rt)
  if (!done) synced.set(rt, done = new Map())
  const job = (async () => {
    const wanted = currentTitles(rt)
    for (const sessionId of done.keys()) if (!wanted.has(sessionId)) done.delete(sessionId)
    for (const [sessionId, title] of wanted) {
      if (done.get(sessionId) === title) continue
      try {
        const agent = await rt.resolveAgent(sessionId)
        // A rollover, rename or removal can have happened while resolving a session.
        if (rt.readOnly() !== undefined || currentTitles(rt).get(sessionId) !== title) continue
        await rt.ctx.sessionTitle.rename(agent.session, title)
        done.set(sessionId, title)
      } catch (error) {
        rt.warn('ds-bot: Classic title for %s not updated: %s', sessionId, error)
      }
    }
  })().finally(() => running.delete(rt))
  running.set(rt, job)
  return job
}
