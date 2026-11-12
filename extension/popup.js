"use strict";

// Keep this UI independent of the page: playback is owned by the service worker.
const DEFAULTS = { enabled: true, voiceName: "", rate: 1, volume: 1, leadMs: 80 };
const $ = (id) => document.getElementById(id);
let settings = { ...DEFAULTS };
let previewing = false;
let previewTimer;
let saveTimer;
let statusRequest = false;

function error(message = "") {
  $("error").textContent = message;
  $("error").hidden = !message;
}

function paintValues() {
  $("enabled").checked = settings.enabled;
  $("rate").value = settings.rate;
  $("volume").value = settings.volume;
  $("lead").value = settings.leadMs;
  $("rate-value").textContent = `${Number(settings.rate).toFixed(2)}×`;
  $("volume-value").textContent = `${Math.round(settings.volume * 100)}%`;
  $("lead-value").textContent = settings.leadMs === 0 ? "No adjustment" : `${Math.abs(settings.leadMs)} ms ${settings.leadMs > 0 ? "earlier" : "later"}`;
  $("rate").setAttribute("aria-valuetext", `${Number(settings.rate).toFixed(2)} times speed`);
  $("volume").setAttribute("aria-valuetext", `${Math.round(settings.volume * 100)} percent`);
  $("lead").setAttribute("aria-valuetext", $("lead-value").textContent);
}

async function save() {
  clearTimeout(saveTimer);
  try {
    await chrome.storage.local.set({ settings: { ...settings } });
    error();
    await refreshStatus();
  } catch (cause) {
    error(`Could not save settings. ${cause.message || "Try reopening the extension."}`);
  }
}

function setPreviewing(value) {
  previewing = value;
  $("preview-label").textContent = value ? "Stop" : "Test";
  $("preview").setAttribute("aria-label", value ? "Stop voice preview" : "Test selected voice");
  $("preview").title = value ? "Stop voice preview" : "Test selected voice";
  $("preview-icon").style.opacity = value ? ".45" : "1";
}

async function preview() {
  clearTimeout(previewTimer);
  const stop = previewing;
  $("preview").disabled = true;
  try {
    const result = await chrome.runtime.sendMessage(stop ? { type: "stop-preview" } : { type: "preview", settings: { ...settings } });
    if (result?.ok === false || result?.error) throw new Error(result.error || "The selected voice is unavailable.");
    error();
    setPreviewing(!stop);
    // The worker owns the utterance and it may finish after this popup closes.
    if (!stop) previewTimer = setTimeout(() => setPreviewing(false), 6500);
  } catch (cause) {
    setPreviewing(false);
    error(`Voice preview failed. ${cause.message || "Choose a different voice and try again."}`);
  } finally {
    $("preview").disabled = false;
  }
}

const STATUS_LABELS = {
  reading: "Reading with the question",
  speaking: "Reading with the question",
  waiting: "Ready for the next question",
  ready: "Ready for the next question",
  paused: "Paused with the room",
  buzzing: "Waiting for the answer",
  disabled: "Read along is off",
  idle: "Open a ProtoBowl room to begin",
  "no-room": "Open a ProtoBowl room to begin",
  disconnected: "Open a ProtoBowl room to begin",
  unavailable: "Waiting for a ProtoBowl question",
  preview: "Previewing your voice",
  hidden: "Switch to your ProtoBowl tab to listen",
  error: "Speech needs attention"
};

async function refreshStatus() {
  if (statusRequest) return;
  statusRequest = true;
  try {
    const state = await chrome.runtime.sendMessage({ type: "status" });
    const raw = state?.status || "idle";
    const key = settings.enabled ? raw.toLowerCase() : "disabled";
    $("status-text").textContent = STATUS_LABELS[key] || raw;
    $("status-text").title = state?.detail || "";
    $("status-dot").className = `status-dot${["reading", "speaking", "ready", "waiting", "preview"].includes(key) ? " active" : key === "error" ? " error" : ""}`;
  } catch {
    $("status-text").textContent = settings.enabled ? "Reopen the extension to reconnect" : "Read along is off";
    $("status-dot").className = "status-dot";
  } finally {
    statusRequest = false;
  }
}

async function loadVoices() {
  const response = await chrome.runtime.sendMessage({ type: "voices" });
  if (response?.error) throw new Error(response.error);
  const voices = (response?.voices || []).filter((voice) => typeof voice.voiceName === "string");
  const names = new Set();
  voices.sort((a, b) => {
    const english = Number(/^en/i.test(b.lang || "")) - Number(/^en/i.test(a.lang || ""));
    return english || a.voiceName.localeCompare(b.voiceName);
  });
  for (const voice of voices) {
    if (names.has(voice.voiceName)) continue;
    names.add(voice.voiceName);
    const option = document.createElement("option");
    option.value = voice.voiceName;
    option.textContent = `${voice.voiceName}${voice.lang ? ` · ${voice.lang}` : ""}${voice.remote ? " · online" : ""}`;
    $("voice").append(option);
  }
  if (settings.voiceName && !names.has(settings.voiceName)) {
    const option = document.createElement("option");
    option.value = settings.voiceName;
    option.textContent = `${settings.voiceName} · unavailable`;
    $("voice").append(option);
  }
  $("voice").value = settings.voiceName;
}

async function initialize() {
  try {
    const stored = await chrome.storage.local.get("settings");
    settings = { ...DEFAULTS, ...(stored.settings || {}) };
    paintValues();
    await Promise.all([loadVoices(), refreshStatus()]);
  } catch (cause) {
    paintValues();
    error(`Could not load all speech settings. ${cause.message || "Try reopening the extension."}`);
  }

  $("enabled").addEventListener("change", () => {
    settings.enabled = $("enabled").checked;
    save();
  });
  $("voice").addEventListener("change", () => {
    settings.voiceName = $("voice").value;
    save();
  });
  for (const [id, key] of [["rate", "rate"], ["lead", "leadMs"], ["volume", "volume"]]) {
    $(id).addEventListener("input", () => {
      settings[key] = Number($(id).value);
      paintValues();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, 100);
    });
    $(id).addEventListener("change", save);
  }
  $("preview").addEventListener("click", preview);
  setInterval(refreshStatus, 1000);
}

initialize();
