const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup({ deferVoices = false, voices } = {}) {
  const calls = { speak: [], stop: 0, messages: [], voiceRequests: [] };
  const listeners = {};
  const event = name => ({ addListener(fn) { listeners[name] = fn; } });
  const available = voices || [{ voiceName: 'Samantha Enhanced', lang: 'en-US', remote: false,
    eventTypes: ['start', 'word', 'end', 'error'] }];
  const chrome = {
    runtime: { onMessage: event('message'), getURL: p => `chrome-extension://fixture/${p}`, lastError: null },
    tts: {
      getVoices(callback) { if (deferVoices) calls.voiceRequests.push(callback); else callback(available); },
      speak(text, options, callback) { calls.speak.push({ text, options, callback }); },
      stop() { calls.stop++; },
    },
    tabs: {
      sendMessage(tabId, message) { calls.messages.push({ tabId, message }); return Promise.resolve(); },
      query() { return Promise.resolve([{ id: 1 }]); },
      onRemoved: event('removed'), onActivated: event('activated'),
    },
    storage: { onChanged: event('storage') },
  };
  const context = vm.createContext({ chrome, console });
  context.importScripts = file => vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension', file), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8'), context);
  const room = (id = 1) => ({ tab: { id }, url: 'https://protobowl.com/testing' });
  const popup = { url: 'chrome-extension://fixture/popup.html' };
  const send = (message, sender = room()) => new Promise(resolve => listeners.message(message, sender, resolve));
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return { calls, listeners, available, chrome, room, popup, send, flush };
}

test('speech waits for voices and reports startup acceptance separately from final playback', async () => {
  const env = setup();
  const pending = env.send({ type: 'speak', id: 'one', text: 'A natural phrase.', rate: 99, volume: -5 });
  await env.flush();
  assert.equal(env.calls.speak.length, 1);
  assert.equal(env.calls.speak[0].options.rate, 3.5);
  assert.equal(env.calls.speak[0].options.volume, 0);
  env.calls.speak[0].callback();
  assert.equal((await pending).ok, true);
  env.calls.speak[0].options.onEvent({ type: 'word', charIndex: 2 });
  assert.equal(env.calls.messages.at(-1).message.event.charIndex, 2);
  env.calls.speak[0].options.onEvent({ type: 'end' });
  assert.equal(env.calls.messages.at(-1).message.event.type, 'end');
});

test('stopping while voice enumeration is pending prevents delayed speech', async () => {
  const env = setup({ deferVoices: true });
  const pending = env.send({ type: 'speak', id: 'old', text: 'Do not speak after cancellation.' });
  await env.send({ type: 'stop' });
  env.calls.voiceRequests[0](env.available);
  assert.equal((await pending).ok, false);
  assert.equal(env.calls.speak.length, 0);
});

test('a superseded utterance cannot deliver late word or end events to a new owner', async () => {
  const env = setup();
  const first = env.send({ type: 'speak', id: 'old', text: 'First phrase.' });
  await env.flush();
  env.calls.speak[0].callback();
  await first;
  const second = env.send({ type: 'speak', id: 'new', text: 'Second phrase.' }, env.room(2));
  await env.flush();
  env.calls.speak[1].callback();
  await second;
  const before = env.calls.messages.length;
  env.calls.speak[0].options.onEvent({ type: 'word', charIndex: 6 });
  env.calls.speak[0].options.onEvent({ type: 'end' });
  assert.equal(env.calls.messages.length, before);
  const stops = env.calls.stop;
  await env.send({ type: 'stop' }, env.room(1));
  assert.equal(env.calls.stop, stops, 'old tab cannot cancel the new tab');
  await env.send({ type: 'stop' }, env.room(2));
  assert.equal(env.calls.stop, stops + 1);
});

test('preview owns speech until it finishes and room cancellation cannot stop it', async () => {
  const env = setup();
  const roomSpeech = env.send({ type: 'speak', id: 'room', text: 'A room phrase.' });
  await env.flush();
  env.calls.speak[0].callback();
  await roomSpeech;
  const preview = env.send({ type: 'preview', settings: { rate: 1, volume: 1 } }, env.popup);
  await env.flush();
  assert.ok(env.calls.messages.some(m => m.tabId === 1 && m.message.type === 'preview-start'));
  env.calls.speak[1].callback();
  await preview;
  const stops = env.calls.stop;
  await env.send({ type: 'stop' });
  assert.equal(env.calls.stop, stops);
  assert.equal((await env.send({ type: 'speak', id: 'blocked', text: 'Wait for preview.' })).busy, true);
  env.calls.speak[1].options.onEvent({ type: 'end' });
  assert.ok(env.calls.messages.some(m => m.tabId === 1 && m.message.type === 'preview-end'),
    'the room can resume immediately when preview finishes');
  const next = env.send({ type: 'speak', id: 'after', text: 'Preview is finished.' });
  await env.flush();
  assert.equal(env.calls.speak.length, 3);
  env.calls.speak[2].callback();
  assert.equal((await next).ok, true);
});

