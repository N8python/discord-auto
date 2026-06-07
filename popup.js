const DEFAULT_SETTINGS = {
  enabled: true,
  mappingEnabled: true,
  sourceLanguage: "Spanish",
  targetLanguage: "English",
  concurrency: 4,
  lmStudioUrl: "http://127.0.0.1:1234",
  model: "google/gemma-4-26b-a4b"
};

const SAVE_DELAY_MS = 350;
const DISCORD_URL_PATTERN = /^https:\/\/([a-z]+\.)?discord(app)?\.com\//i;

const controls = {
  enabled: document.getElementById("enabled"),
  sourceLanguage: document.getElementById("sourceLanguage"),
  targetLanguage: document.getElementById("targetLanguage"),
  concurrency: document.getElementById("concurrency"),
  lmStudioUrl: document.getElementById("lmStudioUrl"),
  model: document.getElementById("model"),
  status: document.getElementById("status")
};

let saveTimer = null;

function setStatus(text) {
  controls.status.textContent = text;
}

function enabledFromSettings(settings) {
  return settings.enabled !== false && settings.mappingEnabled !== false;
}

function canonicalLanguageName(value) {
  const language = (value || "").trim().toLowerCase();
  const compact = language.replace(/[\s_-]+/g, "");
  const aliases = {
    en: "english",
    eng: "english",
    english: "english",
    zh: "chinese",
    zhhans: "chinese",
    zhhant: "chinese",
    chinese: "chinese",
    mandarin: "chinese",
    cn: "chinese",
    es: "spanish",
    spa: "spanish",
    spanish: "spanish",
    espanol: "spanish",
    español: "spanish",
    ja: "japanese",
    jp: "japanese",
    jpn: "japanese",
    japanese: "japanese",
    ko: "korean",
    kor: "korean",
    korean: "korean",
    fr: "french",
    fra: "french",
    fre: "french",
    french: "french",
    de: "german",
    deu: "german",
    ger: "german",
    german: "german",
    pt: "portuguese",
    por: "portuguese",
    portuguese: "portuguese",
    ru: "russian",
    rus: "russian",
    russian: "russian"
  };
  return aliases[compact] || language;
}

function sourceMatchesTarget(settings) {
  return Boolean(settings.sourceLanguage &&
    settings.targetLanguage &&
    canonicalLanguageName(settings.sourceLanguage) === canonicalLanguageName(settings.targetLanguage));
}

function effectiveEnabled(settings) {
  return enabledFromSettings(settings) && !sourceMatchesTarget(settings);
}

function statusForSettings(settings) {
  if (!enabledFromSettings(settings)) {
    return "Disabled";
  }
  if (sourceMatchesTarget(settings)) {
    return "Paused: source and target match";
  }
  return "Enabled";
}

function normalizeSettings(settings) {
  const nextSettings = { ...settings };
  if (canonicalLanguageName(nextSettings.targetLanguage) === "english") {
    nextSettings.targetLanguage = "English";
  }
  return nextSettings;
}

function readForm() {
  const enabled = controls.enabled.checked;
  return {
    enabled,
    mappingEnabled: enabled,
    sourceLanguage: controls.sourceLanguage.value.trim() || DEFAULT_SETTINGS.sourceLanguage,
    targetLanguage: controls.targetLanguage.value.trim() || DEFAULT_SETTINGS.targetLanguage,
    concurrency: Math.max(1, Math.min(12, Number(controls.concurrency.value) || DEFAULT_SETTINGS.concurrency)),
    lmStudioUrl: controls.lmStudioUrl.value.trim() || DEFAULT_SETTINGS.lmStudioUrl,
    model: controls.model.value.trim() || DEFAULT_SETTINGS.model
  };
}

function writeForm(settings) {
  controls.enabled.checked = enabledFromSettings(settings);
  controls.sourceLanguage.value = settings.sourceLanguage || DEFAULT_SETTINGS.sourceLanguage;
  controls.targetLanguage.value = settings.targetLanguage || DEFAULT_SETTINGS.targetLanguage;
  controls.concurrency.value = settings.concurrency || DEFAULT_SETTINGS.concurrency;
  controls.lmStudioUrl.value = settings.lmStudioUrl || DEFAULT_SETTINGS.lmStudioUrl;
  controls.model.value = settings.model || DEFAULT_SETTINGS.model;
}

async function activeDiscordTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !DISCORD_URL_PATTERN.test(tab.url || "")) {
    return null;
  }
  return tab;
}

async function wakeActiveDiscordTab() {
  const tab = await activeDiscordTab();
  if (!tab) {
    return false;
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["page-bridge.js"],
      world: "MAIN"
    });
  } catch (_error) {}

  try {
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ["content.css"]
    });
  } catch (_error) {}

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
    return true;
  } catch (_error) {
    return false;
  }
}

async function saveSettings() {
  const settings = readForm();
  await chrome.storage.local.set(settings);
  if (effectiveEnabled(settings)) {
    await wakeActiveDiscordTab();
  }
  setStatus(statusForSettings(settings));
  return settings;
}

function scheduleSave() {
  window.clearTimeout(saveTimer);
  setStatus("Saving");
  saveTimer = window.setTimeout(() => {
    saveSettings().catch((error) => setStatus(error.message || String(error)));
  }, SAVE_DELAY_MS);
}

document.addEventListener("DOMContentLoaded", async () => {
  try {
    const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
    const settings = normalizeSettings(stored);
    if (settings.targetLanguage !== stored.targetLanguage) {
      await chrome.storage.local.set({ targetLanguage: settings.targetLanguage });
    }
    writeForm(settings);
    setStatus(statusForSettings(settings));
    if (effectiveEnabled(settings)) {
      wakeActiveDiscordTab().catch(() => {});
    }
  } catch (error) {
    setStatus(error.message || String(error));
  }
});

controls.enabled.addEventListener("change", () => {
  window.clearTimeout(saveTimer);
  saveSettings().catch((error) => setStatus(error.message || String(error)));
});

[
  controls.sourceLanguage,
  controls.targetLanguage,
  controls.concurrency,
  controls.lmStudioUrl,
  controls.model
].forEach((control) => {
  control.addEventListener("input", scheduleSave);
  control.addEventListener("change", scheduleSave);
});
