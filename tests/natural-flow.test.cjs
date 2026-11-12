const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../extension/core.js');

const snapshot = (question, overrides = {}) => ({
  available: true, id: 'sentence-fixture', question,
  cumulative: question.split(' ').map((_, i) => 300 + i * 400),
  elapsed: 0, rate: 60, paused: false, buzzing: false, finished: false,
  ...overrides,
});
const natural = overrides => core.settings({ naturalFlow: true, ...overrides });
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < .001,
  `${message}: ${actual} versus ${expected}`);

test('Natural flow is explicitly opt-in and corrupt stored values do not enable it', () => {
  assert.equal(core.DEFAULTS.naturalFlow, false);
  assert.equal(core.settings().naturalFlow, false);
  assert.equal(core.settings({ naturalFlow: true }).naturalFlow, true);
  for (const value of [undefined, null, 'true', 1, {}, []]) {
    assert.equal(core.settings({ naturalFlow: value }).naturalFlow, false);
  }
});

test('the default word mode keeps its bounded phrases while Natural flow reads the complete sentence', () => {
  const first = Array.from({ length: 28 }, (_, i) => `description${i}`).join(' ') + '.';
  const s = snapshot(`${first} A second sentence follows.`);
  const wordMode = core.makePhrase(s, 0, core.settings());
  const sentenceMode = core.makePhrase(s, 0, natural());
  assert.ok(wordMode.items.length <= 8);
  assert.ok(wordMode.text.length <= 240);
  assert.equal(sentenceMode.text, first);
  assert.equal(sentenceMode.nextIndex, 28);
  assert.ok(sentenceMode.text.length > 240);
  assert.ok(s.cumulative[sentenceMode.last] - s.cumulative[sentenceMode.first] > 1250);
});

test('sentence boundaries retain common titles, initials, abbreviations, and decimal numbers', () => {
  const cases = [
    'Dr. Smith described the experiment.',
    'J. R. R. Tolkien wrote this novel.',
    'A U.S. historian studied the conflict.',
    'The value is approximately 3.14 units.',
  ];
  for (const first of cases) {
    const phrase = core.makePhrase(snapshot(`${first} Another sentence follows.`), 0, natural());
    assert.equal(phrase.text, first);
    assert.equal(phrase.nextIndex, first.split(' ').length);
  }
});

test('terminal abbreviations allow a new sentence while a following organization name stays connected', () => {
  for (const first of ['He lived in the U.S.', 'The award went to Martin Luther King Jr.']) {
    const next = first.endsWith('Jr.') ? 'He spoke to the crowd.' : 'This sentence follows.';
    const phrase = core.makePhrase(snapshot(`${first} ${next}`), 0, natural());
    assert.equal(phrase.text, first);
    assert.equal(phrase.nextIndex, first.split(' ').length);
  }
  const first = 'The U.S. Congress considered the proposal.';
  assert.equal(core.makePhrase(snapshot(`${first} This sentence follows.`), 0, natural()).text, first);
});

test('question marks, exclamations, and closing quotes end sentences, while semicolons and colons preserve flow', () => {
  for (const first of [
    'Who wrote this work?',
    'The crowd exclaimed, "It is finished!"',
    'The speaker said, “This is complete.”',
    'One clue follows another; the final clue is here.',
    'Consider this description: its last word ends the sentence.',
  ]) {
    assert.equal(core.makePhrase(snapshot(`${first} Next sentence.`), 0, natural()).text, first);
  }
});

test('sentence mode retains original word indices and UTF-16 boundary offsets after formatting removal', () => {
  const phrase = core.makePhrase(snapshot('(*) **Café** 𝛼 Euler’s theorem is discussed here. Next.'), 0, natural());
  assert.equal(phrase.text, 'Café 𝛼 Euler’s theorem is discussed here.');
  assert.equal(phrase.first, 1);
  assert.equal(phrase.last, 7);
  assert.equal(phrase.nextIndex, 8);
  assert.equal(phrase.items[2].charIndex, 8);
  for (const item of phrase.items) {
    assert.equal(phrase.text.slice(item.charIndex, item.charIndex + item.text.length), item.text);
  }
});

