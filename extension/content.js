(() => {
  "use strict";
  const C = ProtoVoice;
  let prefs = C.settings();
  let loaded = false;
  let latest = null;
  let receivedAt = 0;
  let questionId = "";
  let nextIndex = 0;
  let completedUntil = 0;
  let active = null;
  let counter = 0;
  let retryAt = 0;
  let previewUntil = 0;
  let disconnected = false;
  let voiceName = "";
  let error = "";
  let lagMs;
  let reportedAt = 0;
  let reportedStatus = "";
  let chip;
  let calibration = { factor: 1, latency: 90 };

  async function message(data) {
    if (disconnected) return null;
    try { return await chrome.runtime.sendMessage(data); }
    catch (_) {
      disconnected = true;
      error = "Extension updated. Refresh this room.";
      updateStatus("Refresh this room", error);
      return null;
    }
  }
  function clock() {
    return latest ? latest.elapsed + (latest.paused || latest.buzzing ? 0 : Math.min(250, performance.now() - receivedAt)) : 0;
  }
  function updateStatus(status, detail = "") {
    const full = `${status}|${detail}`;
    if (!chip && document.body && location.pathname !== "/") {
      const host = document.createElement("div");
      host.id = "protobowl-voice-control";
      // A shadow root keeps the game's Bootstrap rules out of the control.
      const shadow = host.attachShadow({ mode: "closed" });
      shadow.innerHTML = `<style>
        :host{position:fixed;right:16px;bottom:16px;z-index:10000;font:12px/1.4 system-ui,sans-serif}
        button{font:inherit;color:#e8f4ee;background:#162a25;border:1px solid #406457;border-radius:24px;padding:9px 13px;box-shadow:0 3px 14px #0003;cursor:pointer;display:flex;align-items:center;gap:8px}
        button:focus-visible{outline:3px solid #80e6b8;outline-offset:3px}
        i{width:6px;height:6px;border-radius:100%;background:#80e6b8}button[aria-pressed=false] i{background:#91a09a}
      </style><button type="button"><i aria-hidden="true"></i><span></span></button>`;
      chip = shadow.querySelector("button");
      chip.addEventListener("click", () => {
        prefs = { ...prefs, enabled: !prefs.enabled };
        chrome.storage.local.set({ settings: prefs }).catch(() => {});
        if (!prefs.enabled) cancel();
        tick();
      });
      document.body.append(host);
    }
    if (chip) {
      chip.querySelector("span").textContent = `Voice · ${status}`;
      chip.setAttribute("aria-pressed", String(prefs.enabled));
      chip.setAttribute("aria-label", `${prefs.enabled ? "Disable" : "Enable"} ProtoBowl Voice. ${status}`);
      chip.title = `${detail || status}\nClick to ${prefs.enabled ? "mute" : "enable"}. Voice and timing controls are in the extension popup.`;
    }
    if (!disconnected && (full !== reportedStatus || performance.now() - reportedAt > 1000)) {
      reportedStatus = full;
      reportedAt = performance.now();
      void message({ type: "report-status", status, detail, voiceName, lagMs });
    }
  }
  function cancel() {
    if (active) {
      active = null; // Invalidate callbacks before stop generates interruption events.
      counter++;
      void message({ type: "stop" });
    }
  }
  function rejoin() {
    if (latest) nextIndex = Math.max(completedUntil, C.firstUnread(latest, 120));
  }
  function tick() {
    if (!loaded || disconnected) return;
    if (!prefs.enabled) { cancel(); updateStatus("Off", "Enable Voice to read new question words."); return; }
    if (document.hidden) { cancel(); rejoin(); updateStatus("Tab inactive", "Speech resumes at the current word when you return."); return; }
    if (!latest || performance.now() - receivedAt > 1200) {
      cancel(); updateStatus("Waiting", "Waiting for ProtoBowl's question timing. Start a question or refresh the room."); return;
    }
    if (latest.finished) { cancel(); updateStatus("Question finished", "Ready for the next question."); return; }
    if (latest.paused || latest.buzzing) {
      cancel(); rejoin(); updateStatus(latest.buzzing ? "Buzzed" : "Paused", "Speech follows the room and resumes with the question."); return;
    }
    if (Date.now() < previewUntil) { cancel(); rejoin(); updateStatus("Voice preview", "Question reading resumes after the preview."); return; }
    if (Date.now() < retryAt) { updateStatus(error ? "Voice unavailable" : "Ready", error); return; }
    const s = { ...latest, elapsed: clock() };
    if (active) {
      if (performance.now() - active.requestedAt > active.phrase.estimatedMs + calibration.latency + 1800) {
        // Voices without completion events must not block all later questions.
        nextIndex = active.phrase.nextIndex;
        completedUntil = nextIndex;
        cancel();
        error = "This voice is slow or does not report completion. Try another voice.";
      } else { updateStatus("Reading", voiceName || "Matching the question reveal."); return; }
    }
    // Joining/rejoining does not recite old text or accumulate a long queue.
    if (s.cumulative[nextIndex] < s.elapsed - 800) {
      nextIndex = Math.max(nextIndex, C.firstUnread(s, 120));
    }
    const phrase = C.makePhrase(s, nextIndex, prefs, calibration);
    if (!phrase) { updateStatus("Ready", "All question words have been read. Waiting for the next question."); return; }
    if (s.elapsed < phrase.startAt) { updateStatus("Ready", "Following the room's reveal schedule."); return; }
    const id = `${questionId}/${++counter}`;
    const run = { id, phrase, requestedAt: performance.now(), startedAt: null, firstWordAt: null };
    active = run;
    updateStatus("Reading", voiceName || "Matching the question reveal.");
    message({ type: "speak", id, text: phrase.text, voiceName: prefs.voiceName, rate: phrase.rate, volume: prefs.volume }).then(result => {
      if (active !== run) return;
      if (!result?.ok) {
        active = null;
        retryAt = Date.now() + (result?.busy ? 300 : 4000);
        error = result?.error || "";
      } else { voiceName = result.voiceName; error = ""; }
    });
  }

  window.addEventListener("message", event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== "protobowl-voice-page" || event.data.type !== "snapshot") return;
    const snapshot = event.data.snapshot;
    if (!C.validSnapshot(snapshot)) { latest = null; cancel(); tick(); return; }
    const changed = snapshot.id !== questionId;
    if (changed) {
      cancel();
      questionId = snapshot.id;
      completedUntil = 0;
      nextIndex = C.firstUnread(snapshot, 200);
      lagMs = undefined;
    } else if (latest && (snapshot.rate !== latest.rate ||
      (!latest.paused && !snapshot.paused && Math.abs(snapshot.elapsed - latest.elapsed - (performance.now() - receivedAt)) > 750))) {
      cancel();
      nextIndex = Math.max(completedUntil, C.firstUnread(snapshot, 120));
    }
    latest = snapshot;
    receivedAt = performance.now();
    tick();
  });
  chrome.runtime.onMessage.addListener(message => {
    if (message.type === "preview-start") { cancel(); previewUntil = Date.now() + 8000; return; }
    if (message.type === "preview-end") { previewUntil = 0; rejoin(); tick(); return; }
    if (message.type !== "speech-event" || !active || message.id !== active.id) return;
    const run = active;
    const event = message.event;
    if (event.type === "start") {
      run.startedAt = performance.now();
    }
    if (event.type === "word" && Number.isFinite(event.charIndex)) {
      if (run.firstWordAt === null) {
        run.firstWordAt = performance.now();
        // Native engines may emit `start` before audio is ready. The first
        // word boundary is a better measurement of their actual startup delay.
        const latency = C.clamp(run.firstWordAt - run.requestedAt, 0, 500);
        calibration.latency = calibration.latency * .7 + latency * .3;
      }
      const i = run.phrase.items.findLastIndex(w => w.charIndex <= event.charIndex);
      if (i > 0) {
        const previous = run.phrase.items[i - 1];
        completedUntil = Math.max(completedUntil, previous.index + 1);
        lagMs = Math.round(clock() - latest.cumulative[previous.index]);
      }
    }
    if (event.type === "end") {
      const now = performance.now();
      const actual = now - (run.firstWordAt ?? run.startedAt ?? (run.requestedAt + calibration.latency));
      const base = run.phrase.items.reduce((n, w) => n + C.baseDuration(w.text), 0);
      if (actual > 80) calibration.factor = C.clamp(.8 * calibration.factor + .2 * actual * run.phrase.rate / base, .5, 2);
      lagMs = Math.round(clock() - latest.cumulative[run.phrase.last]);
      nextIndex = run.phrase.nextIndex;
      completedUntil = nextIndex;
      active = null;
      tick();
    } else if (["interrupted", "cancelled", "error"].includes(event.type)) {
      active = null;
      rejoin();
      if (event.type === "error") { error = event.errorMessage || "The selected voice could not speak."; retryAt = Date.now() + 4000; }
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.settings) return;
    cancel();
    const next = C.settings(changes.settings.newValue);
    if (next.voiceName !== prefs.voiceName) calibration = { factor: 1, latency: 90 };
    prefs = next;
    retryAt = 0;
    error = "";
    rejoin();
    tick();
  });
  document.addEventListener("visibilitychange", () => { cancel(); rejoin(); tick(); });
  window.addEventListener("pagehide", () => { cancel(); void message({ type: "stop" }); });
  // Stop locally at the buzz gesture, before the server round trip arrives.
  document.addEventListener("keydown", event => {
    const input = event.target instanceof Element && event.target.closest("input,textarea,select,[contenteditable=true]");
    if (!input && (event.code === "Space" || event.code === "KeyB")) { cancel(); retryAt = Date.now() + 300; }
  }, true);
  document.addEventListener("click", event => {
    if (event.target instanceof Element && event.target.closest(".buzzbtn")) { cancel(); retryAt = Date.now() + 300; }
  }, true);
  chrome.storage.local.get("settings").then(data => {
    prefs = C.settings(data.settings);
    loaded = true;
    // Prime a cold native speech engine silently while the room loads. Actual
    // question speech can cancel this at any time and is never queued behind it.
    if (prefs.enabled && !latest && !document.hidden) void message({ type: "warmup", voiceName: prefs.voiceName });
    tick();
  }).catch(() => {
    disconnected = true; updateStatus("Refresh this room", "Extension context unavailable.");
  });
  // Heartbeat also detects a stalled adapter, and keeps MV3 alive while reading.
  setInterval(tick, 200);
})();
