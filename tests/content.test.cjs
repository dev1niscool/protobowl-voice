const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const coreSource = fs.readFileSync(path.join(__dirname, '../extension/core.js'), 'utf8');
const contentSource = fs.readFileSync(path.join(__dirname, '../extension/content.js'), 'utf8');
const words = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa';
const flush = () => new Promise(resolve => setImmediate(resolve));

async function fixture({ settings = {}, send } = {}) {
  let now = 0;
  let heartbeat;
  let speechListener;
  let storageListener;
  const events = new Map();
  const sent = [];
  const on = (name, listener) => events.set(name, [...(events.get(name) || []), listener]);
  const window = { addEventListener: on };
  const document = { body: null, hidden: false, addEventListener: on };
  const chrome = {
    runtime: {
      sendMessage(message) {
        sent.push(message);
        if (send) {
          const result = send(message);
          if (result !== undefined) return result;
        }
        return Promise.resolve(message.type === 'speak' ? { ok: true, voiceName: 'Test voice' } : { ok: true });
      },
      onMessage: { addListener(listener) { speechListener = listener; } },
    },
    storage: {
      local: { get: async () => ({ settings }), set: async () => {} },
      onChanged: { addListener(listener) { storageListener = listener; } },
    },
  };
  const context = vm.createContext({
    window, document, chrome,
    location: { origin: 'https://protobowl.com', pathname: '/' },
    performance: { now: () => now },
    Date: { now: () => now },
    Element: class Element {},
    setInterval(callback) { heartbeat = callback; },
  });
  vm.runInContext(coreSource, context, { filename: 'core.js' });
  vm.runInContext(contentSource, context, { filename: 'content.js' });
  await flush();
  return {
    sent, document,
    get speeches() { return sent.filter(message => message.type === 'speak'); },
    get stops() { return sent.filter(message => message.type === 'stop'); },
    get status() { return sent.filter(message => message.type === 'report-status').at(-1); },
    advance(ms) { now += ms; },
    heartbeat() { heartbeat(); },
    emit(name, event = {}) { for (const listener of events.get(name) || []) listener(event); },
    snapshot(overrides = {}, eventOverrides = {}) {
      const snapshot = {
        id: 'q1', question: words, cumulative: words.split(' ').map((_, i) => (i + 1) * 300),
        elapsed: now, paused: false, buzzing: false, finished: false, rate: 60, available: true,
        ...overrides,
      };
      this.emit('message', {
        source: window, origin: 'https://protobowl.com',
        data: { source: 'protobowl-voice-page', type: 'snapshot', snapshot },
        ...eventOverrides,
      });
    },
    speech(id, type, extra = {}) { speechListener({ type: 'speech-event', id, event: { type, ...extra } }); },
    changeSettings(value) { storageListener({ settings: { newValue: value } }, 'local'); },
    runtime(message) { speechListener(message); },
  };
}

test('starts current speech and does not queue another utterance while one is active', async () => {
  const f = await fixture();
  f.snapshot();
  assert.equal(f.speeches.length, 1);
  assert.match(f.speeches[0].text, /^alpha bravo/);
  f.advance(500);
  f.snapshot();
  f.heartbeat();
  await flush();
  assert.equal(f.speeches.length, 1);
});

test('joining mid-question begins at the current reveal instead of reciting the beginning', async () => {
  const f = await fixture();
  f.advance(2400);
  f.snapshot();
  assert.equal(f.speeches.length, 1);
  assert.match(f.speeches[0].text, /^hotel/);
  assert.doesNotMatch(f.speeches[0].text, /alpha|bravo|charlie/);
});

test('pausing cancels immediately, ignores old events, and resumes after completed words', async () => {
  const f = await fixture();
  f.snapshot();
  const first = f.speeches[0];
  f.speech(first.id, 'start');
  f.advance(600);
  f.speech(first.id, 'word', { charIndex: first.text.indexOf('charlie') });
  f.snapshot({ paused: true });
  assert.equal(f.stops.length, 1);
  assert.equal(f.status.status, 'Paused');
  f.speech(first.id, 'end');
  f.speech(first.id, 'error', { errorMessage: 'late cancellation callback' });
  f.advance(100);
  f.snapshot({ elapsed: 600, paused: true });
  assert.equal(f.speeches.length, 1);
  f.snapshot({ elapsed: 600, paused: false });
  assert.equal(f.speeches.length, 2);
  assert.match(f.speeches[1].text, /^charlie/);
  assert.notEqual(f.speeches[1].id, first.id);
});

test('a buzz cancels speech and a wrong-answer resume starts a fresh utterance', async () => {
  const f = await fixture();
  f.snapshot();
  f.advance(500);
  f.snapshot({ paused: true, buzzing: true });
  assert.equal(f.stops.length, 1);
  assert.equal(f.status.status, 'Buzzed');
  f.advance(100);
  f.snapshot({ elapsed: 500, paused: false, buzzing: false });
  assert.equal(f.speeches.length, 2);
  assert.match(f.speeches[1].text, /^bravo/);
});

