/* Safari previews speak in this popup so its click supplies audio permission. */
(() => {
  "use strict";
  const engine = ProtoVoiceSpeech.createEngine();
  let token = null;
  let timeout = null;
  const relay = message => chrome.runtime.sendMessage(message);
  function finish(expected = token) {
    if (expected == null || expected !== token) return;
    clearTimeout(timeout);
    const previous = token;
    token = null;
    engine.stop();
    void relay({ type: "end-preview", token: previous }).catch(() => {});
  }
  function send(message) {
    if (message.type === "voices") return Promise.resolve({ voices: ProtoVoiceSpeech.voices() });
    if (message.type === "stop-preview") { finish(); return Promise.resolve({ ok: true }); }
    if (message.type !== "preview") return relay(message);
    finish();
    const current = Math.random().toString(36).slice(2);
    token = current;
    // Start before awaiting a message: awaiting would lose Safari's gesture.
    void relay({ type: "begin-preview", token: current }).then(result => {
      if (!result?.ok) finish(current);
    }, () => finish(current));
    const result = engine.speak({ ...ProtoVoice.settings(message.settings),
      text: "Welcome to ProtoBowl. Listen closely, and buzz when you know the answer." }, event => {
      if (["end", "error", "interrupted", "cancelled"].includes(event.type)) finish(current);
    });
    if (!result.ok) finish(current);
    else timeout = setTimeout(() => finish(current), 8000);
    return Promise.resolve(result);
  }
  window.addEventListener("pagehide", () => finish());
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) finish();
  });
  const onVoicesChanged = listener => globalThis.speechSynthesis?.addEventListener("voiceschanged", listener);
  globalThis.ProtoVoicePopupTransport = { send, onVoicesChanged };
})();
