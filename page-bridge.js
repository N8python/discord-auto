(() => {
  const PAGE_BRIDGE_VERSION = "0.3.0";

  if (window.__discordAutoTranslatePageBridge === PAGE_BRIDGE_VERSION) {
    return;
  }
  window.__discordAutoTranslatePageBridge = PAGE_BRIDGE_VERSION;

  const MESSAGE_SOURCE = "discord-auto-translate";
  const TRANSLATE_TIMEOUT_MS = 45 * 1000;
  let lastHref = window.location.href;
  let nextRequestId = 1;
  const pendingTranslations = new Map();

  function cleanText(text) {
    return (text || "")
      .replace(/\u200b/g, "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function notifyLocationChanged() {
    const href = window.location.href;
    if (href === lastHref) {
      return;
    }

    lastHref = href;
    window.postMessage({
      source: MESSAGE_SOURCE,
      type: "DAT_LOCATION_CHANGED",
      href
    }, window.location.origin);
  }

  function notifyLocationChangedSoon() {
    window.setTimeout(notifyLocationChanged, 0);
  }

  function installLocationChangeHook() {
    ["pushState", "replaceState"].forEach((method) => {
      const original = window.history[method];
      if (typeof original !== "function") {
        return;
      }

      window.history[method] = function datHistoryMethod(...args) {
        const result = original.apply(this, args);
        notifyLocationChangedSoon();
        return result;
      };
    });

    window.addEventListener("popstate", notifyLocationChangedSoon);
    window.addEventListener("hashchange", notifyLocationChangedSoon);
  }

  function isMessageCreateUrl(url) {
    try {
      const parsed = new URL(String(url), window.location.href);
      return /\/api\/v\d+\/channels\/\d+\/messages$/.test(parsed.pathname);
    } catch (_error) {
      return false;
    }
  }

  function requestOutboundTranslation(text) {
    const requestId = nextRequestId;
    nextRequestId += 1;

    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        pendingTranslations.delete(requestId);
        resolve({ ok: false, error: "Timed out waiting for outbound translation" });
      }, TRANSLATE_TIMEOUT_MS);

      pendingTranslations.set(requestId, { resolve, timer });
      window.postMessage({
        source: MESSAGE_SOURCE,
        type: "DAT_TRANSLATE_OUTBOUND_REQUEST",
        requestId,
        text
      }, window.location.origin);
    });
  }

  function patchJsonBodyWithContent(body, nextContent) {
    if (typeof body !== "string") {
      return body;
    }

    try {
      const payload = JSON.parse(body);
      if (!payload || typeof payload.content !== "string") {
        return body;
      }

      if (nextContent === payload.content) {
        return body;
      }

      return JSON.stringify({
        ...payload,
        content: nextContent
      });
    } catch (_error) {
      return body;
    }
  }

  async function patchJsonBodyWithTranslation(body) {
    if (typeof body !== "string") {
      return body;
    }

    try {
      const payload = JSON.parse(body);
      if (!payload || typeof payload.content !== "string") {
        return body;
      }

      const originalContent = payload.content;
      const response = await requestOutboundTranslation(originalContent);
      if (!response?.ok || !response.translatedText || response.noop) {
        return body;
      }

      return patchJsonBodyWithContent(body, response.translatedText);
    } catch (_error) {
      return body;
    }
  }

  async function patchRequestBody(url, body) {
    if (!isMessageCreateUrl(url)) {
      return body;
    }

    return patchJsonBodyWithTranslation(body);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== MESSAGE_SOURCE) {
      return;
    }

    if (event.data.type?.startsWith("DAT_TRANSLATE_OUTBOUND_RESPONSE_")) {
      const pending = pendingTranslations.get(event.data.requestId);
      if (!pending) {
        return;
      }
      window.clearTimeout(pending.timer);
      pendingTranslations.delete(event.data.requestId);
      pending.resolve(event.data);
    }
  });

  const originalFetch = window.fetch;
  window.fetch = async function datFetch(input, init) {
    const url = typeof input === "string" || input instanceof URL ? input : input?.url;
    if (init?.body) {
      const body = await patchRequestBody(url, init.body);
      if (body !== init.body) {
        init = { ...init, body };
      }
    }
    return originalFetch.call(this, input, init);
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function datOpen(method, url, ...rest) {
    this.__datMessageUrl = url;
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function datSend(body) {
    patchRequestBody(this.__datMessageUrl, body)
      .then((nextBody) => originalSend.call(this, nextBody))
      .catch(() => originalSend.call(this, body));
  };

  installLocationChangeHook();
})();
