import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { URL, fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
const require = createRequire(new URL('../../../ds-bot/package.json', import.meta.url));
const { build } = require('esbuild');
async function compile(path: string) { return (await build({ entryPoints: [fileURLToPath(new URL(path, import.meta.url))], bundle: true, format: 'cjs', platform: 'node', write: false, external: ['*'] })).outputFiles[0].text; }
const workspaceSource = await compile('../src/hooks/useWorkspace.ts');
const notificationSource = await compile('../src/media/notifications.ts');
const hookSource = await compile('../src/hooks/useNotifications.ts');
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve!: (value: any) => void; const promise = new Promise<any>(done => { resolve = done; }); return { promise, resolve }; }
function load(source: string, imports: Record<string, any>) { const module = { exports: {} as any }; runInNewContext(source, { module, exports: module.exports, require: (name: string) => imports[name] || {}, AbortController, setInterval: () => 1, clearInterval: () => {} }); return module.exports; }
function hooks(runEffects = false) {
  const values: any[] = []; let cursor = 0;
  const react = {
    useState: (initial: any) => { const slot = cursor++; if (!(slot in values)) values[slot] = typeof initial === 'function' ? initial() : initial; return [values[slot], (value: any) => { values[slot] = typeof value === 'function' ? value(values[slot]) : value; }]; },
    useRef: (initial: any) => { const slot = cursor++; if (!(slot in values)) values[slot] = { current: initial }; return values[slot]; },
    useCallback: (fn: any) => fn, useEffect: (fn: any) => { if (runEffects) fn(); },
  };
  return { react, render: (fn: () => any) => { cursor = 0; return fn(); } };
}
test('a cache write failure cannot mark a successfully refreshed host offline', async () => {
  const h = hooks();
  const { useWorkspace } = load(workspaceSource, { react: h.react, '../types': { teamState: (value: any) => value, errorText: (error: Error) => error.message }, '../storage': { writeCache: async () => { throw new Error('test cache unavailable'); } } });
  const client = { state: async () => ({ bots: [], rooms: [], models: [] }), conversations: async () => ({ conversations: [] }), info: async () => ({}) }, host = { serverId: 'test' };
  await h.render(() => useWorkspace(client, host)).refresh();
  assert.equal(h.render(() => useWorkspace(client, host)).online, true);
});
function notifications() {
  const initial = deferred(), response = deferred(); let listener: any, cleared = 0;
  const data = { serverId: 'test', conversationId: 'b' };
  const value = { actionIdentifier: 'default', notification: { request: { identifier: 'one', content: { data } } } };
  const exports = load(notificationSource, { 'expo-notifications': { setNotificationHandler: () => {}, addNotificationResponseReceivedListener: (fn: any) => { listener = fn; return { remove: () => {} }; }, getLastNotificationResponseAsync: () => response.promise, clearLastNotificationResponseAsync: async () => { cleared++; } }, 'expo-constants': {}, 'react-native': { Linking: { addEventListener: () => ({ remove: () => {} }), getInitialURL: () => initial.promise }, Platform: { OS: 'android' } }, '../logic/notifications': { backgroundNotificationLink: (url: string) => url ? data : null } });
  return { ...exports, initial, response, value, cleared: () => cleared, deliver: () => listener(value) };
}
test('notification initialization cannot navigate after the subscription was removed', async () => {
  const f = notifications(); let opened = 0;
  const stop = f.notificationResponses(() => { opened++; return true; }); stop();
  f.initial.resolve('dsbot://notification'); f.response.resolve(f.value); await tick();
  assert.equal(opened, 0); assert.equal(f.cleared(), 0);
});
test('an unhandled notification remains pending for the matching host', async () => {
  const f = notifications(); f.notificationResponses(() => false);
  f.response.resolve(f.value); await tick();
  assert.equal(f.cleared(), 0);
});
test('a notification delivered by the listener and cold-start read opens only once', async () => {
  const f = notifications(); let opened = 0;
  f.notificationResponses(() => { opened++; return true; });
  f.deliver(); f.response.resolve(f.value); await tick();
  assert.equal(opened, 1);
});
test('notification responses are subscribed only after the paired host is ready', () => {
  const h = hooks(true); let subscriptions = 0;
  const { useNotifications } = load(hookSource, { react: h.react, '../i18n': { useI18n: () => ({ locale: 'zh' }) }, '../media/background-notifications': { syncBackgroundLanguage: async () => {}, backgroundNotificationsAvailable: false }, '../media/notifications': { notificationResponses: () => { subscriptions++; return () => {}; } } });
  h.render(() => useNotifications(null, undefined, false, () => {}));
  assert.equal(subscriptions, 0);
  h.render(() => useNotifications({}, 'test', false, () => {}));
  assert.equal(subscriptions, 1);
});