test('invalid text does not interrupt valid speech; no voices produces a useful error', async () => {
  const env = setup();
  const pending = env.send({ type: 'speak', id: 'one', text: 'Keep speaking.' });
  await env.flush();
  env.calls.speak[0].callback();
  await pending;
  assert.equal((await env.send({ type: 'speak', id: 'bad', text: 'x'.repeat(501) })).ok, false);
  assert.equal(env.calls.stop, 0);
  const empty = setup({ voices: [] });
  const result = await empty.send({ type: 'speak', id: 'none', text: 'No voice.' });
  assert.equal(result.ok, false);
  assert.match(result.error, /No speech voices/);
});

test('tab closure, tab switches, and settings changes cancel owned speech', async () => {
  for (const action of [env => env.listeners.removed(1),
    env => env.listeners.activated({ tabId: 2 }),
    env => env.listeners.storage({ settings: { newValue: { enabled: false } } }, 'local')]) {
    const env = setup();
    const pending = env.send({ type: 'speak', id: 'one', text: 'Playing.' });
    await env.flush();
    env.calls.speak[0].callback();
    await pending;
    action(env);
    assert.equal(env.calls.stop, 1);
    env.calls.speak[0].options.onEvent({ type: 'end' });
    assert.equal(env.calls.messages.length, 0);
  }
});

test('unrelated sites cannot start speech or invoke popup actions', () => {
  const env = setup();
  let replied = false;
  for (const sender of [{ tab: { id: 8 }, url: 'https://evil.test/protobowl.com/' },
    { tab: { id: 8 }, url: 'https://protobowl.com.evil.test/' }]) {
    assert.equal(env.listeners.message({ type: 'speak', text: 'blocked' }, sender, () => { replied = true; }), undefined);
  }
  env.listeners.message({ type: 'preview', settings: {} }, env.room(), () => { replied = true; });
  env.listeners.message({ type: 'preview', settings: {} },
    { url: 'chrome-extension://another-extension/popup.html' }, () => { replied = true; });
  env.listeners.message({ type: 'preview', settings: {} },
    { url: 'https://evil.test/popup.html' }, () => { replied = true; });
  assert.equal(replied, false);
  assert.equal(env.calls.speak.length, 0);
});

test('the real popup URL can invoke actions both as a popup and in an extension tab', async () => {
  const env = setup();
  for (const sender of [env.popup, { ...env.popup, tab: { id: 99 } }]) {
    const result = await env.send({ type: 'voices' }, sender);
    assert.equal(result.voices[0].voiceName, env.available[0].voiceName);
  }
});

test('full sentences above the phrase cap require explicit Natural flow and respect the engine limit', async () => {
  const env = setup();
  const text = 'A sentence can retain its natural rhythm across many words, '.repeat(12) + 'until it ends.';
  assert.ok(text.length > 500);
  for (const naturalFlow of [false, undefined, 'true']) {
    assert.equal((await env.send({ type: 'speak', id: 'blocked', text, naturalFlow })).ok, false);
  }
  const pending = env.send({ type: 'speak', id: 'sentence', text, naturalFlow: true });
  await env.flush();
  assert.equal(env.calls.speak.length, 1);
  assert.equal(env.calls.speak[0].text, text);
  env.calls.speak[0].callback();
  assert.equal((await pending).ok, true);
  assert.equal((await env.send({ type: 'speak', text: 'x'.repeat(32001), naturalFlow: true })).ok, false);
  assert.equal(env.calls.stop, 0, 'invalid oversized requests do not interrupt valid speech');
});

test('silent warmup yields to real speech and cannot interrupt speech or preview', async () => {
  const env = setup();
  const warmup = env.send({ type: 'warmup', voiceName: 'Samantha Enhanced' });
  await env.flush();
  assert.equal(env.calls.speak.length, 1);
  assert.equal(env.calls.speak[0].options.volume, 0);
  assert.equal(env.calls.speak[0].options.voiceName, 'Samantha Enhanced');
  env.calls.speak[0].callback();
  assert.equal((await warmup).ok, true);

  const realSpeech = env.send({ type: 'speak', id: 'question', text: 'The question starts now.', volume: .8 });
  await env.flush();
  assert.equal(env.calls.stop, 1, 'real speech interrupts the unfinished warmup');
  assert.equal(env.calls.speak.length, 2);
  assert.equal(env.calls.speak[1].options.volume, .8);
  env.calls.speak[1].callback();
  assert.equal((await realSpeech).ok, true);
  env.calls.speak[0].options.onEvent({ type: 'end' });
  assert.equal(env.calls.messages.length, 0, 'late warmup completion cannot clear real speech ownership');

  assert.equal((await env.send({ type: 'warmup' }, env.room(2))).busy, true);
  assert.equal(env.calls.speak.length, 2);
  assert.equal(env.calls.stop, 1);

  const preview = env.send({ type: 'preview', settings: {} }, env.popup);
  await env.flush();
  env.calls.speak[2].callback();
  assert.equal((await preview).ok, true);
  const stops = env.calls.stop;
  assert.equal((await env.send({ type: 'warmup' })).busy, true);
  assert.equal(env.calls.speak.length, 3);
  assert.equal(env.calls.stop, stops, 'warmup does not interrupt the preview');
});
