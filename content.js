(() => {
  const SCRIPT_VERSION = "0.23.0";

  if (window.__discordAutoTranslateLoaded === SCRIPT_VERSION) {
    return;
  }
  window.__discordAutoTranslateLoaded = SCRIPT_VERSION;

  const DEFAULT_SETTINGS = {
    enabled: true,
    mappingEnabled: true,
    sourceLanguage: "Spanish",
    targetLanguage: "English",
    concurrency: 4,
    lmStudioUrl: "http://127.0.0.1:1234",
    model: "google/gemma-4-26b-a4b"
  };

  const SETTING_KEYS = new Set(Object.keys(DEFAULT_SETTINGS));
  const CACHE_STORAGE_KEY = "translationCacheV1";
  const MAX_PERSISTENT_CACHE_BYTES = 1024 * 1024 * 1024;
  const CACHE_SAVE_DELAY_MS = 750;
  const RECENT_OUTBOUND_LIMIT = 50;
  const RECENT_OUTBOUND_TTL_MS = 5 * 60 * 1000;
  const PAGE_BRIDGE_SOURCE = "discord-auto-translate";
  const NO_NEED_TAG = "<no_need_to_translate />";
  const MESSAGE_SELECTORS = [
    '[id^="message-content-"]',
    '[data-list-item-id^="chat-messages"] [class*="markup"]',
    '[data-list-item-id^="chat-messages"] [class*="messageContent"]',
    '[id^="message-accessories-"] [class*="embedTitle"]',
    '[id^="message-accessories-"] [class*="embedDescription"]',
    '[id^="message-accessories-"] [class*="embedFieldName"]',
    '[id^="message-accessories-"] [class*="embedFieldValue"]',
    '[id^="message-accessories-"] [class*="blockquote"]',
    '[data-list-item-id^="chat-messages"] blockquote',
    '[data-list-item-id^="chat-messages"] [class*="repliedTextContent"]',
    'h3[class*="title"][data-text-variant] span',
    'h3[class*="title"][data-text-variant]',
    '[class*="postTitleText"] span',
    '[class*="postTitleText"]',
    '[aria-label*="Channel header" i] [class*="topic"]',
    '[class*="chat"] [class*="topic"]'
  ];
  const CHANNEL_SELECTORS = [
    '[aria-label*="Channel header" i] h1',
    'section[aria-label*="Channel" i] h1',
    '[class*="chat"] [class*="title"] h1',
    '[data-list-item-id^="channels___"] [class*="name"]',
    '[data-list-item-id^="channels___"] [class*="channelName"]',
    '[data-list-item-id^="channels___"]',
    '[data-dnd-name]',
    'a[href*="/channels/"] [class*="name"]',
    'a[href*="/channels/"] [class*="channelName"]'
  ];
  const UI_SELECTORS = [
    '[class*="bar"] [class*="title"] [class*="defaultColor"]',
    '[class*="guildBadgeAndName"] [class*="name"]',
    '[class*="headerContent"] [class*="name"]',
    '[class*="search"] .public-DraftEditorPlaceholder-inner',
    '.public-DraftEditorPlaceholder-inner',
    '[class*="placeholder"][class*="slateTextArea"]'
  ];
  const LEGACY_RENDER_SELECTOR = [
    ".dat-message-translation",
    ".dat-message-status",
    ".dat-message-error",
    ".dat-channel-translation",
    ".dat-channel-status",
    ".dat-channel-error"
  ].join(", ");
  const STATUS_CLASSES = [
    "dat-translated",
    "dat-translation-pending",
    "dat-translation-error"
  ];
  const FALLBACK_TEXT_SELECTOR = [
    '[class*="markup"]',
    '[class*="messageContent"]',
    '[class*="embed"] div',
    '[class*="contents"] div',
    "blockquote",
    "h1",
    "h2",
    "h3",
    "span",
    "div"
  ].join(", ");
  const BAD_TRANSLATION_PATTERNS = [
    /^please provide\b/i,
    /^provide\b/i,
    /^i need\b/i,
    /^there is no text\b/i,
    /^no text\b/i,
    /^the text to translate\b/i
  ];
  let settings = { ...DEFAULT_SETTINGS };
  let queue = [];
  let activeRequests = 0;
  let runId = 0;
  let scanTimer = null;
  let cacheSaveTimer = null;
  let translationCache = new Map();
  let nodeState = new WeakMap();
  let touchedNodes = new Set();
  let textEncoder = new TextEncoder();
  let recentOutboundMappings = [];
  let currentChatContext = discordChatContextKey();

  function cacheKey(text, targetLanguage) {
    return [
      targetLanguage,
      settings.sourceLanguage || "",
      settings.model || "",
      settings.lmStudioUrl || "",
      text
    ].join("\n");
  }

  function canonicalLanguageName(value) {
    const language = cleanText(value).toLowerCase();
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

  function sameLanguage(left, right) {
    return Boolean(left && right && canonicalLanguageName(left) === canonicalLanguageName(right));
  }

  function isTranslationActive() {
    return Boolean(settings.enabled &&
      settings.mappingEnabled &&
      !sameLanguage(settings.sourceLanguage, settings.targetLanguage));
  }

  function discordChatContextKey() {
    const match = window.location.pathname.match(/^\/channels\/([^/]+)\/([^/]+)/);
    if (!match) {
      return window.location.pathname;
    }
    return `${match[1]}/${match[2]}`;
  }

  function resetChatScopedState() {
    runId += 1;
    queue = [];
    recentOutboundMappings = [];
    pruneTransientCacheEntries();
    touchedNodes.forEach((element) => {
      const state = nodeState.get(element);
      if (state?.status === "pending") {
        clearStatus(element, state);
        state.status = "idle";
        state.targetLanguage = null;
      }
    });
  }

  function checkChatContext() {
    const nextContext = discordChatContextKey();
    if (nextContext === currentChatContext) {
      return false;
    }

    currentChatContext = nextContext;
    resetChatScopedState();
    return true;
  }

  function storageGet(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  }

  function storageSet(values) {
    return new Promise((resolve) => chrome.storage.local.set(values, resolve));
  }

  function storageRemove(keys) {
    return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
  }

  function loadPersistentCache() {
    return storageGet({ [CACHE_STORAGE_KEY]: { version: 1, entries: [] } }).then((stored) => {
      const cache = stored[CACHE_STORAGE_KEY];
      if (!cache || !Array.isArray(cache.entries)) {
        return;
      }

      cache.entries.forEach((entry) => {
        const [key, translation, savedAt] = entry;
        if (typeof key !== "string" || typeof translation !== "string" || translationCache.has(key)) {
          return;
        }
        translationCache.set(key, {
          status: "done",
          translation,
          savedAt: Number(savedAt) || Date.now()
        });
      });
    });
  }

  function persistentCachePayload() {
    const candidates = [...translationCache.entries()]
      .filter(([, value]) => value?.status === "done" && typeof value.translation === "string")
      .sort((a, b) => (b[1].savedAt || 0) - (a[1].savedAt || 0));
    const entries = [];
    let totalBytes = 0;

    for (const [key, value] of candidates) {
      const nextBytes = textEncoder.encode(key).byteLength + textEncoder.encode(value.translation).byteLength + 32;
      if (totalBytes + nextBytes > MAX_PERSISTENT_CACHE_BYTES) {
        break;
      }
      entries.push([key, value.translation, value.savedAt || Date.now()]);
      totalBytes += nextBytes;
    }

    return {
      version: 1,
      savedAt: Date.now(),
      maxBytes: MAX_PERSISTENT_CACHE_BYTES,
      estimatedBytes: totalBytes,
      entries
    };
  }

  function savePersistentCache() {
    return storageSet({ [CACHE_STORAGE_KEY]: persistentCachePayload() });
  }

  function scheduleCacheSave() {
    window.clearTimeout(cacheSaveTimer);
    cacheSaveTimer = window.setTimeout(() => {
      savePersistentCache().catch(() => {});
    }, CACHE_SAVE_DELAY_MS);
  }

  function addPersistentCacheEntry(originalText, translatedText) {
    const original = cleanText(originalText);
    const translated = cleanText(translatedText);
    if (!original || !translated || isBadTranslation(translated)) {
      return;
    }

    translationCache.set(cacheKey(original, settings.targetLanguage), {
      status: "done",
      translation: translated,
      savedAt: Date.now()
    });
    scheduleCacheSave();
  }

  function pruneRecentOutboundMappings() {
    const cutoff = Date.now() - RECENT_OUTBOUND_TTL_MS;
    recentOutboundMappings = recentOutboundMappings
      .filter((entry) => entry.savedAt >= cutoff &&
        entry.targetLanguage === settings.targetLanguage &&
        entry.sourceLanguage === settings.sourceLanguage)
      .slice(-RECENT_OUTBOUND_LIMIT);
  }

  function rememberRecentOutboundMapping(translatedText, originalText) {
    const translated = cleanText(translatedText);
    const original = cleanText(originalText);
    const normalizedTranslated = normalizeOutboundComparableText(translated);
    if (!translated || !original || !normalizedTranslated) {
      return;
    }

    pruneRecentOutboundMappings();
    recentOutboundMappings = recentOutboundMappings.filter((entry) => entry.normalizedTranslated !== normalizedTranslated);
    recentOutboundMappings.push({
      translatedText: translated,
      originalText: original,
      normalizedTranslated,
      targetLanguage: settings.targetLanguage,
      sourceLanguage: settings.sourceLanguage,
      savedAt: Date.now()
    });
    if (recentOutboundMappings.length > RECENT_OUTBOUND_LIMIT) {
      recentOutboundMappings = recentOutboundMappings.slice(-RECENT_OUTBOUND_LIMIT);
    }
  }

  function findRecentOutboundMapping(text) {
    const normalized = normalizeOutboundComparableText(text);
    if (!normalized) {
      return null;
    }

    pruneRecentOutboundMappings();
    return [...recentOutboundMappings]
      .reverse()
      .find((entry) => entry.normalizedTranslated === normalized) || null;
  }

  function addOutboundReverseMapping(translatedText, originalText) {
    addPersistentCacheEntry(translatedText, originalText);
    rememberRecentOutboundMapping(translatedText, originalText);
  }

  function renderRecentOutboundMapping(element, kind, text, targetLanguage) {
    if (kind !== "message") {
      return false;
    }

    const mapping = findRecentOutboundMapping(text);
    if (!mapping) {
      return false;
    }

    addPersistentCacheEntry(text, mapping.originalText);
    renderTranslation(element, kind, mapping.originalText, text, targetLanguage);
    return true;
  }

  function pruneTransientCacheEntries() {
    [...translationCache.entries()].forEach(([key, value]) => {
      if (value?.status !== "done") {
        translationCache.delete(key);
      }
    });
  }

  function clearCompletedCacheEntries() {
    [...translationCache.entries()].forEach(([key, value]) => {
      if (value?.status === "done" || value?.status === "error") {
        translationCache.delete(key);
      }
    });
  }

  function clearPersistentCache() {
    clearCompletedCacheEntries();
    return storageRemove(CACHE_STORAGE_KEY);
  }

  function isVisible(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < viewportHeight && rect.left < viewportWidth;
  }

  function cleanText(text) {
    return (text || "")
      .replace(/\u200b/g, "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function normalizeOutboundComparableText(text) {
    return cleanText(text)
      .normalize("NFKC")
      .replace(/[\u200b-\u200f\ufeff]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function readElementText(element, { includeAria = true, stripIconText = true } = {}) {
    const clone = element.cloneNode(true);
    clone.querySelectorAll(LEGACY_RENDER_SELECTOR).forEach((node) => node.remove());
    if (stripIconText) {
      clone.querySelectorAll([
        "svg",
        "title",
        "desc",
        "img",
        "canvas",
        '[role="img"]',
        '[aria-hidden="true"]'
      ].join(", ")).forEach((node) => node.remove());
    }
    const text = cleanText(clone.textContent);
    return cleanText(text || (includeAria ? element.getAttribute("aria-label") : "") || "");
  }

  function readCandidateText(element, kind) {
    if (kind === "channel") {
      return readElementText(element, { includeAria: false, stripIconText: true });
    }
    return readElementText(element);
  }

  function looksUseful(text, kind) {
    if (!text || text.length < 2 || text.length > 3500) {
      return false;
    }
    if (text === NO_NEED_TAG || /^\s*[#@]?\s*$/.test(text)) {
      return false;
    }
    if (kind === "channel" && (text.length > 90 || /^https?:\/\//i.test(text))) {
      return false;
    }
    if (kind === "ui" && text.length > 260) {
      return false;
    }
    return true;
  }

  function isScreenReaderOnly(element) {
    return Boolean(element.closest('[class*="hiddenVisually"]'));
  }

  function hasVisibleTextChild(element) {
    return Array.from(element.children).some((child) => isVisible(child) && cleanText(child.textContent).length > 0);
  }

  function isPlaceholderElement(element) {
    return element.matches('.public-DraftEditorPlaceholder-inner, [class*="placeholder"][class*="slateTextArea"]');
  }

  function isMessageTextElement(element) {
    return element.matches([
      '[id^="message-content-"]',
      '[class*="messageContent"]',
      '[class*="markup"]',
      '[class*="repliedTextContent"]',
      '[class*="postTitleText"]',
      '[class*="postTitleText"] span',
      'h3[class*="title"][data-text-variant]',
      'h3[class*="title"][data-text-variant] span',
      "blockquote"
    ].join(", "));
  }

  function isEditableOrControl(element, kind) {
    if (element.closest("textarea, input, select, option")) {
      return true;
    }
    if (element.closest('[contenteditable="true"], [role="textbox"]') && !(kind === "ui" && isPlaceholderElement(element))) {
      return true;
    }
    if (!["channel", "ui"].includes(kind) && !(kind === "message" && isMessageTextElement(element)) && element.closest('button, [role="button"]')) {
      return true;
    }
    return false;
  }

  function isDiscordMetadata(element) {
    return Boolean(element.closest([
      '[class*="username"]',
      '[class*="userName"]',
      '[class*="userTag"]',
      '[class*="tagText"]',
      '[class*="userTitle"]',
      '[data-list-item-id^="members"]',
      '[class*="timestamp"]',
      '[class*="botTag"]',
      '[class*="avatar"]',
      '[class*="reaction"]',
      '[class*="replyAvatar"]',
      '[class*="executedCommand"]'
    ].join(", ")));
  }

  function canTranslateElement(element, kind) {
    if (!element || !isVisible(element) || isScreenReaderOnly(element) || isEditableOrControl(element, kind)) {
      return false;
    }
    if (isDiscordMetadata(element)) {
      return false;
    }
    return true;
  }

  function isBadTranslation(text) {
    const value = cleanText(text);
    return BAD_TRANSLATION_PATTERNS.some((pattern) => pattern.test(value));
  }

  function bestTextLeaf(element) {
    if (!element || !isVisible(element)) {
      return null;
    }

    const preferred = element.querySelector('[class*="name"], [class*="channelName"], h1, h2, span');
    if (preferred && canTranslateElement(preferred, "channel") && looksUseful(readCandidateText(preferred, "channel"), "channel")) {
      return preferred;
    }

    const leaves = Array.from(element.querySelectorAll("h1, h2, h3, span, div"))
      .filter((candidate) => canTranslateElement(candidate, "channel"))
      .filter((candidate) => !hasVisibleTextChild(candidate))
      .filter((candidate) => looksUseful(readCandidateText(candidate, "channel"), "channel"));
    return leaves[0] || null;
  }

  function normalizeChannelElement(element) {
    if (!element) {
      return null;
    }
    if (element.matches('[data-list-item-id^="channels___"], [data-dnd-name], a[href*="/channels/"]')) {
      return bestTextLeaf(element);
    }
    return element;
  }

  function uniqueVisibleElements(selectors, kind) {
    const seen = new Set();
    const result = [];

    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach((rawElement) => {
        const element = kind === "channel" ? normalizeChannelElement(rawElement) : rawElement;
        if (!element || seen.has(element) || !canTranslateElement(element, kind)) {
          return;
        }
        if (kind === "channel" && element.closest('[id^="message-content-"]')) {
          return;
        }

        seen.add(element);
        result.push(element);
      });
    }

    return result;
  }

  function collectFallbackMessageElements(seen) {
    const roots = [
      ...document.querySelectorAll('[data-list-id="chat-messages"], [class*="messagesWrapper"], main')
    ].filter(isVisible);
    const result = [];

    roots.forEach((root) => {
      root.querySelectorAll(FALLBACK_TEXT_SELECTOR).forEach((element) => {
        if (seen.has(element) || !canTranslateElement(element, "message") || hasVisibleTextChild(element)) {
          return;
        }
        if (!element.closest('[data-list-item-id^="chat-messages"], [id^="chat-messages-"], [id^="message-accessories-"], [class*="channelNotice"], [class*="emptyChannel"], [class*="newMessagesBar"], [class*="welcome"]')) {
          return;
        }
        if (!looksUseful(readElementText(element), "message")) {
          return;
        }
        seen.add(element);
        result.push(element);
      });
    });

    return result;
  }

  function candidateKindRank(kind) {
    if (kind === "message") {
      return 0;
    }
    if (kind === "channel") {
      return 1;
    }
    return 2;
  }

  function dedupeTranslationCandidates(candidates) {
    const byElement = new Map();

    candidates.forEach((candidate) => {
      const existing = byElement.get(candidate.element);
      if (!existing || candidateKindRank(candidate.kind) < candidateKindRank(existing.kind)) {
        byElement.set(candidate.element, candidate);
      }
    });

    return [...byElement.values()];
  }

  function leafTranslationCandidates(candidates) {
    const uniqueCandidates = dedupeTranslationCandidates(candidates);

    return uniqueCandidates.filter((candidate) => {
      const candidateText = readCandidateText(candidate.element, candidate.kind);
      if (!looksUseful(candidateText, candidate.kind)) {
        return false;
      }

      return !uniqueCandidates.some((other) => {
        if (other.element === candidate.element || !candidate.element.contains(other.element)) {
          return false;
        }
        const otherText = readCandidateText(other.element, other.kind);
        return looksUseful(otherText, other.kind);
      });
    });
  }

  function collectTranslationCandidates() {
    const seen = new Set();
    const messageElements = uniqueVisibleElements(MESSAGE_SELECTORS, "message");
    const channelElements = uniqueVisibleElements(CHANNEL_SELECTORS, "channel");
    const uiElements = uniqueVisibleElements(UI_SELECTORS, "ui")
      .filter((element) => looksUseful(readCandidateText(element, "ui"), "ui"));

    messageElements.forEach((element) => seen.add(element));
    channelElements.forEach((element) => seen.add(element));
    uiElements.forEach((element) => seen.add(element));
    const fallbackMessageElements = collectFallbackMessageElements(seen);

    return leafTranslationCandidates([
      ...messageElements.map((element) => ({ element, kind: "message" })),
      ...fallbackMessageElements.map((element) => ({ element, kind: "message" })),
      ...channelElements.map((element) => ({ element, kind: "channel" })),
      ...uiElements.map((element) => ({ element, kind: "ui" }))
    ]);
  }

  function ensureState(element, kind, originalText) {
    let state = nodeState.get(element);
    if (state) {
      return state;
    }

    state = {
      kind,
      originalText,
      originalTextSnapshot: captureTextSnapshot(element, kind),
      originalTitle: element.getAttribute("title"),
      targetLanguage: null,
      status: "idle",
      translatedText: null,
      error: null
    };
    nodeState.set(element, state);
    touchedNodes.add(element);
    return state;
  }

  function isMutableTextNode(node, kind) {
    const parent = node?.parentElement;
    if (!parent || !node.nodeValue) {
      return false;
    }
    if (parent.closest([
      LEGACY_RENDER_SELECTOR,
      "script",
      "style",
      "svg",
      "title",
      "desc",
      "canvas",
      '[role="img"]'
    ].join(", "))) {
      return false;
    }
    if (kind !== "channel" && parent.closest('[aria-hidden="true"]')) {
      return false;
    }
    return cleanText(node.nodeValue).length > 0;
  }

  function mutableTextNodes(element, kind) {
    const walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          return isMutableTextNode(node, kind)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        }
      }
    );
    const nodes = [];
    let node = walker.nextNode();
    while (node) {
      nodes.push(node);
      node = walker.nextNode();
    }
    return nodes;
  }

  function captureTextSnapshot(element, kind) {
    return mutableTextNodes(element, kind).map((node) => ({
      node,
      value: node.nodeValue
    }));
  }

  function connectedSnapshotNodes(element, snapshot) {
    return (snapshot || [])
      .filter((entry) => entry.node?.isConnected && element.contains(entry.node));
  }

  function writeElementText(element, state, text) {
    const snapshotNodes = connectedSnapshotNodes(element, state.originalTextSnapshot);
    const targets = snapshotNodes.length > 0
      ? snapshotNodes
      : captureTextSnapshot(element, state.kind);
    const value = cleanText(text);

    if (targets.length === 0 || !value) {
      return false;
    }

    targets.forEach((entry, index) => {
      entry.node.nodeValue = index === 0 ? value : "";
    });
    return true;
  }

  function restoreElementText(element, state) {
    const snapshotNodes = connectedSnapshotNodes(element, state.originalTextSnapshot);
    if (snapshotNodes.length > 0) {
      snapshotNodes.forEach((entry) => {
        entry.node.nodeValue = entry.value;
      });
      return true;
    }

    return writeElementText(element, {
      ...state,
      originalTextSnapshot: captureTextSnapshot(element, state.kind)
    }, state.originalText);
  }

  function visibleElementText(element, kind) {
    return cleanText(readCandidateText(element, kind));
  }

  function needsTranslationReassertion(element, state) {
    if (!settings.mappingEnabled || state.status !== "translated" || !state.translatedText) {
      return false;
    }
    return visibleElementText(element, state.kind) !== cleanText(state.translatedText);
  }

  function restoreTitle(element, state) {
    if (state.originalTitle === null) {
      element.removeAttribute("title");
    } else {
      element.setAttribute("title", state.originalTitle);
    }
  }

  function clearStatus(element, state) {
    element.classList.remove(...STATUS_CLASSES);
    restoreTitle(element, state);
  }

  function setPending(element, state, targetLanguage) {
    clearStatus(element, state);
    element.classList.add("dat-translation-pending");
    element.setAttribute("title", `Translating from ${settings.sourceLanguage} to ${targetLanguage}...`);
    state.targetLanguage = targetLanguage;
    state.status = "pending";
    state.error = null;
  }

  function renderTranslation(element, kind, translation, originalText, targetLanguage) {
    const state = ensureState(element, kind, originalText);
    clearStatus(element, state);

    state.targetLanguage = targetLanguage;
    state.translatedText = translation;
    state.error = null;

    if (isNoNeedToTranslate(translation)) {
      restoreOriginal(element, state);
      state.status = "done";
      return;
    }

    if (isBadTranslation(translation)) {
      renderError(element, kind, "LM Studio returned a generic non-translation", originalText);
      return;
    }

    if (!settings.mappingEnabled) {
      restoreOriginal(element, state);
      state.status = "translated";
      return;
    }

    if (writeElementText(element, state, translation)) {
      element.classList.add("dat-translated");
      element.setAttribute("title", state.originalText);
      state.status = "translated";
      state.savedAt = Date.now();
    }
  }

  function renderError(element, kind, error, originalText) {
    const state = ensureState(element, kind, originalText);
    clearStatus(element, state);
    element.classList.add("dat-translation-error");
    element.setAttribute("title", `Translation failed: ${error}`);
    state.status = "error";
    state.error = error;
  }

  function restoreOriginal(element, state) {
    if (!element.isConnected) {
      return;
    }
    restoreElementText(element, state);
    element.classList.remove(...STATUS_CLASSES);
    restoreTitle(element, state);
  }

  function restoreAllOriginals({ clearState = true } = {}) {
    touchedNodes.forEach((element) => {
      const state = nodeState.get(element);
      if (state) {
        restoreOriginal(element, state);
      }
    });
    if (clearState) {
      touchedNodes = new Set();
      nodeState = new WeakMap();
    }
  }

  function isNoNeedToTranslate(text) {
    return /^<no_need_to_translate\s*\/>$/.test(cleanText(text).toLowerCase());
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    });
  }

  function trimEchoSeparators(text) {
    return cleanText(text.replace(/^[\s:\uFF1A\-\u2013\u2014|/\\>]+|[\s:\uFF1A\-\u2013\u2014|/\\<]+$/g, ""));
  }

  function stripOriginalEcho(translation, originalText) {
    const translated = cleanText(translation);
    const original = cleanText(originalText);
    if (!translated || !original || translated === original) {
      return translated;
    }
    if (translated.startsWith(original)) {
      return trimEchoSeparators(translated.slice(original.length)) || translated;
    }
    if (translated.endsWith(original)) {
      return trimEchoSeparators(translated.slice(0, -original.length)) || translated;
    }
    if (translated.includes(original)) {
      return trimEchoSeparators(translated.split(original).join("")) || translated;
    }
    const lowerTranslated = translated.toLowerCase();
    const lowerOriginal = original.toLowerCase();
    const originalIndex = lowerTranslated.indexOf(lowerOriginal);
    if (originalIndex !== -1) {
      return trimEchoSeparators(
        translated.slice(0, originalIndex) +
        translated.slice(originalIndex + original.length)
      ) || translated;
    }
    return translated;
  }

  async function translateOutgoingMessage(userMessage) {
    if (!isTranslationActive()) {
      throw new Error("Translation disabled for matching source/target languages");
    }

    const response = await sendRuntimeMessage({
      type: "DAT_TRANSLATE_OUTBOUND",
      text: userMessage,
      fromLanguage: settings.targetLanguage,
      toLanguage: settings.sourceLanguage
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Unknown LM Studio error");
    }

    const translation = stripOriginalEcho(response.result.text, userMessage);
    if (!translation) {
      throw new Error("LM Studio returned an empty outbound translation");
    }
    if (isBadTranslation(translation)) {
      throw new Error("LM Studio returned a generic non-translation");
    }

    return translation;
  }

  function postPageBridgeMessage(message) {
    window.postMessage({
      source: PAGE_BRIDGE_SOURCE,
      ...message
    }, window.location.origin);
  }

  function postOutboundTranslationResponse(requestId, payload) {
    postPageBridgeMessage({
      type: `DAT_TRANSLATE_OUTBOUND_RESPONSE_${requestId}`,
      requestId,
      ...payload
    });
  }

  async function translateOutboundRequestForBridge(requestId, text) {
    const userMessage = cleanText(text);
    if (!isTranslationActive() || !looksUseful(userMessage, "message")) {
      postOutboundTranslationResponse(requestId, { ok: false, error: "Outbound translation disabled or empty" });
      return;
    }

    try {
      const translated = await translateOutgoingMessage(userMessage);
      if (isNoNeedToTranslate(translated) || translated === userMessage) {
        postOutboundTranslationResponse(requestId, {
          ok: true,
          noop: true,
          translatedText: userMessage
        });
        return;
      }

      addOutboundReverseMapping(translated, userMessage);
      scheduleScan(50);
      postOutboundTranslationResponse(requestId, {
        ok: true,
        translatedText: translated
      });
    } catch (error) {
      postOutboundTranslationResponse(requestId, {
        ok: false,
        error: error.message || String(error)
      });
    }
  }

  function handlePageBridgeMessage(event) {
    if (event.source !== window || event.data?.source !== PAGE_BRIDGE_SOURCE) {
      return;
    }
    if (event.data.type === "DAT_LOCATION_CHANGED") {
      if (checkChatContext()) {
        scheduleScan(50);
      }
      return;
    }
    if (event.data.type !== "DAT_TRANSLATE_OUTBOUND_REQUEST") {
      return;
    }
    translateOutboundRequestForBridge(event.data.requestId, event.data.text);
  }

  function enqueue(element, kind, text) {
    const targetLanguage = settings.targetLanguage;
    const sourceLanguage = settings.sourceLanguage;
    const state = ensureState(element, kind, text);
    const key = cacheKey(text, targetLanguage);
    const cached = translationCache.get(key);

    if (cached?.status === "done") {
      renderTranslation(element, kind, cached.translation, text, targetLanguage);
      return;
    }

    if (cached?.status === "error") {
      translationCache.delete(key);
    } else if (cached?.status === "pending") {
      cached.waiters.push({ element, kind, text, targetLanguage });
      setPending(element, state, targetLanguage);
      return;
    }

    translationCache.set(key, {
      status: "pending",
      waiters: [{ element, kind, text, targetLanguage }]
    });
    queue.push({ key, text, sourceLanguage, targetLanguage, runId });
    setPending(element, state, targetLanguage);
    pumpQueue();
  }

  function scanVisibleDiscordText() {
    checkChatContext();

    if (!isTranslationActive()) {
      return;
    }

    const candidates = collectTranslationCandidates();

    for (const candidate of candidates) {
      const existing = nodeState.get(candidate.element);
      const text = existing?.originalText || readCandidateText(candidate.element, candidate.kind);

      if (!looksUseful(text, candidate.kind)) {
        continue;
      }

      if (renderRecentOutboundMapping(candidate.element, candidate.kind, text, settings.targetLanguage)) {
        continue;
      }

      const state = ensureState(candidate.element, candidate.kind, text);
      if (state.targetLanguage === settings.targetLanguage && needsTranslationReassertion(candidate.element, state)) {
        renderTranslation(candidate.element, candidate.kind, state.translatedText, state.originalText, settings.targetLanguage);
        continue;
      }
      if (state.targetLanguage === settings.targetLanguage && ["pending", "translated", "done", "error"].includes(state.status)) {
        continue;
      }

      enqueue(candidate.element, candidate.kind, state.originalText);
    }
  }

  function pumpQueue() {
    const concurrency = Math.max(1, Number(settings.concurrency) || DEFAULT_SETTINGS.concurrency);
    while (activeRequests < concurrency && queue.length > 0) {
      const item = queue.shift();
      if (item.runId !== runId) {
        continue;
      }

      const cached = translationCache.get(item.key);
      if (!cached || cached.status !== "pending") {
        continue;
      }

      activeRequests += 1;
      chrome.runtime.sendMessage(
        {
          type: "DAT_TRANSLATE",
          text: item.text,
          sourceLanguage: item.sourceLanguage,
          targetLanguage: item.targetLanguage
        },
        (response) => {
          activeRequests -= 1;

          const latest = translationCache.get(item.key);
          if (!latest || item.runId !== runId) {
            pumpQueue();
            return;
          }

          if (chrome.runtime.lastError) {
            latest.status = "error";
            latest.error = chrome.runtime.lastError.message;
            latest.waiters.forEach(({ element, kind, text }) => renderError(element, kind, latest.error, text));
            pumpQueue();
            return;
          }

          if (!response?.ok) {
            latest.status = "error";
            latest.error = response?.error || "Unknown LM Studio error";
            latest.waiters.forEach(({ element, kind, text }) => renderError(element, kind, latest.error, text));
            pumpQueue();
            return;
          }

          const translation = response.result.text;
          if (isBadTranslation(translation)) {
            latest.status = "error";
            latest.error = "LM Studio returned a generic non-translation";
            latest.waiters.forEach(({ element, kind, text }) => renderError(element, kind, latest.error, text));
            pumpQueue();
            return;
          }

          latest.status = "done";
          latest.translation = translation;
          latest.savedAt = Date.now();
          scheduleCacheSave();
          latest.waiters.forEach(({ element, kind, text, targetLanguage }) => renderTranslation(element, kind, latest.translation, text, targetLanguage));
          pumpQueue();
        }
      );
    }
  }

  function scheduleScan(delay = 250) {
    window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(scanVisibleDiscordText, delay);
  }

  function applyCachedMappingsToVisible() {
    const candidates = collectTranslationCandidates();

    for (const candidate of candidates) {
      const existing = nodeState.get(candidate.element);
      const text = existing?.originalText || readCandidateText(candidate.element, candidate.kind);

      if (!looksUseful(text, candidate.kind)) {
        continue;
      }

      if (renderRecentOutboundMapping(candidate.element, candidate.kind, text, settings.targetLanguage)) {
        continue;
      }

      const cached = translationCache.get(cacheKey(text, settings.targetLanguage));
      if (cached?.status !== "done") {
        continue;
      }

      renderTranslation(candidate.element, candidate.kind, cached.translation, text, settings.targetLanguage);
    }
  }

  function stopAndRestore({ clearState = true } = {}) {
    runId += 1;
    queue = [];
    pruneTransientCacheEntries();
    restoreAllOriginals({ clearState });
  }

  function resetAndRescan() {
    stopAndRestore();
    scheduleScan(50);
  }

  Promise.all([
    storageGet(DEFAULT_SETTINGS),
    loadPersistentCache()
  ]).then(([stored]) => {
    settings = {
      ...DEFAULT_SETTINGS,
      ...stored,
      concurrency: Math.max(1, Number(stored.concurrency) || DEFAULT_SETTINGS.concurrency)
    };
    scheduleScan(100);
  }).catch(() => {
    scheduleScan(100);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") {
      return;
    }

    if (changes[CACHE_STORAGE_KEY] && changes[CACHE_STORAGE_KEY].newValue === undefined) {
      clearCompletedCacheEntries();
    }

    const nextSettings = { ...settings };
    let settingsChanged = false;
    for (const [key, change] of Object.entries(changes)) {
      if (!SETTING_KEYS.has(key)) {
        continue;
      }
      nextSettings[key] = change.newValue;
      settingsChanged = true;
    }

    if (!settingsChanged) {
      return;
    }
    nextSettings.concurrency = Math.max(1, Number(nextSettings.concurrency) || DEFAULT_SETTINGS.concurrency);

    const wasActive = isTranslationActive();
    const sourceChanged = nextSettings.sourceLanguage !== settings.sourceLanguage;
    const targetChanged = nextSettings.targetLanguage !== settings.targetLanguage;
    const enabledChanged = nextSettings.enabled !== settings.enabled;
    const mappingChanged = nextSettings.mappingEnabled !== settings.mappingEnabled;
    settings = nextSettings;
    const nowActive = isTranslationActive();

    if (!nowActive) {
      stopAndRestore({ clearState: false });
      return;
    }

    if (!wasActive) {
      resetAndRescan();
      return;
    }

    if (mappingChanged && !sourceChanged && !targetChanged && !enabledChanged) {
      applyCachedMappingsToVisible();
      return;
    }

    if (sourceChanged || targetChanged || enabledChanged) {
      resetAndRescan();
    } else {
      pumpQueue();
      scheduleScan(50);
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "DAT_RESCAN") {
      resetAndRescan();
      sendResponse({ ok: true });
      return true;
    }
    if (message?.type === "DAT_CLEAR") {
      stopAndRestore();
      sendResponse({ ok: true });
      return true;
    }
    if (message?.type === "DAT_CLEAR_TRANSLATION_CACHE") {
      clearPersistentCache()
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }
    return false;
  });

  const observer = new MutationObserver(() => scheduleScan(400));
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true
  });

  window.addEventListener("message", handlePageBridgeMessage);
  window.addEventListener("scroll", () => scheduleScan(200), true);
  window.setInterval(() => scheduleScan(500), 5000);
})();
