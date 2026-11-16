const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../extension/core.js');
const read = name => fs.readFileSync(path.join(__dirname, '../safari', name), 'utf8');

function setup({ room = true, deferredClaim = false, available } = {}) {
  const calls = { utterances: [], cancel: 0, messages: [], claims: [] };
  const listeners = {};
  const voices = available || [{ name: 'Samantha Enhanced', lang: 'en-US', localService: true }];
  const document = { hidden: false, addEventListener(type, fn) { listeners[type] = fn; } };
  const chrome = { runtime: {
    sendMessage(message) {
      calls.messages.push(message);
      if (message.type === 'claim-speech' && deferredClaim) return new Promise(resolve => calls.claims.push(resolve));
      return Promise.resolve({ ok: true });
    },
    onMessage: { addListener(fn) { listeners.message = fn; } }
  }, storage: { onChanged: { addListener(fn) { listeners.storage = fn; } } } };
  const context = vm.createContext({ ProtoVoice: core, console, chrome, document,
    location: { protocol: room ? 'https:' : 'safari-web-extension:' },
    window: { addEventListener(type, fn) { listeners[type] = fn; } },
    speechSynthesis: { getVoices: () => voices, speak(utterance) { calls.utterances.push(utterance); }, cancel() { calls.cancel++; },
      addEventListener(type, fn) { listeners[type] = fn; } },
    SpeechSynthesisUtterance: function(text) { this.text = text; },
    setTimeout, clearTimeout
  });
  vm.runInContext(read('speech.js'), context);
  return { calls, listeners, document, context, engine: context.ProtoVoiceSpeech.createEngine(), transport: context.ProtoVoiceTransport };
}

test('Safari maps native voice metadata without identifiers or native handles', () => {
  const env = setup({ room: false });
  const voice = env.context.ProtoVoiceSpeech.voices()[0];
  assert.equal(voice.voiceName, 'Samantha Enhanced');
  assert.equal(voice.remote, false);
  assert.deepEqual(Object.keys(voice).sort(), ['eventTypes', 'lang', 'remote', 'voiceName']);
});

test('Safari preserves sentence text in one utterance and normalizes rate and volume', () => {
  const env = setup({ room: false });
  const text = 'A long sentence, with its own natural pauses, continues to the final word.';
  const result = env.engine.speak({ text, naturalFlow: true, rate: 50, volume: -1 });
  assert.equal(result.ok, true);
  assert.equal(env.calls.utterances.length, 1);
  assert.equal(env.calls.utterances[0].text, text);
  assert.equal(env.calls.utterances[0].rate, 3.5);
  assert.equal(env.calls.utterances[0].volume, 0);
});

test('Safari speech emits UTF-16 word offsets and suppresses sentence boundaries', () => {
  const env = setup({ room: false });
  const events = [];
  env.engine.speak({ text: 'An emoji 🧪 follows.' }, event => events.push(event));
  const utterance = env.calls.utterances[0];
  utterance.onstart();
  utterance.onboundary({ name: 'sentence', charIndex: 0 });
  utterance.onboundary({ name: 'word', charIndex: 12 });
  utterance.onend();
  assert.deepEqual(events.map(event => event.type), ['start', 'word', 'end']);
  assert.equal(events[1].charIndex, 12);
  assert.equal(env.engine.isSpeaking(), false);
});

test('Safari ignores callbacks from stopped or superseded utterances', () => {
  const env = setup({ room: false });
  const events = [];
  env.engine.speak({ text: 'Old sentence.' }, event => events.push(event));
  const old = env.calls.utterances[0];
  env.engine.speak({ text: 'New sentence.' }, event => events.push(event));
  old.onend();
  old.onerror({ error: 'canceled' });
  assert.equal(events.length, 0);
  env.engine.stop();
  env.calls.utterances[1].onboundary({ name: 'word', charIndex: 0 });
  assert.equal(events.length, 0);
  assert.equal(env.calls.cancel, 2);
});

