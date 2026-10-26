import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { URL, fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
const require = createRequire(new URL('../../../ds-bot/package.json', import.meta.url));
const { build } = require('esbuild');
const compiled = await build({ entryPoints: [fileURLToPath(new URL('../src/screens/ChatScreen.tsx', import.meta.url))], bundle: true, format: 'cjs', platform: 'node', write: false, external: ['*'] });
const nodes = (tree: any, type: string): any[] => !tree || typeof tree !== 'object' ? [] : [...(tree.type === type ? [tree] : []), ...(tree.children || []).flatMap((child: any) => nodes(child, type))];
function fixture() {
  const values: any[] = [], effects: any[] = [], frames: (() => void)[] = [];
  let cursor = 0;
  const chat: any = { messages: [{ id: 'm1', role: 'assistant', text: 'First reply', sessionId: 's' }], status: 'connected', draft: '', queue: [], archived: [], setError: () => {} };
  const react = { createElement: (type: any, props: any, ...children: any[]) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState: (initial: any) => { const slot = cursor++; if (!(slot in values)) values[slot] = typeof initial === 'function' ? initial() : initial; return [values[slot], (value: any) => { values[slot] = typeof value === 'function' ? value(values[slot]) : value; }]; },
    useRef: (initial: any) => { const slot = cursor++; if (!(slot in values)) values[slot] = { current: initial }; return values[slot]; },
    useMemo: (fn: any) => { cursor++; return fn(); }, useCallback: (fn: any) => { cursor++; return fn; },
    useEffect: (fn: any, deps: any[]) => { const slot = cursor++; const prior = values[slot]; if (!prior || deps.some((dep, i) => dep !== prior[i])) { values[slot] = deps; effects.push(fn); } } };
  const components = new Proxy({}, { get: (_target, key) => key === 'styles' ? {} : String(key) });
  const module = { exports: {} as any };
  runInNewContext(compiled.outputFiles[0].text, { module, exports: module.exports, setTimeout: () => 1, clearTimeout: () => {}, requestAnimationFrame: (fn: () => void) => frames.push(fn), require: (name: string) => {
    if (name === 'react') return react;
    if (name === 'react-native') return { ...Object.fromEntries(['FlatList', 'KeyboardAvoidingView', 'ScrollView', 'Text', 'TextInput', 'View'].map(name => [name, name])), Platform: { OS: 'android' }, Keyboard: { addListener: () => ({ remove: () => {} }) } };
    if (name === 'expo-speech') return { stop: () => {} };
    if (name === 'react-native-safe-area-context') return { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) };
    if (name.endsWith('/i18n')) return { tr: (text: string) => text, dateLocale: () => 'en-US' };
    if (name.endsWith('/theme')) return { useTheme: () => ({}) };
    if (name.endsWith('/useConversation')) return { useConversation: () => chat };
    if (name.endsWith('/reasoning')) return { combineTurnReasoning: (messages: any[]) => messages };
    if (name.endsWith('/group-work')) return { ownBotWork: () => undefined, waitingNames: () => [], workDescription: () => '' };
    if (name.endsWith('/composer')) return { referenceDraft: (text: string) => ({ text, references: [] }), mentionQuery: () => null };
    return components;
  } });
  const props = { client: {}, host: { serverId: 'test' }, conversation: { id: 'b', name: 'Bot', sessionId: 's' }, conversations: [], select: () => {}, team: { bots: [{ id: 'b', sessionId: 's' }], rooms: [], models: [] }, refresh: async () => {}, online: true, transcription: false };
  const render = () => { cursor = 0; const tree = module.exports.ChatScreen(props); effects.splice(0).forEach(fn => fn()); return tree; };
  let scrolls = 0;
  const list = () => { const node = nodes(render(), 'FlatList')[0]; node.props.ref.current = { scrollToEnd: () => { scrolls++; } }; return node.props; };
  return { render, list, chat, frames, scrolls: () => scrolls };
}
test('changing layout while reading history does not create a new-message badge', () => {
  const f = fixture(); const list = f.list();
  list.onScrollBeginDrag(); list.onScroll({ nativeEvent: { contentOffset: { y: 200 }, contentSize: { height: 2000 }, layoutMeasurement: { height: 500 } } });
  list.onContentSizeChange(400, 2050);
  assert.equal(nodes(f.render(), 'Button').some(node => node.props.title === '↓ New messages'), false);
  f.chat.messages = [...f.chat.messages, { id: 'm2', text: 'New reply', role: 'assistant', sessionId: 's' }];
  f.render();
  assert.equal(nodes(f.render(), 'Button').some(node => node.props.title === '↓ New messages'), true);
});
test('a layout or content resize cannot pull an active drag back to the bottom', () => {
  const f = fixture(); const list = f.list();
  list.onScrollBeginDrag(); list.onLayout(); list.onContentSizeChange(400, 2050);
  f.frames.splice(0).forEach(fn => fn());
  assert.equal(f.scrolls(), 0);
});
test('conversation options open search inside the same sheet surface', () => {
  const f = fixture();
  nodes(f.render(), 'IconButton').find(node => node.props.label === 'Conversation options').props.onPress();
  const before = nodes(f.render(), 'Sheet');
  const active = before.findIndex(node => node.props.visible);
  assert.equal(before[active].props.title, 'Conversation options');
  nodes(before[active], 'Button').find(node => node.props.title === 'Search conversation').props.onPress();
  const after = nodes(f.render(), 'Sheet');
  assert.equal(after[active].props.visible, true);
  assert.equal(after[active].props.title, 'Search conversation');
  assert.equal(after.filter(node => node.props.visible).length, 1);
});