test('new question cancels old speech and late events cannot advance the new question', async () => {
  const f = await fixture();
  f.snapshot();
  const old = f.speeches[0];
  f.advance(100);
  f.snapshot({ id: 'q2', question: words.replace('alpha', 'zulu'), elapsed: 0 });
  assert.equal(f.stops.length, 1);
  assert.equal(f.speeches.length, 2);
  assert.match(f.speeches[1].text, /^zulu/);
  f.speech(old.id, 'word', { charIndex: 100 });
  f.speech(old.id, 'end');
  f.speech(old.id, 'error', { errorMessage: 'old error' });
  assert.equal(f.speeches.length, 2);
  assert.equal(f.status.status, 'Reading');
});

test('disabling cancels playback, and enabling later rejoins without a backlog', async () => {
  const f = await fixture();
  f.snapshot();
  f.changeSettings({ enabled: false });
  assert.equal(f.stops.length, 1);
  assert.equal(f.status.status, 'Off');
  f.advance(2400);
  f.snapshot();
  assert.equal(f.speeches.length, 1);
  f.changeSettings({ enabled: true });
  assert.equal(f.speeches.length, 2);
  assert.match(f.speeches[1].text, /^hotel/);
});

test('a deferred reply for canceled speech cannot introduce a retry delay into the next question', async () => {
  let rejectOld;
  let first = true;
  const f = await fixture({ send(message) {
    if (message.type === 'speak' && first) {
      first = false;
      return new Promise(resolve => { rejectOld = resolve; });
    }
  } });
  f.snapshot();
  f.snapshot({ id: 'q2' });
  assert.equal(f.speeches.length, 2);
  rejectOld({ ok: false, error: 'stale voice failure' });
  await flush();
  f.heartbeat();
  assert.equal(f.status.status, 'Reading');
  assert.equal(f.speeches.length, 2);
});

test('worker rejection backs off, then retries at the current words', async () => {
  let first = true;
  const f = await fixture({ send(message) {
    if (message.type === 'speak' && first) {
      first = false;
      return Promise.resolve({ ok: false, error: 'Voice missing' });
    }
  } });
  f.snapshot();
  await flush();
  f.advance(200);
  f.snapshot();
  assert.equal(f.status.status, 'Voice unavailable');
  assert.equal(f.speeches.length, 1);
  f.advance(3801);
  f.snapshot();
  assert.equal(f.speeches.length, 2);
  assert.match(f.speeches[1].text, /^mike/);
});

test('busy worker rejection retries promptly rather than using the error cooldown', async () => {
  let first = true;
  const f = await fixture({ send(message) {
    if (message.type === 'speak' && first) {
      first = false;
      return Promise.resolve({ ok: false, busy: true });
    }
  } });
  f.snapshot();
  await flush();
  f.advance(200);
  f.snapshot();
  assert.equal(f.speeches.length, 1);
  f.advance(101);
  f.snapshot();
  assert.equal(f.speeches.length, 2);
});

test('a stuck voice is canceled and old unread phrases are dropped', async () => {
  const f = await fixture();
  f.snapshot();
  f.advance(3900);
  f.snapshot();
  assert.equal(f.stops.length, 1);
  assert.equal(f.speeches.length, 2);
  assert.match(f.speeches[1].text, /^mike/);
  assert.doesNotMatch(f.speeches[1].text, /foxtrot|golf|hotel/);
});

test('a stalled adapter stops speech and waits for a fresh snapshot', async () => {
  const f = await fixture();
  f.snapshot();
  f.advance(1201);
  f.heartbeat();
  assert.equal(f.stops.length, 1);
  assert.equal(f.status.status, 'Waiting');
  f.heartbeat();
  assert.equal(f.speeches.length, 1);
  f.snapshot();
  assert.equal(f.speeches.length, 2);
  assert.match(f.speeches[1].text, /^delta/);
});

test('hiding the tab cancels playback and returning rejoins at the current word', async () => {
  const f = await fixture();
  f.snapshot();
  f.document.hidden = true;
  f.emit('visibilitychange');
  assert.equal(f.stops.length, 1);
  assert.equal(f.status.status, 'Tab inactive');
  f.advance(2400);
  f.snapshot();
  assert.equal(f.speeches.length, 1);
  f.document.hidden = false;
  f.emit('visibilitychange');
  assert.equal(f.speeches.length, 2);
  assert.match(f.speeches[1].text, /^hotel/);
});

test('finished or malformed snapshot stops an active question', async t => {
  for (const overrides of [{ finished: true }, { cumulative: [NaN] }, { available: false }]) {
    await t.test(JSON.stringify(overrides), async () => {
      const f = await fixture();
      f.snapshot();
      f.snapshot(overrides);
      assert.equal(f.stops.length, 1);
      assert.equal(f.speeches.length, 1);
    });
  }
});

test('snapshots from other origins or other windows cannot trigger speech', async () => {
  const f = await fixture();
  f.snapshot({}, { origin: 'https://example.com' });
  f.snapshot({}, { source: {} });
  assert.equal(f.speeches.length, 0);
  f.snapshot();
  assert.equal(f.speeches.length, 1);
});
