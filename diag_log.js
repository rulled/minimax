// diag_log.js — диагностический журнал расширения.
// Кольцевой буфер в chrome.storage.local (DEFAULT_MAX_EVENTS) — переживает сон
// MV3 service worker и закрытие попапа. Одинаковое API во всех контекстах:
// DiagLog.info/warn/error/debug(scope, message, data?) + DiagLog.dump()/clear().
// Экспорт: popup («Экспорт логов») или CDP (--extension-logs в minimax-cdp-diagnostics.js).
(function(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DiagLog = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  const STORAGE_KEY = 'diagLogEvents';
  const DEFAULT_MAX_EVENTS = 2000;

  let maxEvents = DEFAULT_MAX_EVENTS;
  let writeChain = Promise.resolve();
  // Буфер записи на контекст: события копятся в памяти и сбрасываются в storage
  // одним set() через микрофлишь — сотни событий за прогон не рвут storage.
  let pending = [];
  let flushTimer = null;
  const FLUSH_DELAY_MS = 400;

  function timestamp() {
    return new Date().toISOString();
  }

  function pushEvent(level, scope, message, data) {
    return {
      ts: timestamp(),
      level,
      ctx: detectContext(),
      scope: String(scope || 'app'),
      msg: String(message || ''),
      data: data === undefined ? null : safeClone(data)
    };
  }

  function detectContext() {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.id) {
        if (typeof window === 'undefined' && typeof document === 'undefined') return 'sw';
        if (typeof document !== 'undefined' && document.getElementById('popupRoot')) return 'popup';
        return 'popup';
      }
    } catch (_) { /* не extension-контекст */ }
    if (typeof document !== 'undefined') return 'content';
    return 'unknown';
  }

  function safeClone(value) {
    if (value === null || value === undefined) return null;
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: String(value.stack || '').split('\n').slice(0, 5).join('\n') };
    }
    try {
      const json = JSON.stringify(value);
      return json === undefined ? String(value) : JSON.parse(json);
    } catch (_) {
      return { unserializable: String(value) };
    }
  }

  function log(level, scope, message, data) {
    const event = pushEvent(level, scope, message, data);
    pending.push(event);
    if (pending.length > maxEvents) pending.splice(0, pending.length - maxEvents);
    scheduleFlush();
    mirrorToConsole(event);
    return event;
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushNow();
    }, FLUSH_DELAY_MS);
  }

  async function flushNow() {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    writeChain = writeChain.then(async () => {
      try {
        const stored = await chrome.storage.local.get(STORAGE_KEY);
        const events = Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
        events.push(...batch);
        if (events.length > maxEvents) events.splice(0, events.length - maxEvents);
        await chrome.storage.local.set({ [STORAGE_KEY]: events });
      } catch (error) {
        // Storage недоступен (нет chrome API или квота) — события остаются в console-mirror.
        mirrorBatch(batch);
        pending.unshift(...batch.slice(-50));
      }
    });
    await writeChain;
  }

  function mirrorBatch(batch) {
    batch.forEach(mirrorToConsole);
  }

  function mirrorToConsole(event) {
    try {
      const line = `[diag:${event.ctx}/${event.scope}] ${event.msg}`;
      if (event.level === 'error') console.error(line, event.data ?? '');
      else if (event.level === 'warn') console.warn(line, event.data ?? '');
      else if (event.level === 'debug') console.debug(line, event.data ?? '');
      else console.log(line, event.data ?? '');
    } catch (_) { /* консоль может отсутствовать */ }
  }

  async function dump() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    await flushNow();
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    return Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
  }

  async function clear() {
    pending = [];
    await chrome.storage.local.set({ [STORAGE_KEY]: [] });
  }

  function stats() {
    return { pendingCount: pending.length, maxEvents };
  }

  return {
    debug: (scope, message, data) => log('debug', scope, message, data),
    info: (scope, message, data) => log('info', scope, message, data),
    warn: (scope, message, data) => log('warn', scope, message, data),
    error: (scope, message, data) => log('error', scope, message, data),
    dump,
    clear,
    stats,
    STORAGE_KEY,
    __test: { pushEvent, safeClone, detectContext }
  };
});