test('Safari permits the default system voice before asynchronous voice discovery', () => {
  const env = setup({ room: false, available: [] });
  assert.equal(env.engine.speak({ text: 'A default voice.' }).ok, true);
  assert.equal(env.calls.utterances[0].lang, 'en-US');
  assert.equal(env.calls.utterances[0].voice, undefined);
});

test('Safari only accepts long utterances with explicit Natural flow enabled', () => {
  const env = setup({ room: false });
  const text = 'word '.repeat(150);
  assert.equal(env.engine.speak({ text }).ok, false);
  assert.equal(env.engine.speak({ text, naturalFlow: 'true' }).ok, false);
  assert.equal(env.engine.speak({ text, naturalFlow: true }).ok, true);
  assert.equal(env.engine.speak({ text: 'x'.repeat(32001), naturalFlow: true }).ok, false);
});

test('Safari room requires a gesture and silent unlock is replaced by the first utterance', async () => {
  const env = setup();
  assert.equal(env.transport.requiresGesture(), true);
  assert.equal((await env.transport.send({ type: 'speak', id: 'one', text: 'Wait.' })).gestureRequired, true);
  assert.equal(env.calls.utterances.length, 0);
  assert.equal(env.transport.unlock(), true);
  assert.equal(env.transport.requiresGesture(), false);
  assert.equal(env.calls.utterances[0].volume, 0);
  const result = await env.transport.send({ type: 'speak', id: 'one', text: 'Read this.' });
  assert.equal(result.ok, true);
  assert.equal(env.calls.cancel, 1);
  assert.equal(env.calls.utterances.at(-1).text, 'Read this.');
});

test('stopping during a pending Safari tab claim prevents speech', async () => {
  const env = setup({ deferredClaim: true });
  env.transport.unlock();
  const pending = env.transport.send({ type: 'speak', id: 'old', text: 'Do not speak.' });
  await env.transport.send({ type: 'stop' });
  env.calls.claims[0]({ ok: true });
  assert.equal((await pending).ok, false);
  assert.equal(env.calls.utterances.length, 1);
  assert.ok(env.calls.messages.some(message => message.type === 'release-speech' && message.id === 'old'));
});

test('Safari room forwards progress and releases ownership at completion', async () => {
  const env = setup();
  const events = [];
  env.transport.onMessage(message => events.push(message));
  env.transport.unlock();
  await env.transport.send({ type: 'speak', id: 'run', text: 'Read this.' });
  const utterance = env.calls.utterances.at(-1);
  utterance.onstart();
  utterance.onboundary({ name: 'word', charIndex: 5 });
  utterance.onend();
  assert.deepEqual(events.map(message => message.event.type), ['start', 'word', 'end']);
  assert.ok(events.every(message => message.id === 'run'));
  assert.equal(env.calls.messages.at(-1).type, 'release-speech');
});

test('Safari audio denial re-arms the visible gesture prompt', async () => {
  const env = setup();
  env.transport.unlock();
  await env.transport.send({ type: 'speak', id: 'run', text: 'Read this.' });
  env.calls.utterances.at(-1).onerror({ error: 'not-allowed' });
  assert.equal(env.transport.requiresGesture(), true);
});

test('Safari tab hiding and popup preview stop room speech immediately', async () => {
  const env = setup();
  env.transport.unlock();
  await env.transport.send({ type: 'speak', id: 'run', text: 'Read this.' });
  env.document.hidden = true;
  env.listeners.visibilitychange();
  assert.equal((await env.transport.send({ type: 'speak', id: 'hidden', text: 'Do not read.' })).busy, true);
  env.document.hidden = false;
  env.listeners.message({ type: 'preview-start' });
  assert.equal((await env.transport.send({ type: 'speak', id: 'preview', text: 'Do not read.' })).busy, true);
  env.listeners.message({ type: 'preview-end' });
  assert.equal((await env.transport.send({ type: 'speak', id: 'after', text: 'Read now.' })).ok, true);
});

