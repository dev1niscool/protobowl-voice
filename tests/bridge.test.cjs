const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../extension/bridge.js'), 'utf8');

function fixture(overrides = {}) {
  const room = {
    question: 'Alpha beta.',
    qid: 'question-1',
    generated_time: 100,
    seen: 1,
    timing: [3, 3],
    cumulative: [300, 480],
    rate: 60,
    begin_time: 1000,
    end_time: 6480,
    time_freeze: 0,
    attempt: null,
    now: 1000,
    time() { return this.time_freeze || this.now; },
    ...overrides,
  };
  const messages = [];
  const timers = new Map();
  const events = new Map();
  let nextTimer = 0;
  const on = (name, callback) => {
    events.set(name, [...(events.get(name) || []), callback]);
  };
  const window = {
    yo: room,
    postMessage(message, targetOrigin) {
      messages.push({ message, targetOrigin });
    },
    addEventListener: on,
  };
  const document = { hidden: false, addEventListener: on };
  const context = {
    window,
    document,
    location: { origin: 'https://protobowl.com' },
    setTimeout(callback, delay) {
      timers.set(++nextTimer, { callback, delay });
      return nextTimer;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  vm.runInNewContext(source, context, { filename: 'bridge.js' });

  return {
    room, window, document, messages, timers,
    get snapshot() { return messages.at(-1).message.snapshot; },
    tick() {
      assert.equal(timers.size, 1, 'adapter must have exactly one polling timer');
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      timer.callback();
    },
    emit(name) {
      for (const listener of events.get(name) || []) listener();
    },
    delay() { return timers.values().next().value?.delay; },
  };
}

test('publishes the current reveal schedule without changing game state', () => {
  const f = fixture();
  assert.equal(f.snapshot.available, true);
  assert.equal(f.snapshot.question, 'Alpha beta.');
  assert.deepEqual(Array.from(f.snapshot.cumulative), [300, 480]);
  assert.equal(f.snapshot.elapsed, 0);
  assert.equal(f.snapshot.paused, false);
  assert.equal(f.snapshot.buzzing, false);
  assert.equal(f.snapshot.finished, false);
  assert.equal(f.snapshot.rate, 60);
  assert.equal(f.messages[0].message.source, 'protobowl-voice-page');
  assert.equal(f.messages[0].message.type, 'snapshot');
  assert.equal(f.messages[0].targetOrigin, 'https://protobowl.com');
  assert.equal(f.room.begin_time, 1000);
  assert.equal(f.room.now, 1000);
  assert.equal(f.delay(), 50);
});

test('question identity stays stable through pause and speed changes', () => {
  const f = fixture();
  const id = f.snapshot.id;
  f.room.time_freeze = 1400;
  f.tick();
  assert.equal(f.snapshot.id, id);
  assert.equal(f.snapshot.elapsed, 400);
  assert.equal(f.snapshot.paused, true);
  f.room.time_freeze = 0;
  f.room.begin_time = 800;
  f.room.rate = 80;
  f.room.cumulative = [400, 640];
  f.tick();
  assert.equal(f.snapshot.id, id);
  assert.equal(f.snapshot.elapsed, 200);
  assert.deepEqual(Array.from(f.snapshot.cumulative), [400, 640]);
});

test('the same question gets a new identity when generated again', () => {
  const f = fixture();
  const id = f.snapshot.id;
  f.room.generated_time = 200;
  f.tick();
  assert.notEqual(f.snapshot.id, id);
  assert.equal(f.snapshot.question, 'Alpha beta.');
  const repeatedId = f.snapshot.id;
  f.tick();
  assert.equal(f.snapshot.id, repeatedId);
});

test('fallback identity distinguishes changed text without generated_time', () => {
  const f = fixture({ generated_time: undefined });
  const id = f.snapshot.id;
  f.room.question = 'Gamma delta.';
  f.tick();
  assert.notEqual(f.snapshot.id, id);
});

test('buzz stops reading and wrong-answer unfreeze allows resumption', () => {
  const f = fixture();
  f.room.time_freeze = 1400;
  f.room.attempt = { done: false };
  f.tick();
  assert.equal(f.snapshot.buzzing, true);
  assert.equal(f.snapshot.paused, true);
  assert.equal(f.snapshot.finished, false);
  f.room.time_freeze = 0;
  f.room.now = 1450;
  f.room.attempt = { done: true, correct: false };
  f.tick();
  assert.equal(f.snapshot.buzzing, false);
  assert.equal(f.snapshot.paused, false);
  assert.equal(f.snapshot.finished, false);
  assert.equal(f.snapshot.elapsed, 450);
});

test('final word revelation does not finish speech during the answer grace period', () => {
  const f = fixture();
  for (const now of [1480, 1481, 3000, 6479]) {
    f.room.now = now;
    f.tick();
    assert.equal(f.snapshot.finished, false, `must allow final speech at time ${now}`);
  }
  f.room.now = f.room.end_time;
  f.tick();
  assert.equal(f.snapshot.finished, true);
});

test('a completed correct answer finishes immediately', () => {
  const f = fixture({ attempt: { done: true, correct: true } });
  assert.equal(f.snapshot.finished, true);
  assert.equal(f.snapshot.buzzing, false);
});

test('a prompt is still an active buzz, not a completed correct answer', () => {
  const f = fixture({ attempt: { done: false, correct: 'prompt' }, time_freeze: 1300 });
  assert.equal(f.snapshot.finished, false);
  assert.equal(f.snapshot.buzzing, true);
});

test('reconstructs missing cumulative timing using the site formula', () => {
  const f = fixture({ cumulative: undefined });
  assert.equal(f.snapshot.available, true);
  assert.deepEqual(Array.from(f.snapshot.cumulative), [300, 480]);
});

test('rejects invalid schedules, clock state, and oversized questions', async t => {
  const invalid = [
    ['non-finite deadline', { cumulative: [300, NaN] }],
    ['negative deadline', { cumulative: [-1, 480] }],
    ['decreasing deadlines', { cumulative: [500, 480] }],
    ['excessive deadline', { cumulative: [300, 86400001] }],
    ['missing timing', { cumulative: [], timing: undefined }],
    ['non-finite fallback weight', { cumulative: [], timing: [NaN, 3] }],
    ['zero rate', { rate: 0 }],
    ['non-finite rate', { rate: Infinity }],
    ['invalid start', { begin_time: NaN }],
    ['invalid clock', { now: NaN }],
    ['empty question', { question: '' }],
    ['too many words', { question: 'a '.repeat(2001) }],
    ['too many characters', { question: 'a'.repeat(40001) }],
    ['missing clock method', { time: null }],
  ];
  for (const [name, overrides] of invalid) {
    await t.test(name, () => {
      const f = fixture(overrides);
      assert.equal(f.snapshot.available, false);
      assert.equal(f.snapshot.question, '');
      assert.equal(f.snapshot.cumulative.length, 0);
    });
  }
});

test('reports unavailable when the room disappears and recovers when it returns', () => {
  const f = fixture();
  f.window.yo = undefined;
  f.tick();
  assert.equal(f.snapshot.available, false);
  f.window.yo = f.room;
  f.tick();
  assert.equal(f.snapshot.available, true);
});

test('clock exceptions cannot escape the adapter', () => {
  const f = fixture({ time() { throw new Error('site loading'); } });
  assert.equal(f.snapshot.available, false);
  assert.equal(f.timers.size, 1);
  f.room.time = () => 1000;
  f.tick();
  assert.equal(f.snapshot.available, true);
});

test('visibility changes publish immediately and adjust polling without duplicate timers', () => {
  const f = fixture();
  f.document.hidden = true;
  f.emit('visibilitychange');
  assert.equal(f.messages.length, 2);
  assert.equal(f.delay(), 1000);
  assert.equal(f.timers.size, 1);
  f.document.hidden = false;
  f.emit('visibilitychange');
  assert.equal(f.messages.length, 3);
  assert.equal(f.delay(), 50);
  assert.equal(f.timers.size, 1);
});

test('pagehide cancels polling and pageshow restarts it for back-forward navigation', () => {
  const f = fixture();
  f.emit('pagehide');
  assert.equal(f.snapshot.available, false);
  assert.equal(f.timers.size, 0);
  const count = f.messages.length;
  f.emit('visibilitychange');
  assert.equal(f.messages.length, count);
  assert.equal(f.timers.size, 0);
  f.emit('pageshow');
  assert.equal(f.snapshot.available, true);
  assert.equal(f.timers.size, 1);
  assert.equal(f.delay(), 50);
});
