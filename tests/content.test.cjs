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

test('Natural flow preserves the complete delayed sentence as its opening words become visible', async () => {
  const f = await fixture({ settings: { naturalFlow: true, leadMs: 0 } });
  const sentence = `${words}.`;
  const data = { question: sentence, cumulative: sentence.split(' ').map((_, i) => (i + 1) * 500) };
  f.snapshot(data);
  assert.equal(f.speeches.length, 0, 'the natural pace can wait before starting');
  for (let i = 0; i < 4; i++) {
    f.advance(500);
    f.snapshot(data);
    assert.equal(f.speeches.length, 0);
  }
  for (let i = 0; i < 10 && !f.speeches.length; i++) {
    f.advance(100);
    f.snapshot(data);
  }
  assert.equal(f.speeches.length, 1);
  assert.equal(f.speeches[0].text, sentence, 'revealed opening words are retained while waiting');
  assert.equal(f.speeches[0].naturalFlow, true);
});

test('Natural flow uses one utterance and one rate throughout a long active sentence', async () => {
  const f = await fixture({ settings: { naturalFlow: true } });
  const sentence = Array.from({ length: 40 }, (_, i) => i === 39 ? 'alpha.' : 'alpha').join(' ');
  const data = { question: sentence, cumulative: sentence.split(' ').map((_, i) => (i + 1) * 180) };
  f.snapshot(data);
  assert.equal(f.speeches.length, 1);
  const speech = f.speeches[0];
  f.speech(speech.id, 'start');
  for (let i = 1; i <= 6; i++) {
    f.advance(1000);
    f.speech(speech.id, 'word', { charIndex: i * 12 });
    f.snapshot(data);
    f.heartbeat();
  }
  assert.equal(f.speeches.length, 1, 'word reveals do not create new speech calls or rates');
  assert.equal(f.speeches[0], speech);
  assert.equal(f.stops.length, 0);
  assert.equal(f.status.status, 'Reading');
});

test('toggling Natural flow on cancels the phrase and stale callbacks cannot consume its sentence', async () => {
  const f = await fixture();
  const data = { question: `${words}.` };
  f.snapshot(data);
  const old = f.speeches[0];
  assert.equal(old.naturalFlow, false);
  f.changeSettings({ naturalFlow: true });
  assert.equal(f.stops.length, 1);
  assert.equal(f.speeches.length, 2);
  const current = f.speeches[1];
  assert.equal(current.text, `${words}.`);
  assert.equal(current.naturalFlow, true);
  f.speech(old.id, 'word', { charIndex: old.text.length });
  f.speech(old.id, 'end');
  f.speech(old.id, 'error', { errorMessage: 'stale mode change callback' });
  f.heartbeat();
  assert.equal(f.speeches.length, 2);
  assert.equal(f.status.status, 'Reading');
});

test('toggling Natural flow off restores bounded phrases without late sentence callbacks', async () => {
  const f = await fixture({ settings: { naturalFlow: true } });
  const data = { question: `${words}.` };
  f.snapshot(data);
  const sentence = f.speeches[0];
  f.advance(500);
  f.snapshot(data);
  f.changeSettings({ naturalFlow: false });
  assert.equal(f.stops.length, 1);
  assert.equal(f.speeches.length, 2);
  const phrase = f.speeches[1];
  assert.equal(phrase.naturalFlow, false);
  assert.ok(phrase.text.split(' ').length <= 8);
  assert.match(phrase.text, /^bravo/);
  f.speech(sentence.id, 'end');
  f.speech(sentence.id, 'word', { charIndex: sentence.text.length });
  f.heartbeat();
  assert.equal(f.speeches.length, 2);
  assert.equal(f.status.status, 'Reading');
});

test('buzzing stops a natural sentence and resumption speaks its remaining suffix in one utterance', async () => {
  const f = await fixture({ settings: { naturalFlow: true } });
  const data = { question: `${words}.` };
  f.snapshot(data);
  const sentence = f.speeches[0];
  f.speech(sentence.id, 'start');
  f.advance(600);
  f.speech(sentence.id, 'word', { charIndex: sentence.text.indexOf('charlie') });
  f.snapshot({ ...data, paused: true, buzzing: true });
  assert.equal(f.stops.length, 1);
  assert.equal(f.status.status, 'Buzzed');
  f.advance(100);
  f.snapshot({ ...data, elapsed: 600, paused: false, buzzing: false });
  assert.equal(f.speeches.length, 2);
  assert.equal(f.speeches[1].text, `${words.split(' ').slice(2).join(' ')}.`);
  assert.equal(f.speeches[1].naturalFlow, true);
});

test('a sentence over 500 characters reaches the worker with its Natural flow transport flag', async () => {
  const f = await fixture({ settings: { naturalFlow: true } });
  const sentence = Array.from({ length: 55 }, (_, i) => `description${i}${i === 54 ? '.' : ''}`).join(' ');
  const data = { question: sentence, cumulative: sentence.split(' ').map((_, i) => (i + 1) * 180) };
  f.snapshot(data);
  assert.equal(f.speeches.length, 1);
  assert.ok(f.speeches[0].text.length > 500);
  assert.equal(f.speeches[0].text, sentence);
  assert.equal(f.speeches[0].naturalFlow, true);
});

test('pausing before a delayed natural sentence starts preserves its unheard opening on resume', async () => {
  const f = await fixture({ settings: { naturalFlow: true, leadMs: 0 } });
  const sentence = `${words}.`;
  const data = { question: sentence, cumulative: sentence.split(' ').map((_, i) => (i + 1) * 500) };
  f.snapshot(data);
  f.advance(2000);
  f.snapshot({ ...data, paused: true });
  assert.equal(f.speeches.length, 0);
  f.advance(5000);
  f.snapshot({ ...data, elapsed: 2000, paused: true });
  f.snapshot({ ...data, elapsed: 2000, paused: false });
  for (let i = 1; i <= 10 && !f.speeches.length; i++) {
    f.advance(100);
    f.snapshot({ ...data, elapsed: 2000 + i * 100 });
  }
  assert.equal(f.speeches.length, 1);
  assert.equal(f.speeches[0].text, sentence);
});

test('a paused natural sentence resumes from the spoken boundary even when the visual text is farther ahead', async () => {
  const f = await fixture({ settings: { naturalFlow: true, leadMs: 0 } });
  const sentence = `${words}.`;
  const data = { question: sentence, cumulative: sentence.split(' ').map((_, i) => (i + 1) * 500) };
  f.snapshot(data);
  f.advance(3000);
  f.snapshot(data);
  assert.equal(f.speeches.length, 1);
  const old = f.speeches[0];
  f.speech(old.id, 'start');
  f.advance(150);
  f.speech(old.id, 'word', { charIndex: old.text.indexOf('bravo') });
  f.snapshot({ ...data, paused: true, buzzing: true });
  assert.equal(f.stops.length, 1);
  f.advance(500);
  f.snapshot({ ...data, elapsed: 3150, paused: false, buzzing: false });
  assert.equal(f.speeches.length, 2);
  assert.equal(f.speeches[1].text, `${words.split(' ').slice(1).join(' ')}.`);
  f.speech(old.id, 'end');
  f.heartbeat();
  assert.equal(f.speeches.length, 2);
});
