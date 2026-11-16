/* Safari speech stays in the visible document; no native helper or network. */
(() => {
  "use strict";
  const C = ProtoVoice;
  const synth = globalThis.speechSynthesis;
  const supported = !!synth && typeof globalThis.SpeechSynthesisUtterance === "function";
  function voices() {
    if (!supported) return [];
    return synth.getVoices().map(voice => ({
      voiceName: voice.name, lang: voice.lang, remote: !voice.localService,
      eventTypes: ["start", "word", "end", "error"]
    }));
  }
  function createEngine() {
    let current = null;
    let serial = 0;
    function stop() {
      serial++;
      if (!current) return;
      current = null; // Discard cancellation callbacks before calling the engine.
      synth.cancel();
    }
    function speak(message, notify = () => {}) {
      const limit = message.naturalFlow === true ? C.MAX_SENTENCE_LENGTH : 500;
      if (typeof message.text !== "string" || !message.text.trim() || message.text.length > limit) {
        return { ok: false, error: "Invalid speech text" };
      }
      if (!supported) return { ok: false, error: "Speech synthesis is unavailable in this browser." };
      stop();
      const generation = ++serial;
      const available = synth.getVoices();
      const selected = C.chooseVoice(voices(), message.voiceName);
      const voice = available.find(item => item.name === selected?.voiceName);
      const utterance = new SpeechSynthesisUtterance(message.text);
      // An empty initial voice list is valid in Web Speech. The default system
      // voice can speak while Safari finishes populating the selectable list.
      if (voice) utterance.voice = voice;
      utterance.lang = voice?.lang || "en-US";
      utterance.rate = C.clamp(Number(message.rate) || 1, .6, 3.5);
      utterance.volume = C.clamp(Number.isFinite(message.volume) ? message.volume : 1, 0, 1);
      utterance.pitch = 1;
      const emit = event => {
        if (generation !== serial || current?.utterance !== utterance) return;
        if (["end", "error", "interrupted", "cancelled"].includes(event.type)) current = null;
        notify(event);
      };
      utterance.onstart = () => emit({ type: "start" });
      utterance.onboundary = event => {
        if (event.name === "word" && Number.isFinite(event.charIndex)) emit({ type: "word", charIndex: event.charIndex });
      };
      utterance.onend = () => emit({ type: "end" });
      utterance.onerror = event => {
        const type = event.error === "interrupted" ? "interrupted" : event.error === "canceled" ? "cancelled" : "error";
        emit({ type, errorMessage: event.error === "not-allowed"
          ? "Click Voice in the room to allow Safari audio." : String(event.error || "The selected voice could not speak."), code: event.error });
      };
      current = { utterance, generation }; // Keep the utterance alive until its final event.
      try {
        synth.speak(utterance);
        return { ok: true, voiceName: voice?.name || "System default", events: ["start", "word", "end", "error"] };
      } catch (error) {
        current = null;
        serial++;
        return { ok: false, error: error.message || "The selected voice could not speak." };
      }
    }
    return { speak, stop, isSpeaking: () => !!current };
  }
  globalThis.ProtoVoiceSpeech = { createEngine, voices };

  // The popup uses its own gesture-driven preview transport. Only room content
  // scripts install this adapter, and no page-world globals are exposed.
  if (!/^https?:$/.test(location.protocol)) return;
  const engine = createEngine();
  const listeners = new Set();
  let unlocked = false;
  let generation = 0;
  let activeId = null;
  let previewUntil = 0;
  const emit = message => listeners.forEach(listener => listener(message));
  const relay = message => chrome.runtime.sendMessage(message);
  function stop() {
    generation++;
    const id = activeId;
    activeId = null;
    engine.stop();
    if (id != null) void relay({ type: "release-speech", id }).catch(() => {});
  }
  function unlock() {
    // Called directly from the room's Voice button while the user gesture is
    // active. The next real utterance replaces this silent, unqueued warmup.
    const result = engine.speak({ text: "Ready.", rate: 1, volume: 0 }, event => {
      if (event.code === "not-allowed") unlocked = false;
    });
    unlocked = result.ok;
    return unlocked;
  }
  async function send(message) {
    if (message.type === "stop") { stop(); return { ok: true }; }
    if (message.type === "warmup") return { ok: unlocked, gestureRequired: !unlocked };
    if (message.type !== "speak") return relay(message);
    if (!unlocked) return { ok: false, gestureRequired: true, error: "Click Voice in the room to allow Safari audio." };
    if (document.hidden || Date.now() < previewUntil) return { ok: false, busy: true };
    const run = ++generation;
    const permission = await relay({ type: "claim-speech", id: message.id });
    if (run !== generation || document.hidden || Date.now() < previewUntil) {
      void relay({ type: "release-speech", id: message.id }).catch(() => {});
      return { ok: false, busy: true };
    }
    if (!permission?.ok) return permission || { ok: false, busy: true };
    activeId = message.id;
    const result = engine.speak(message, event => {
      if (run !== generation) return;
      if (event.code === "not-allowed") unlocked = false;
      if (["end", "error", "interrupted", "cancelled"].includes(event.type)) {
        activeId = null;
        void relay({ type: "release-speech", id: message.id }).catch(() => {});
      }
      emit({ type: "speech-event", id: message.id, event });
    });
    if (!result.ok) {
      activeId = null;
      void relay({ type: "release-speech", id: message.id }).catch(() => {});
    }
    return result;
  }
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === "preview-start") { previewUntil = Date.now() + 8000; stop(); }
    if (message?.type === "preview-end") previewUntil = 0;
    if (message?.type === "stop-speech") {
      const id = activeId;
      stop();
      if (id != null) emit({ type: "speech-event", id, event: { type: "interrupted" } });
      return;
    }
    emit(message);
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) stop(); });
  window.addEventListener("pagehide", stop);
  globalThis.ProtoVoiceTransport = { send, onMessage: listener => listeners.add(listener), unlock, requiresGesture: () => !unlocked };
})();