test('Safari popup starts preview synchronously and releases it on close', async () => {
  const env = setup({ room: false });
  vm.runInContext(read('popup-transport.js'), env.context);
  const pending = env.context.ProtoVoicePopupTransport.send({ type: 'preview', settings: { volume: .4 } });
  assert.equal(env.calls.utterances.length, 1, 'speech must begin before awaiting the background');
  assert.equal(env.calls.utterances[0].volume, .4);
  assert.equal((await pending).ok, true);
  env.listeners.pagehide();
  assert.equal(env.calls.cancel, 1);
  assert.equal(env.calls.messages.at(-1).type, 'end-preview');
});

test('Safari popup stops the old preview when settings change', async () => {
  const env = setup({ room: false });
  vm.runInContext(read('popup-transport.js'), env.context);
  await env.context.ProtoVoicePopupTransport.send({ type: 'preview', settings: {} });
  env.listeners.storage({ settings: { newValue: { voiceName: 'Another voice' } } }, 'local');
  assert.equal(env.calls.cancel, 1);
  assert.equal(env.calls.messages.at(-1).type, 'end-preview');
});

test('Safari popup exposes asynchronous voice discovery events', () => {
  const env = setup({ room: false });
  vm.runInContext(read('popup-transport.js'), env.context);
  let changes = 0;
  env.context.ProtoVoicePopupTransport.onVoicesChanged(() => changes++);
  env.listeners.voiceschanged();
  assert.equal(changes, 1);
});

function background() {
  const listeners = {};
  const calls = [];
  const event = name => ({ addListener(fn) { listeners[name] = fn; } });
  const chrome = {
    runtime: { onMessage: event('message'), getURL: name => `safari-web-extension://fixture/${name}` },
    tabs: { sendMessage(tabId, message) { calls.push({ tabId, message }); return Promise.resolve(); },
      query: () => Promise.resolve([{ id: 1 }]), onRemoved: event('removed'), onActivated: event('activated') },
    storage: { onChanged: event('storage') }
  };
  vm.runInNewContext(read('background.js'), { chrome, URL, console });
  const room = id => ({ tab: { id }, frameId: 0, url: 'https://protobowl.com/room' });
  const popup = { url: 'safari-web-extension://fixture/popup.html' };
  function send(message, sender = room(1)) {
    let result;
    listeners.message(message, sender, value => { result = value; });
    return result;
  }
  return { calls, listeners, room, popup, send };
}

test('Safari background rejects other origins and child frames', () => {
  const env = background();
  for (const sender of [
    { tab: { id: 1 }, url: 'https://protobowl.com.evil.example/room' },
    { tab: { id: 1 }, url: 'https://example.invalid/protobowl.com/' },
    { ...env.room(1), frameId: 2 }
  ]) assert.equal(env.send({ type: 'claim-speech', id: 'bad' }, sender), undefined);
  assert.equal(env.send({ type: 'claim-speech', id: 'good' }).ok, true);
});

test('Safari ownership cancellation cannot affect a newer utterance', () => {
  const env = background();
  env.send({ type: 'claim-speech', id: 'old' });
  env.send({ type: 'claim-speech', id: 'new' });
  env.send({ type: 'release-speech', id: 'old' });
  env.listeners.activated({ tabId: 2 });
  assert.deepEqual(env.calls.map(call => call.message.type), ['stop-speech']);
});

test('Safari preview locks room claims and ignores an old popup completion', () => {
  const env = background();
  env.send({ type: 'report-status', status: 'Reading' });
  env.send({ type: 'claim-speech', id: 'room' });
  env.send({ type: 'begin-preview', token: 'first' }, env.popup);
  env.send({ type: 'begin-preview', token: 'second' }, env.popup);
  env.send({ type: 'end-preview', token: 'first' }, env.popup);
  assert.equal(env.send({ type: 'claim-speech', id: 'wait' }).busy, true);
  env.send({ type: 'end-preview', token: 'second' }, env.popup);
  assert.equal(env.send({ type: 'claim-speech', id: 'after' }).ok, true);
  assert.ok(env.calls.some(call => call.message.type === 'preview-end'));
});
