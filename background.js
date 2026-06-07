const DEFAULT_SETTINGS = {
  enabled: true,
  sourceLanguage: "Spanish",
  targetLanguage: "English",
  concurrency: 4,
  lmStudioUrl: "http://127.0.0.1:1234",
  model: "google/gemma-4-26b-a4b"
};

function normalizeChatCompletionsUrl(value) {
  const base = (value || DEFAULT_SETTINGS.lmStudioUrl).trim().replace(/\/+$/, "");
  if (base.endsWith("/v1/chat/completions")) {
    return base;
  }
  if (base.endsWith("/v1")) {
    return `${base}/chat/completions`;
  }
  return `${base}/v1/chat/completions`;
}

function estimatedInputTokens(text) {
  const value = String(text || "").trim();
  if (!value) {
    return 1;
  }

  const cjkMatches = value.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu) || [];
  const wordMatches = value.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?|[^\s\p{L}\p{N}]/gu) || [];
  const nonCjkTokens = wordMatches.filter((token) => !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(token)).length;

  return Math.max(1, cjkMatches.length + nonCjkTokens);
}

function maxTokensForInput(text) {
  return Math.max(16, estimatedInputTokens(text) * 2);
}

function languageLabel(value) {
  const language = String(value || "").trim();
  const compact = language.toLowerCase().replace(/[\s_-]+/g, "");
  const labels = {
    en: "English",
    eng: "English",
    english: "English",
    es: "Spanish",
    spa: "Spanish",
    spanish: "Spanish",
    espanol: "Spanish",
    español: "Spanish"
  };
  return labels[compact] || language;
}

function buildTranslationPrompt(text, sourceLanguage, targetLanguage) {
  const source = languageLabel(sourceLanguage || DEFAULT_SETTINGS.sourceLanguage) || DEFAULT_SETTINGS.sourceLanguage;
  const target = languageLabel(targetLanguage || DEFAULT_SETTINGS.targetLanguage) || DEFAULT_SETTINGS.targetLanguage;
  return `Translate the following from ${source} to ${target}, in the context of a Discord server. Just respond with the ${target} translation and nothing else. Do not use any non-${target} language in your response. Only translate text that is in ${source}. If the text is already in ${target}, or is in a different language that is not ${source} or ${target}, just respond w/ the XML tag <no_need_to_translate />:\n<discord_text>\n${text}\n</discord_text>`;
}

function buildOutboundTranslationPrompt(text, fromLanguage, toLanguage) {
  const from = languageLabel(fromLanguage || DEFAULT_SETTINGS.targetLanguage) || DEFAULT_SETTINGS.targetLanguage;
  const to = languageLabel(toLanguage || DEFAULT_SETTINGS.sourceLanguage) || DEFAULT_SETTINGS.sourceLanguage;
  return `Translate the following USER_MESSAGE from ${from} to ${to}, in the context of a Discord server. Just respond with the ${to} translation and nothing else. Do not include USER_MESSAGE, bilingual output, explanations, romanization, or any ${from} language in your response. Only translate text that is in ${from}. If the text is already in ${to}, or is in a different language that is not ${from} or ${to}, just respond w/ the XML tag <no_need_to_translate />.\n\nUSER_MESSAGE:\n${text}`;
}

async function loadSettings() {
  return chrome.storage.local.get(DEFAULT_SETTINGS);
}

async function translateText(text, sourceLanguage, targetLanguage) {
  const settings = await loadSettings();
  const url = normalizeChatCompletionsUrl(settings.lmStudioUrl);
  const prompt = buildTranslationPrompt(
    text,
    sourceLanguage || settings.sourceLanguage,
    targetLanguage || settings.targetLanguage
  );

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: settings.model,
      temperature: 0,
      max_tokens: maxTokensForInput(text),
      reasoning_effort: "none",
      messages: [
        {
          role: "user",
          content: prompt
        }
      ]
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || `LM Studio returned HTTP ${response.status}`;
    throw new Error(message);
  }

  const choice = payload?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== "string") {
    throw new Error("LM Studio response did not include choices[0].message.content");
  }

  return {
    text: content.trim(),
    model: payload.model,
    usage: payload.usage || null,
    finishReason: choice.finish_reason || null
  };
}

async function translateOutboundText(text, fromLanguage, toLanguage) {
  const settings = await loadSettings();
  const url = normalizeChatCompletionsUrl(settings.lmStudioUrl);
  const prompt = buildOutboundTranslationPrompt(
    text,
    fromLanguage || settings.targetLanguage,
    toLanguage || settings.sourceLanguage
  );

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: settings.model,
      temperature: 0,
      max_tokens: maxTokensForInput(text),
      reasoning_effort: "none",
      messages: [
        {
          role: "user",
          content: prompt
        }
      ]
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || `LM Studio returned HTTP ${response.status}`;
    throw new Error(message);
  }

  const choice = payload?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== "string") {
    throw new Error("LM Studio response did not include choices[0].message.content");
  }

  return {
    text: content.trim(),
    model: payload.model,
    usage: payload.usage || null,
    finishReason: choice.finish_reason || null
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "DAT_TRANSLATE") {
    translateText(message.text, message.sourceLanguage, message.targetLanguage)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

    return true;
  }

  if (message?.type === "DAT_TRANSLATE_OUTBOUND") {
    translateOutboundText(message.text, message.fromLanguage, message.toLanguage)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));

    return true;
  }

  return false;
});
