// Runs in the page's MAIN world. It only reads ProtoBowl state: no socket
// interception, game actions, answer access, or changes to the reveal clock.
(() => {
  "use strict";

  const SOURCE = "protobowl-voice-page";
  const MAX_QUESTION_LENGTH = 40000;
  const MAX_WORDS = 2000;
  let timer;
  let suspended = false;
  let generation = 0;
  let previousIdentity = "";

  const unavailable = () => ({
    id: "",
    question: "",
    cumulative: [],
    elapsed: 0,
    paused: false,
    buzzing: false,
    finished: false,
    rate: 60,
    available: false,
  });

  function readSnapshot() {
    // `yo` is the room object in the current production app.js. Fail closed if
    // a future site release changes that interface instead of guessing text.
    const room = window.yo;
    if (!room || typeof room.time !== "function" ||
        typeof room.question !== "string" || !room.question ||
        room.question.length > MAX_QUESTION_LENGTH) return unavailable();

    const question = room.question;
    const wordCount = question.split(" ").length;
    if (wordCount > MAX_WORDS) return unavailable();

    const rate = Number(room.rate);
    const begin = Number(room.begin_time);
    const now = Number(room.time());
    if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(begin) ||
        !Number.isFinite(now)) return unavailable();

    let cumulative = Array.isArray(room.cumulative) ? room.cumulative.slice() : [];
    if (cumulative.length !== wordCount && Array.isArray(room.timing) &&
        room.timing.length === wordCount) {
      // Match ProtoBowl's set_speed/sync calculation exactly. The initial
      // five-unit delay is followed by each preceding word's weighted delay.
      let total = 0;
      cumulative = [5, ...room.timing.slice(0, -1)].map(weight => {
        total += Math.round(Number(weight) * rate);
        return total;
      });
    }
    if (cumulative.length !== wordCount || cumulative.some((value, i) =>
      !Number.isFinite(value) || value < 0 || value > 86400000 ||
      (i > 0 && value < cumulative[i - 1]))) return unavailable();

    // generated_time changes for each new question (including repeats) and is
    // unaffected by set_speed, which DOES rewrite begin_time. This is also
    // how ProtoBowl decides to create a new active question in its own UI.
    const qid = typeof room.qid === "string" || typeof room.qid === "number"
      ? String(room.qid).slice(0, 200) : "question";
    const generated = Number.isFinite(room.generated_time) ? room.generated_time : null;
    const seen = Number.isFinite(room.seen) ? room.seen : null;
    const identity = JSON.stringify([qid, generated, seen, question]);
    if (identity !== previousIdentity) {
      generation += 1;
      previousIdentity = identity;
    }

    const end = Number(room.end_time);
    const attempt = room.attempt;
    return {
      id: `${qid}:${generated === null ? "local" : generated}:${generation}`,
      question,
      cumulative,
      elapsed: now - begin,
      paused: Boolean(room.time_freeze),
      buzzing: Boolean(attempt && !attempt.done),
      // Do not stop on the final reveal: its speech can still be completing.
      // end_time includes the answer grace period; finish() jumps there.
      finished: (Number.isFinite(end) && end > begin && now >= end) ||
        Boolean(attempt && attempt.done && attempt.correct === true),
      rate,
      available: true,
    };
  }

  function publish() {
    let snapshot;
    try {
      snapshot = readSnapshot();
    } catch (_) {
      // During page initialization or a site update, report unavailable and
      // retry. Never let an adapter error interfere with the game's scripts.
      snapshot = unavailable();
    }
    window.postMessage({ source: SOURCE, type: "snapshot", snapshot }, location.origin);
  }

  function tick() {
    clearTimeout(timer);
    if (suspended) return;
    publish();
    timer = setTimeout(tick, document.hidden ? 1000 : 50);
  }

  document.addEventListener("visibilitychange", tick);
  window.addEventListener("pagehide", () => {
    suspended = true;
    clearTimeout(timer);
    window.postMessage({ source: SOURCE, type: "snapshot", snapshot: unavailable() }, location.origin);
  });
  window.addEventListener("pageshow", () => {
    suspended = false;
    tick();
  });
  tick();
})();
