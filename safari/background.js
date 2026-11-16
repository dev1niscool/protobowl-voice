/* Safari's background coordinates tabs; speech runs in visible documents. */
"use strict";
const statuses = new Map();
let owner = null;
let preview = null;
const send = (tabId, message) => chrome.tabs.sendMessage(tabId, message).catch(() => {});
function isRoom(sender) {
  if (!sender.tab || (sender.frameId != null && sender.frameId !== 0)) return false;
  try {
    const url = new URL(sender.url);
    return /^https?:$/.test(url.protocol) && (url.hostname === "protobowl.com" || url.hostname.endsWith(".protobowl.com"));
  } catch { return false; }
}
function stopOwner() {
  const previous = owner;
  owner = null;
  if (previous) void send(previous.tabId, { type: "stop-speech" });
}
function endPreview(token) {
  if (!preview || (token != null && token !== preview.token)) return;
  preview = null;
  for (const tabId of statuses.keys()) void send(tabId, { type: "preview-end" });
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!message || typeof message.type !== "string") return;
  const room = isRoom(sender);
  const popup = sender.url === chrome.runtime.getURL("popup.html");
  if (preview && Date.now() >= preview.until) endPreview();
  if (message.type === "claim-speech" && room) {
    if (typeof message.id !== "string" || message.id.length > 500) { reply({ ok: false }); return; }
    if (preview) { reply({ ok: false, busy: true }); return; }
    if (owner && owner.tabId !== sender.tab.id) stopOwner();
    owner = { tabId: sender.tab.id, id: message.id };
    reply({ ok: true });
  }
  if (message.type === "release-speech" && room) {
    if (owner?.tabId === sender.tab.id && owner.id === message.id) owner = null;
    reply({ ok: true });
  }
  if (message.type === "report-status" && room) {
    statuses.set(sender.tab.id, { status: String(message.status).slice(0, 100), detail: String(message.detail || "").slice(0, 240),
      voiceName: typeof message.voiceName === "string" ? message.voiceName.slice(0, 200) : "",
      lagMs: Number.isFinite(message.lagMs) ? message.lagMs : undefined });
    reply({ ok: true });
  }
  if (message.type === "status" && popup) {
    chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => reply(statuses.get(tabs[0]?.id) || {
      status: "Open a ProtoBowl room", detail: "Refresh existing rooms, then click Voice in the room to start Safari audio."
    }), () => reply({ status: "Open a ProtoBowl room" }));
    return true;
  }
  if (message.type === "begin-preview" && popup) {
    if (typeof message.token !== "string" || message.token.length > 100) { reply({ ok: false }); return; }
    stopOwner();
    preview = { token: message.token, until: Date.now() + 8000 };
    for (const tabId of statuses.keys()) void send(tabId, { type: "preview-start" });
    reply({ ok: true });
  }
  if (message.type === "end-preview" && popup) { endPreview(message.token); reply({ ok: true }); }
});
chrome.tabs.onRemoved.addListener(tabId => {
  statuses.delete(tabId);
  if (owner?.tabId === tabId) owner = null;
});
chrome.tabs.onActivated.addListener(({ tabId }) => { if (owner && owner.tabId !== tabId) stopOwner(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) { stopOwner(); endPreview(); }
});
