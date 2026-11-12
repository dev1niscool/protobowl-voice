/* Shared pure timing logic. No network calls, page access, or audio side effects. */
((root) => {
  "use strict";
  const DEFAULTS = Object.freeze({ enabled: true, voiceName: "", rate: 1, volume: 1, leadMs: 80 });
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  function settings(value = {}) {
    if (!value || typeof value !== "object") value = {};
    const number = (key, min, max) => Number.isFinite(value[key]) ? clamp(value[key], min, max) : DEFAULTS[key];
    return { enabled: typeof value.enabled === "boolean" ? value.enabled : true,
      voiceName: typeof value.voiceName === "string" ? value.voiceName.slice(0, 200) : "",
      rate: number("rate", .7, 1.5), volume: number("volume", 0, 1), leadMs: number("leadMs", -150, 300) };
  }
  function validSnapshot(s) {
    return !!s && s.available === true && typeof s.id === "string" && s.id.length <= 400 &&
      typeof s.question === "string" && s.question.length > 0 && s.question.length <= 40000 &&
      Array.isArray(s.cumulative) && s.cumulative.length <= 2000 &&
      s.cumulative.length === s.question.split(" ").length && Number.isFinite(s.elapsed) &&
      Number.isFinite(s.rate) && s.rate > 0 &&
      s.cumulative.every((v, i, a) => Number.isFinite(v) && v >= 0 && v <= 86400000 && (!i || v >= a[i - 1]));
  }
  function cleanWord(word) {
    // Formatting/power markers are not spoken; punctuation is retained for prosody.
    const text = word.replace(/<[^>]*>/g, "").replace(/[*_{}]/g, "").trim().slice(0, 240);
    return /[\p{L}\p{N}]/u.test(text) ? text : "";
  }
  function baseDuration(word) {
    const letters = word.toLowerCase().replace(/[^a-z]/g, "");
    const groups = letters.replace(/e$/, "").match(/[aeiouy]+/g) || [];
    const syllables = Math.max(1, groups.length);
    return 75 + syllables * 125 + (/[.!?][\"')\]]*$/.test(word) ? 160 : /[,;:][\"')\]]*$/.test(word) ? 70 : 0);
  }
  function firstUnread(s, tolerance = 0) {
    const i = s.cumulative.findIndex(t => t >= s.elapsed - tolerance);
    return i < 0 ? s.cumulative.length : i;
  }
  function makePhrase(s, index, prefs, calibration = {}) {
    const words = s.question.split(" ");
    while (index < words.length && !cleanWord(words[index])) index++;
    if (index >= words.length) return null;
    const items = [];
    let text = "";
    let end = index;
    for (; end < words.length && items.length < 8; end++) {
      const word = cleanWord(words[end]);
      if (!word) continue;
      if (items.length && (s.cumulative[end] - s.cumulative[index] > 1250 || text.length + 1 + word.length > 240)) break;
      if (text) text += " ";
      items.push({ index: end, charIndex: text.length, text: word });
      text += word;
      if (/[.!?;:][\"')\]]*$/.test(word)) { end++; break; }
    }
    const factor = clamp(calibration.factor || 1, .5, 2);
    const latency = clamp(calibration.latency ?? 90, 0, 500);
    const duration = items.reduce((sum, w) => sum + baseDuration(w.text), 0) * factor;
    const first = items[0].index;
    const last = items.at(-1).index;
    const slot = clamp(first ? s.cumulative[first] - s.cumulative[first - 1] : (s.cumulative[first + 1] - s.cumulative[first]) || 220, 100, 700);
    const span = Math.max(120, s.cumulative[last] - s.cumulative[first] + slot);
    let rate = clamp(duration / span * prefs.rate, .6, 3.5);
    const lead = prefs.leadMs;
    const startAt = s.cumulative[first] - baseDuration(items[0].text) * factor / rate - latency - lead;
    // Correct slow drift at phrase boundaries; never build a queued backlog.
    if (s.elapsed > startAt + 60) {
      const remaining = Math.max(100, s.cumulative[last] - lead - s.elapsed - latency);
      rate = clamp(Math.max(rate, duration / remaining), .6, 3.5);
    }
    return { text, items, first, last, nextIndex: end, rate, startAt,
      estimatedMs: duration / rate, targetEnd: s.cumulative[last] - lead };
  }
  function chooseVoice(voices, requested) {
    const exact = voices.find(v => v.voiceName === requested);
    if (exact) return exact;
    const score = v => (/^en([-_]|$)/i.test(v.lang || "") ? 100 : 0) +
      (/natural|premium|enhanced|neural/i.test(v.voiceName) ? 40 : 0) +
      (/samantha|ava|serena|jenny|aria|guy/i.test(v.voiceName) ? 18 : 0) +
      (!v.remote ? 25 : 0) + ((v.eventTypes || []).includes("word") ? 12 : 0) +
      ((v.eventTypes || []).includes("end") ? 8 : 0) -
      (/novelty|whisper|bells|boing|bubbles|trinoids|zarvox|bad news|good news|cellos|organ|hysterical/i.test(v.voiceName) ? 150 : 0);
    return [...voices].sort((a, b) => score(b) - score(a))[0];
  }
  const api = { DEFAULTS, clamp, settings, validSnapshot, cleanWord, baseDuration, firstUnread, makePhrase, chooseVoice };
  root.ProtoVoice = api;
  if (typeof module !== "undefined") module.exports = api;
})(globalThis);
