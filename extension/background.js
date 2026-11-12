importScripts("core.js");
"use strict";

let current = null;
let serial = 0;
let previewUntil = 0;
let previewTab = null;
let voicesCache = null;
const statuses = new Map();
const isRoom = sender => sender.tab && /^https?:\/\/([\w-]+\.)?protobowl\.com\//.test(sender.url || "");
const getVoices = () => new Promise(resolve => chrome.tts.getVoices(resolve));
const send = (tabId, message) => chrome.tabs.sendMessage(tabId, message).catch(() => {});

function endPreview() {
  previewUntil = 0;
  if (previewTab != null) send(previewTab, { type: "preview-end" });
  previewTab = null;
}

function stop(tabId) {
  if (tabId != null && current?.tabId !== tabId) return;
  serial++;
  const previous = current;
  current = null;
  if (previous) chrome.tts.stop();
}

async function speak(message, tabId, preview = false) {
  if (!preview && Date.now() < previewUntil) return { ok: false, busy: true };
  if (typeof message.text !== "string" || !message.text.trim() || message.text.length > 500) return { ok: false, error: "Invalid speech text" };
  stop();
  const generation = ++serial;
  current = { tabId, id: message.id, generation };
  const voices = voicesCache || (voicesCache = await getVoices());
  if (generation !== serial) return { ok: false, busy: true };
  const voice = ProtoVoice.chooseVoice(voices, message.voiceName);
  if (!voice) { current = null; endPreview(); return { ok: false, error: "No speech voices found. Install an English voice in your system settings." }; }
  const notify = event => {
    if (generation !== serial) return;
    if (tabId != null) send(tabId, { type: "speech-event", id: message.id, event });
    if (["end", "error", "interrupted", "cancelled"].includes(event.type)) {
      current = null;
      if (preview) endPreview();
    }
  };
  const options = {
    voiceName: voice.voiceName, lang: voice.lang || "en-US",
    rate: ProtoVoice.clamp(Number(message.rate) || 1, .6, 3.5),
    volume: ProtoVoice.clamp(Number.isFinite(message.volume) ? message.volume : 1, 0, 1),
    pitch: 1, enqueue: false,
    onEvent: event => notify({ type: event.type, charIndex: event.charIndex, errorMessage: event.errorMessage })
  };
  if (voice.extensionId) options.extensionId = voice.extensionId;
  return new Promise(resolve => {
    chrome.tts.speak(message.text, options, () => {
      const error = chrome.runtime.lastError?.message;
      if (error) { notify({ type: "error", errorMessage: error }); resolve({ ok: false, error }); }
      else resolve({ ok: true, voiceName: voice.voiceName, events: voice.eventTypes || [] });
    });
  });
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!message || typeof message.type !== "string") return;
  const room = isRoom(sender);
  // Popup-only actions cannot be triggered through arbitrary page messages.
  const popup = sender.url === chrome.runtime.getURL("popup.html");
  if (message.type === "speak" && room) {
    speak(message, sender.tab.id).then(reply, e => reply({ ok: false, error: e.message })); return true;
  }
  if (message.type === "warmup" && room) {
    if (!current && Date.now() >= previewUntil) {
      speak({ id: "warmup", text: "Ready.", voiceName: message.voiceName, rate: 1, volume: 0 }, sender.tab.id).then(reply, () => reply({ ok: false }));
      return true;
    }
    reply({ ok: false, busy: true });
  }
  if (message.type === "stop" && room) { stop(sender.tab.id); reply({ ok: true }); }
  if (message.type === "report-status" && room) {
    statuses.set(sender.tab.id, { status: String(message.status).slice(0, 100), detail: String(message.detail || "").slice(0, 240), voiceName: message.voiceName, lagMs: message.lagMs });
    reply({ ok: true });
  }
  if (message.type === "voices" && popup) { getVoices().then(voices => { voicesCache = voices; reply({ voices }); }); return true; }
  if (message.type === "status" && popup) {
    chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => reply(statuses.get(tabs[0]?.id) || { status: "Open a ProtoBowl room", detail: "Refresh existing rooms after installing the extension." })); return true;
  }
  if (message.type === "preview" && popup) {
    const prefs = ProtoVoice.settings(message.settings);
    previewTab = current?.tabId ?? previewTab;
    if (previewTab != null) send(previewTab, { type: "preview-start" });
    previewUntil = Date.now() + 8000;
    speak({ ...prefs, id: "preview", text: "Welcome to ProtoBowl. Listen closely, and buzz when you know the answer." }, null, true).then(reply, e => reply({ ok: false, error: e.message })); return true;
  }
  if (message.type === "stop-preview" && popup) { if (current?.tabId == null) stop(); endPreview(); reply({ ok: true }); }
});
chrome.tabs.onRemoved.addListener(tabId => { stop(tabId); statuses.delete(tabId); });
chrome.tabs.onActivated.addListener(({ tabId }) => { if (current && current.tabId != null && current.tabId !== tabId) stop(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) { stop(); endPreview(); }
});
