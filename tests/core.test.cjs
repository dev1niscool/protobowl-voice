const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../extension/core.js');

const snapshot = (question, overrides = {}) => ({
  available: true, id: 'q:1', question,
  cumulative: question.split(' ').map((_, i) => 300 + i * 210),
  elapsed: 0, rate: 60, paused: false, buzzing: false, finished: false,
  ...overrides,
});

test('settings sanitize persisted values and clamp timing and audio controls', () => {
  assert.deepEqual(core.settings({ enabled: false, rate: 8, volume: -1, leadMs: 999,
    voiceName: 'a'.repeat(240) }), {
    enabled: false, rate: 1.5, volume: 0, leadMs: 300, voiceName: 'a'.repeat(200),
  });
  assert.deepEqual(core.settings({ rate: NaN, volume: Infinity, leadMs: '100', enabled: 'no' }),
    core.DEFAULTS);
  assert.deepEqual(core.settings(null), core.DEFAULTS);
  assert.deepEqual(core.settings('corrupt stored data'), core.DEFAULTS);
});

test('snapshot validation rejects inconsistent and unsafe timing data', () => {
  assert.equal(core.validSnapshot(snapshot('one two')), true);
  for (const change of [
    { available: false }, { rate: 0 }, { elapsed: Infinity },
    { cumulative: [300] }, { cumulative: [300, 299] },
    { cumulative: [300, NaN] }, { cumulative: [300, 86400001] },
    { question: '' }, { id: 'x'.repeat(401) },
  ]) assert.equal(core.validSnapshot(snapshot('one two', change)), false, JSON.stringify(change));
});

test('phrases preserve punctuation, skip formatting markers, and map UTF-16 indices', () => {
  const s = snapshot('(*) **Café** 𝛼 Euler’s theorem. Then another clause');
  const phrase = core.makePhrase(s, 0, core.DEFAULTS);
  assert.equal(phrase.text, 'Café 𝛼 Euler’s theorem.');
  for (const item of phrase.items) {
    assert.equal(phrase.text.slice(item.charIndex, item.charIndex + item.text.length), item.text);
  }
  assert.equal(phrase.nextIndex, 5);
  assert.equal(phrase.items[2].charIndex, 8);
  for (const marker of ['(*)', '()', '🧬', '**', '<i></i>']) assert.equal(core.cleanWord(marker), '');
});

test('phrase planning stays bounded and always advances over skipped words', () => {
  const s = snapshot(Array.from({ length: 60 }, (_, i) => i % 4 === 0 ? '*' : `word${i}`).join(' '));
  let index = 0;
  let count = 0;
  while (index < s.cumulative.length) {
    const phrase = core.makePhrase(s, index, core.DEFAULTS);
    if (!phrase) break;
    assert.ok(phrase.items.length <= 8);
    assert.ok(phrase.text.length <= 240);
    assert.ok(s.cumulative[phrase.last] - s.cumulative[phrase.first] <= 1250);
    assert.ok(phrase.nextIndex > index);
    assert.ok(phrase.rate >= .6 && phrase.rate <= 3.5);
    assert.ok(Number.isFinite(phrase.startAt));
    assert.ok(Number.isFinite(phrase.estimatedMs));
    index = phrase.nextIndex;
    count++;
    assert.ok(count < 60);
  }
  assert.ok(count > 1);
});

test('positive lead moves playback earlier, late starts speed up, and one-word questions work', () => {
  const s = snapshot('This statement has enough words for a complete sentence.');
  const normal = core.makePhrase(s, 0, { ...core.DEFAULTS, leadMs: 0 });
  const early = core.makePhrase(s, 0, { ...core.DEFAULTS, leadMs: 150 });
  assert.equal(early.startAt, normal.startAt - 150);
  assert.equal(early.targetEnd, normal.targetEnd - 150);
  const late = core.makePhrase({ ...s, elapsed: 1200 }, 0, core.DEFAULTS);
  assert.ok(late.rate >= normal.rate);
  const single = core.makePhrase(snapshot('Einstein.'), 0, core.DEFAULTS);
  assert.ok(Number.isFinite(single.startAt));
  assert.ok(single.estimatedMs > 0);
  assert.equal(single.nextIndex, 1);
});

test('oversized source tokens cannot exceed the speech API text cap', () => {
  const phrase = core.makePhrase(snapshot('a'.repeat(1000)), 0, core.DEFAULTS);
  assert.ok(phrase.text.length <= 240);
  assert.ok(phrase.rate >= .6 && phrase.rate <= 3.5);
  assert.equal(phrase.nextIndex, 1);
  const withSpace = core.makePhrase(snapshot(`${'a'.repeat(239)} b`), 0, core.DEFAULTS);
  assert.equal(withSpace.text.length, 239, 'separator counts toward the phrase character cap');
  assert.equal(withSpace.nextIndex, 1);
});

test('firstUnread selects next due word and handles the final reveal', () => {
  const s = snapshot('one two three', { elapsed: 510 });
  assert.equal(core.firstUnread(s), 1);
  assert.equal(core.firstUnread({ ...s, elapsed: 511 }), 2);
  assert.equal(core.firstUnread({ ...s, elapsed: 511 }, 10), 1);
  assert.equal(core.firstUnread({ ...s, elapsed: 10000 }), 3);
});

test('voice selection honors preference, prefers English natural speech, and rejects novelty by ranking', () => {
  const voices = [
    { voiceName: 'Boing', lang: 'en-US', eventTypes: ['word', 'end'] },
    { voiceName: 'French Enhanced', lang: 'fr-FR', eventTypes: ['word', 'end'] },
    { voiceName: 'Samantha Enhanced', lang: 'en-US', eventTypes: ['word', 'end'], remote: false },
    { voiceName: 'Standard', lang: 'en-US', remote: true },
  ];
  assert.equal(core.chooseVoice(voices, '').voiceName, 'Samantha Enhanced');
  assert.equal(core.chooseVoice(voices, 'Standard').voiceName, 'Standard');
  assert.equal(core.chooseVoice([], ''), undefined);
});