test('a resumed sentence starts at the supplied unread word and continues to its real ending', () => {
  const s = snapshot('The opening words have already been heard, but the remaining clause must flow naturally. Another sentence begins.');
  const phrase = core.makePhrase(s, 5, natural());
  assert.equal(phrase.text, 'been heard, but the remaining clause must flow naturally.');
  assert.equal(phrase.first, 5);
  assert.equal(phrase.nextIndex, 14);
});

test('a feasible sentence is scheduled to finish at its final reveal with one constant rate', () => {
  const s = snapshot('This sentence has room to be spoken in one flowing utterance.');
  const calibration = { latency: 80, factor: 1 };
  const phrase = core.makePhrase(s, 0, natural({ leadMs: 0 }), calibration);
  assert.equal(phrase.targetEnd, s.cumulative[phrase.last]);
  near(phrase.startAt + calibration.latency + phrase.estimatedMs, phrase.targetEnd, 'estimated endpoint');
  assert.ok(phrase.rate >= .6 && phrase.rate <= 3.5);
  assert.ok(phrase.startAt >= 0);
});

test('sentence timing adjustment shifts the ending target instead of adding word-level breaks', () => {
  const s = snapshot('A comfortably paced sentence can finish on its final revealed word.');
  const calibration = { latency: 60, factor: 1 };
  const aligned = core.makePhrase(s, 0, natural({ leadMs: 0 }), calibration);
  const earlier = core.makePhrase(s, 0, natural({ leadMs: 150 }), calibration);
  assert.equal(earlier.text, aligned.text);
  assert.equal(earlier.targetEnd, aligned.targetEnd - 150);
  near(earlier.startAt + calibration.latency + earlier.estimatedMs, earlier.targetEnd, 'adjusted endpoint');
});

test('the next sentence cannot start before the preceding sentence reaches its ending target', () => {
  const s = snapshot('First sentence ends. A second sentence should begin afterward.');
  const prefs = natural({ leadMs: 80 });
  const next = core.makePhrase(s, 3, prefs, { latency: 80, factor: 1 });
  assert.ok(next.startAt >= s.cumulative[2] - prefs.leadMs);
  assert.equal(next.text, 'A second sentence should begin afterward.');
});

test('waiting for a sentence start keeps its opening words even after those words appear visually', () => {
  const s = snapshot('The entire sentence stays intact while its natural starting time approaches.');
  const prefs = natural({ rate: 1.5 });
  const before = core.makePhrase(s, 0, prefs);
  const later = core.makePhrase({ ...s, elapsed: 600 }, 0, prefs);
  assert.equal(later.text, before.text);
  assert.equal(later.first, 0);
  assert.equal(later.nextIndex, before.nextIndex);
});

test('late starts, missing terminal punctuation, and one-word sentences produce finite bounded plans', () => {
  for (const question of ['Einstein.', 'This question ends without terminal punctuation']) {
    const s = snapshot(question);
    const phrase = core.makePhrase({ ...s, elapsed: s.cumulative.at(-1) - 10 }, 0, natural());
    assert.equal(phrase.nextIndex, s.cumulative.length);
    assert.ok(Number.isFinite(phrase.startAt));
    assert.ok(Number.isFinite(phrase.estimatedMs) && phrase.estimatedMs > 0);
    assert.ok(phrase.rate >= .6 && phrase.rate <= 3.5);
  }
});

test('very large sentences stay within the speech transport limit and progress without looping', () => {
  const s = snapshot(Array.from({ length: 1800 }, () => 'uncharacteristically').join(' ') + '.');
  let index = 0;
  let count = 0;
  while (index < s.cumulative.length) {
    const phrase = core.makePhrase(s, index, natural());
    if (!phrase) break;
    assert.ok(phrase.text.length <= 32000);
    assert.ok(phrase.nextIndex > index);
    index = phrase.nextIndex;
    assert.ok(++count < 10);
  }
  assert.equal(index, s.cumulative.length);
});
