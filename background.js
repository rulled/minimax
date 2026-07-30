// Состояние расширения
let extensionEnabled = false;

// "Бронь" для следующего скачивания (для новых DIV-кнопок без href)
let nextDownloadConfig = null;
const PRIME_TTL_MS = 120000;
let pendingNamedDownloads = [];

function reserveNamedDownload(url, filename) {
  const reservation = { url, filename, createdAt: Date.now() };
  pendingNamedDownloads.push(reservation);
  return reservation;
}

function releaseNamedDownload(reservation) {
  pendingNamedDownloads = pendingNamedDownloads.filter((item) => item !== reservation);
}

// Загружаем состояние при старте
chrome.storage.local.get('extensionEnabled', (data) => {
  extensionEnabled = data.extensionEnabled !== false;
});

// Слушаем изменения состояния
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.extensionEnabled) {
    extensionEnabled = changes.extensionEnabled.newValue;
  }
});

// Слушаем начало любого скачивания (для новых DIV-кнопок)
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (!extensionEnabled) {
    suggest();
    return;
  }
  pendingNamedDownloads = pendingNamedDownloads.filter((reservation) => {
    return Date.now() - reservation.createdAt <= PRIME_TTL_MS;
  });
  const namedReservation = pendingNamedDownloads.find((reservation) => reservation.url === item.url);
  if (namedReservation) {
    releaseNamedDownload(namedReservation);
    suggest({ filename: namedReservation.filename, conflictAction: 'uniquify' });
    return;
  }
  if (nextDownloadConfig) {
    console.log('[Background] onDeterminingFilename item:', { url: item.url, tabId: item.tabId, filename: item.filename });
    const isExpired = Date.now() - nextDownloadConfig.createdAt > PRIME_TTL_MS;
    if (isExpired) {
      console.log('[Background] Prime expired, skipping rename');
      nextDownloadConfig = null;
      suggest();
      return;
    }
    const primedTabId = nextDownloadConfig.tabId;
    const itemTabId = typeof item.tabId === 'number' ? item.tabId : null;
    const hasKnownPrimedTab = typeof primedTabId === 'number' && primedTabId >= 0;
    const hasKnownItemTab = typeof itemTabId === 'number' && itemTabId >= 0;
    if (hasKnownPrimedTab && hasKnownItemTab && itemTabId !== primedTabId) {
      console.log('[Background] Prime tab mismatch, keeping reservation for target tab', { primedTabId, itemTabId });
      suggest();
      return;
    }

    const isBlobUrl = typeof item.url === 'string' && item.url.startsWith('blob:');
    const isBlobMp3 = isBlobUrl && typeof item.filename === 'string' && item.filename.toLowerCase().endsWith('.mp3');
    const isDataAudio = typeof item.url === 'string' && item.url.startsWith('data:audio/');
    if (!item.url || (!isValidAudioUrl(item.url) && !isBlobMp3 && !isDataAudio)) {
      console.log('[Background] Prime active but download is not a valid audio url, skipping rename');
      suggest();
      return;
    }
        const { folderName, fileNamePrefix, fileNumber, downloadLayout } = nextDownloadConfig;
        const isPackageLayout = downloadLayout === 'package';
        const paddedNumber = String(fileNumber).padStart(isPackageLayout ? 3 : 4, '0');
        const newFilename = isPackageLayout
          ? `${folderName}/${paddedNumber}__${fileNamePrefix}.mp3`
          : `${folderName}/${paddedNumber}_${fileNamePrefix}.mp3`;
    
    console.log(`[Background] Реноме по "брони": ${newFilename}`);
    
    suggest({
      filename: newFilename,
      conflictAction: 'uniquify'
    });
    
    saveToDownloadHistory(folderName, newFilename, fileNumber);
    nextDownloadConfig = null; // Сбрасываем бронь
    return;
  }
  suggest();
});

// Валидация URL для MP3 файлов
function isValidAudioUrl(url) {
  try {
    const urlObj = new URL(url);
    if (!urlObj.pathname.endsWith('.mp3')) return false;

    const validDomains = ['cdn.hailuoai.video', 'hailuoai.com', 'minimax.io'];
    if (!validDomains.some(domain => urlObj.hostname.includes(domain))) return false;

    return true;
  } catch (error) {
    return false;
  }
}

// Санитизация имени файла
function sanitizeFilename(filename) {
  return filename
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .replace(/\s+/g, '_')  // Заменяем пробелы на подчеркивания
    .slice(0, 100);
}

async function buildDownloadTarget({ voiceName, scriptName, forceIndex, speakerName, downloadLayout, sourceFileName, sourceFileBaseName }) {
  const sanitizedVoice = sanitizeFilename(voiceName || 'dictor');
  const sanitizedScript = scriptName ? sanitizeFilename(scriptName) : null;
  const sanitizedSpeaker = speakerName ? sanitizeFilename(speakerName) : sanitizedVoice;
  const rawSourceBase = sourceFileBaseName || (sourceFileName ? String(sourceFileName).replace(/\.[^.]+$/, '') : '');
  const sanitizedSourceBase = rawSourceBase ? sanitizeFilename(rawSourceBase) : null;
  const normalizedLayout = String(downloadLayout || '').trim().toLowerCase();

  let folderName;
  let fileNamePrefix;
  let padLength = 4;

  if (normalizedLayout === 'package') {
    folderName = sanitizedScript || sanitizedSpeaker || sanitizedVoice;
    fileNamePrefix = [sanitizedSourceBase, sanitizedSpeaker || sanitizedVoice].filter(Boolean).join('__')
      || sanitizedSpeaker || sanitizedVoice || sanitizedScript || 'dictor';
    padLength = 3;
  } else {
    folderName = sanitizedScript ? `${sanitizedScript} - ${sanitizedSpeaker}` : sanitizedSpeaker;
    fileNamePrefix = sanitizedScript ? `${sanitizedScript} - ${sanitizedSpeaker}` : sanitizedSpeaker;
  }

  let fileNumber = forceIndex;
  if (!fileNumber) {
    fileNumber = await getNextFileNumber(folderName);
  }

  await ensureFileCounterAtLeast(folderName, fileNumber);

  return {
    folderName,
    fileNamePrefix,
    fileNumber,
    downloadLayout: normalizedLayout || 'default',
    newFilename: normalizedLayout === 'package'
      ? `${folderName}/${String(fileNumber).padStart(padLength, '0')}__${fileNamePrefix}.mp3`
      : `${folderName}/${String(fileNumber).padStart(padLength, '0')}_${fileNamePrefix}.mp3`
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDownloadConfirmation(downloadId, timeoutMs = 60000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const items = await chrome.downloads.search({ id: downloadId });
    const item = Array.isArray(items) ? items[0] : null;

    if (item) {
      if (item.error || item.state === 'interrupted') {
        return {
          ok: false,
          reason: item.error || 'download_interrupted'
        };
      }

      if (item.state === 'complete') {
        return {
          ok: true,
          state: item.state,
          filename: item.filename || null
        };
      }
    }

    await sleep(250);
  }

  return {
    ok: false,
    reason: 'download_confirmation_timeout'
  };
}

let fileCountersLock = Promise.resolve();

function withFileCountersLock(task) {
  const run = fileCountersLock.then(task, task);
  fileCountersLock = run.catch(() => {});
  return run;
}

// Получаем следующий номер для файла
async function getNextFileNumber(voiceName) {
  return withFileCountersLock(async () => {
    const data = await chrome.storage.local.get('fileCounters');
    const counters = data.fileCounters || {};
    const currentCount = counters[voiceName] || 0;
    const nextCount = currentCount + 1;

    counters[voiceName] = nextCount;
    await chrome.storage.local.set({ fileCounters: counters });

    return nextCount;
  });
}

// Гарантируем, что счётчик не меньше заданного значения
async function ensureFileCounterAtLeast(voiceName, value) {
  return withFileCountersLock(async () => {
    const data = await chrome.storage.local.get('fileCounters');
    const counters = data.fileCounters || {};
    const currentCount = counters[voiceName] || 0;
    if (value > currentCount) {
      counters[voiceName] = value;
      await chrome.storage.local.set({ fileCounters: counters });
    }
  });
}

let downloadHistoryLock = Promise.resolve();

// Сохраняем в историю
async function saveToDownloadHistory(voiceName, filename, fileNumber) {
  const save = downloadHistoryLock.then(async () => {
    try {
      const data = await chrome.storage.local.get('downloadHistory');
      let history = data.downloadHistory || [];

      history.push({
        voiceName,
        filename,
        fileNumber,
        timestamp: Date.now()
      });

      if (history.length > 100) history = history.slice(-100);
      await chrome.storage.local.set({ downloadHistory: history });
    } catch (error) {
      console.error('Ошибка сохранения истории:', error);
    }
  });
  downloadHistoryLock = save.catch(() => {});
  return save;
}

// ============================================
// STATE MANAGEMENT
// ============================================

function getDefaultAutomationState() {
  return {
    parsedEntries: null,
    selectedSpeaker: null,
    fileName: null,
    voiceMappings: {},
    excludedIds: [],
    multiExcludedIds: [],
    mode: 'single',
    loadedAt: null,
    progress: {
      currentIndex: 0,
      isRunning: false,
      isPaused: false,
      completedIds: []
    },
    // Сохранение пропущенных текстов (>5k символов)
    skippedEntries: [],
    skippedEntriesMulti: []
  };
}

let automationState = null;
let automationStateReady = null;

function getSkippedEntryKey(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const scriptName = (entry.scriptName || '').trim();
  const speaker = (entry.speaker || '').trim();
  const speakerIndex = Number.isFinite(Number(entry.speakerIndex)) ? String(Number(entry.speakerIndex)) : '';
  const id = (entry.id || '').trim();
  return [scriptName, speaker, speakerIndex, id].join('::');
}

async function initAutomationState() {
  const data = await chrome.storage.local.get('automationState');
  automationState = data.automationState || getDefaultAutomationState();
}

function ensureAutomationState() {
  if (!automationState) {
    automationState = getDefaultAutomationState();
  }
}

async function ensureAutomationStateLoaded() {
  if (automationState !== null) return;
  if (!automationStateReady) {
    automationStateReady = initAutomationState().catch((error) => {
      console.error('[Background] Error loading automation state:', error);
      automationState = getDefaultAutomationState();
    });
  }
  await automationStateReady;
}

async function saveAutomationState(newState) {
  ensureAutomationState();
  automationState = { ...automationState, ...newState };
  await chrome.storage.local.set({ automationState });
  chrome.runtime.sendMessage({
    action: 'automationStateUpdated',
    state: automationState
  }).catch(() => {});
}

async function clearAutomationState() {
  ensureAutomationState();
  automationState = getDefaultAutomationState();
  await chrome.storage.local.set({ automationState });
}

automationStateReady = initAutomationState().catch((error) => {
  console.error('[Background] Error initializing automation state:', error);
  automationState = getDefaultAutomationState();
});

// Обработчик сообщений
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  (async () => {
    try {
      await ensureAutomationStateLoaded();

      if (request.action === "getAutomationState") {
        sendResponse({ success: true, state: automationState });
        return;
      }

      if (request.action === "getTabVoiceName") {
        const tabId = sender.tab?.id ? String(sender.tab.id) : 'fallback-tab';
        const data = await chrome.storage.local.get('tabVoices');
        const tabVoices = data.tabVoices || {};
        const voiceName = tabVoices[tabId] || 'dictor';
        sendResponse({ success: true, voiceName });
        return;
      }

      if (request.action === "saveAutomationData") {
        await saveAutomationState({
          ...request,
          loadedAt: Date.now()
        });
        sendResponse({ success: true });
        return;
      }

      if (request.action === "updateAutomationProgress") {
        if (request.runId) {
          sendResponse({ success: true });
          return;
        }
        await saveAutomationState({
          progress: { ...(automationState.progress || {}), ...request.progress }
        });
        sendResponse({ success: true });
        return;
      }

      if (request.action === "clearAutomationState") {
        if (request.runId) {
          sendResponse({ success: true });
          return;
        }
        await clearAutomationState();
        sendResponse({ success: true });
        return;
      }

      if (request.action === "markSkippedAsCompleted") {
        const key = request.mode === 'multi' ? 'skippedEntriesMulti' : 'skippedEntries';
        const entries = automationState[key] || [];
        const targetKey = (request.entryKey || '').trim();
        
        const updatedEntries = entries.map(e => {
          const entryKey = getSkippedEntryKey(e);
          const byKey = targetKey && entryKey === targetKey;
          const byLegacyId = !targetKey && e.id === request.entryId;
          if ((byKey || byLegacyId) && !e.completed) {
            console.log(`[Background] Manually marking skipped entry as completed: ${e.fullFileName}`);
            return { ...e, completed: true, completedAt: Date.now() };
          }
          return e;
        });
        
        await saveAutomationState({ [key]: updatedEntries });
        
        // Проверяем, все ли записи выполнены
        const allCompleted = updatedEntries.every(e => e.completed);
        
        sendResponse({ success: true, allCompleted });
        
        // Отправляем уведомление в popup
        chrome.runtime.sendMessage({
          action: 'skippedEntryCompleted',
          mode: request.mode,
          entries: updatedEntries,
          allCompleted: allCompleted
        }).catch(() => {});
        
        return;
      }

      if (request.action === "downloadFile") {
        if (!extensionEnabled) {
          sendResponse({ success: false, reason: 'disabled' });
          return;
        }

        const url = request.url;
        if (!isValidAudioUrl(url)) {
          sendResponse({ success: false, reason: 'invalid-url' });
          return;
        }

        const tabId = sender.tab?.id ? String(sender.tab.id) : 'fallback-tab';
        const data = await chrome.storage.local.get('tabVoices');
        const tabVoices = data.tabVoices || {};

        // Определяем имя папки/файла
        let voiceName;

        // Если автоматизация передала имя спикера (Мульти-режим)
        if (request.forceSpeaker) {
            voiceName = request.forceSpeaker;
        } else {
            // Иначе берем из настроек вкладки
            voiceName = tabVoices[tabId] || 'dictor';
        }

        const target = await buildDownloadTarget({
          voiceName,
          scriptName: request.scriptName || null,
          forceIndex: request.forceIndex || null,
          speakerName: request.forceSpeaker || null,
          downloadLayout: request.downloadLayout || null,
          sourceFileName: request.sourceFileName || null,
          sourceFileBaseName: request.sourceFileBaseName || null
        });

        console.log(`Скачиваем как ${target.newFilename}`);

        const namedReservation = reserveNamedDownload(url, target.newFilename);
        chrome.downloads.download({
          url: url,
          filename: target.newFilename,
          conflictAction: 'uniquify',
          saveAs: false
        }, async (downloadId) => {
          if (chrome.runtime.lastError) {
            releaseNamedDownload(namedReservation);
            console.error('Ошибка скачивания:', chrome.runtime.lastError);
            sendResponse({ success: false, reason: chrome.runtime.lastError.message });
          } else {
            const confirmResult = await waitForDownloadConfirmation(downloadId);
            if (!confirmResult.ok) {
              sendResponse({ success: false, reason: confirmResult.reason, downloadId });
              return;
            }

            saveToDownloadHistory(target.folderName, target.newFilename, target.fileNumber);
            sendResponse({
              success: true,
              downloadId,
              fileNumber: target.fileNumber,
              state: confirmResult.state,
              filename: confirmResult.filename
            });
          }
        });

      } else if (request.action === "downloadAudioData") {
        if (!extensionEnabled) {
          sendResponse({ success: false, reason: 'disabled' });
          return;
        }

        if (typeof request.dataUrl !== 'string' || !request.dataUrl.startsWith('data:audio/')) {
          sendResponse({ success: false, reason: 'invalid-data-url' });
          return;
        }

        const target = await buildDownloadTarget({
          voiceName: request.voiceName,
          scriptName: request.scriptName || null,
          forceIndex: request.forceIndex || null,
          speakerName: request.speakerName || null,
          downloadLayout: request.downloadLayout || null,
          sourceFileName: request.sourceFileName || null,
          sourceFileBaseName: request.sourceFileBaseName || null
        });

        console.log(`Скачиваем audio data как ${target.newFilename}`);

        const namedReservation = reserveNamedDownload(request.dataUrl, target.newFilename);
        chrome.downloads.download({
          url: request.dataUrl,
          filename: target.newFilename,
          conflictAction: 'uniquify',
          saveAs: false
        }, async (downloadId) => {
          if (chrome.runtime.lastError) {
            releaseNamedDownload(namedReservation);
            console.error('Ошибка скачивания data url:', chrome.runtime.lastError);
            sendResponse({ success: false, reason: chrome.runtime.lastError.message });
          } else {
            const confirmResult = await waitForDownloadConfirmation(downloadId);
            if (!confirmResult.ok) {
              sendResponse({ success: false, reason: confirmResult.reason, downloadId });
              return;
            }

            await saveToDownloadHistory(target.folderName, target.newFilename, target.fileNumber);
            sendResponse({
              success: true,
              downloadId,
              fileNumber: target.fileNumber,
              state: confirmResult.state,
              filename: confirmResult.filename
            });
          }
        });

      } else if (request.action === "updateExtensionState") {
        extensionEnabled = request.enabled;
        sendResponse({ success: true });

      } else if (request.action === "getHistory") {
        const data = await chrome.storage.local.get('downloadHistory');
        sendResponse({ success: true, history: data.downloadHistory || [] });

      } else if (request.action === "clearHistory") {
        await chrome.storage.local.set({ downloadHistory: [] });
        sendResponse({ success: true });

      } else if (request.action === "saveSkippedEntries") {
        // Сохранение пропущенных записей
        const key = request.mode === 'multi' ? 'skippedEntriesMulti' : 'skippedEntries';
        const currentEntries = Array.isArray(automationState[key]) ? automationState[key] : [];
        const incomingEntries = Array.isArray(request.entries) ? request.entries : [];

        if (incomingEntries.length === 0) {
          await saveAutomationState({ [key]: [] });
          sendResponse({ success: true });
          return;
        }

        const merged = new Map();
        currentEntries.forEach((entry) => merged.set(getSkippedEntryKey(entry), entry));
        incomingEntries.forEach((entry) => {
          const keyValue = getSkippedEntryKey(entry);
          const prev = merged.get(keyValue);
          merged.set(keyValue, prev ? { ...prev, ...entry } : entry);
        });

        await saveAutomationState({ [key]: Array.from(merged.values()) });
        sendResponse({ success: true });
      } else if (request.action === "getSkippedEntries") {
        // Получение пропущенных записей
        const key = request.mode === 'multi' ? 'skippedEntriesMulti' : 'skippedEntries';
        const entries = (automationState[key] || []).map((entry) => ({
          ...entry,
          entryKey: getSkippedEntryKey(entry)
        }));
        sendResponse({ success: true, entries });
      } else if (request.action === "primeNextDownload") {
        if (!extensionEnabled) {
          sendResponse({ success: false, reason: 'disabled' });
          return;
        }
        // "Бронируем" имя файла для следующего скачивания (для DIV-кнопок без href)
        const { voiceName, scriptName, forceIndex, speakerName } = request;
        const target = await buildDownloadTarget({
          voiceName,
          scriptName,
          forceIndex,
          speakerName,
          downloadLayout: request.downloadLayout || null
        });
        
        nextDownloadConfig = {
            folderName: target.folderName,
            fileNamePrefix: target.fileNamePrefix,
            fileNumber: target.fileNumber,
            downloadLayout: target.downloadLayout,
            tabId: sender.tab?.id ?? null,
            createdAt: Date.now()
        };
        
        console.log(`[Background] Primed next download: ${target.folderName}/${target.fileNumber}`);
        sendResponse({ success: true, fileNumber: target.fileNumber });
      } else if (request.action === "executeInMainWorld") {
        if (!extensionEnabled) {
          sendResponse({ success: false, reason: 'disabled' });
          return;
        }
        const tabId = sender.tab?.id;
        if (!tabId) {
          sendResponse({ success: false, reason: 'no tab id' });
          return;
        }

        // Все функции для MAIN world определены здесь.
        // Функции не могут передаваться через sendMessage — Chrome не сериализует их.
        // Поэтому передаём имя метода (request.method), а функцию берём из этого словаря.
        const slateFunctions = {
          getText: function() {
            var el = document.querySelector('[data-slate-editor="true"]');
            if (!el) return '';
            var fiberKey = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); });
            if (!fiberKey) return '';
            var fiber = el[fiberKey];
            var editor = null;
            for (var i = 0; i < 25; i++) {
              if (!fiber) break;
              if (fiber.memoizedProps && fiber.memoizedProps.editor) { editor = fiber.memoizedProps.editor; break; }
              fiber = fiber.return;
            }
            if (!editor || !editor.children) return '';
            return editor.children.map(function(n) {
              return (n.children || []).map(function(c) { return c.text || ''; }).join('');
            }).join('').trim();
          },

          selectAll: function() {
            var el = document.querySelector('[data-slate-editor="true"]');
            if (!el) return false;
            var fiberKey = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); });
            if (!fiberKey) return false;
            var fiber = el[fiberKey];
            var editor = null;
            for (var i = 0; i < 25; i++) {
              if (!fiber) break;
              if (fiber.memoizedProps && fiber.memoizedProps.editor) { editor = fiber.memoizedProps.editor; break; }
              fiber = fiber.return;
            }
            if (!editor || !editor.children || editor.children.length === 0) return false;
            var lastP = editor.children[editor.children.length - 1];
            var lastT = lastP.children[lastP.children.length - 1];
            editor.selection = {
              anchor: { path: [0, 0], offset: 0 },
              focus: { path: [editor.children.length - 1, lastP.children.length - 1], offset: (lastT.text || '').length }
            };
            return true;
          },

          insertText: function(text) {
            var el = document.querySelector('[data-slate-editor="true"]');
            if (!el) return { ok: false, reason: 'no element' };
            var fiberKey = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); });
            if (!fiberKey) return { ok: false, reason: 'no fiberKey' };
            var fiber = el[fiberKey];
            var editor = null;
            for (var i = 0; i < 25; i++) {
              if (!fiber) break;
              if (fiber.memoizedProps && fiber.memoizedProps.editor) { editor = fiber.memoizedProps.editor; break; }
              fiber = fiber.return;
            }
            if (!editor) return { ok: false, reason: 'no editor in fiber' };

            var currentText = editor.children.map(function(n) {
              return (n.children || []).map(function(c) { return c.text || ''; }).join('');
            }).join('').trim();

            if (currentText.length > 0) {
              var lastP = editor.children[editor.children.length - 1];
              var lastT = lastP.children[lastP.children.length - 1];
              editor.selection = {
                anchor: { path: [0, 0], offset: 0 },
                focus: { path: [editor.children.length - 1, lastP.children.length - 1], offset: (lastT.text || '').length }
              };
            }

            el.focus();

            var ev = new InputEvent('beforeinput', {
              bubbles: true,
              cancelable: true,
              inputType: 'insertText',
              data: text
            });
            el.dispatchEvent(ev);
            return { ok: true };
          },

          clearTextContent: function() {
            var el = document.querySelector('[data-slate-editor="true"]');
            if (!el) return { ok: false, reason: 'no element' };
            var fiberKey = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); });
            if (!fiberKey) return { ok: false, reason: 'no fiberKey' };
            var fiber = el[fiberKey];
            var editor = null;
            for (var i = 0; i < 25; i++) {
              if (!fiber) break;
              if (fiber.memoizedProps && fiber.memoizedProps.editor) { editor = fiber.memoizedProps.editor; break; }
              fiber = fiber.return;
            }
            if (!editor || !editor.children || editor.children.length === 0) {
              return { ok: false, reason: 'no editor' };
            }

            var lastP = editor.children[editor.children.length - 1];
            var lastT = lastP.children[lastP.children.length - 1];
            editor.selection = {
              anchor: { path: [0, 0], offset: 0 },
              focus: { path: [editor.children.length - 1, lastP.children.length - 1], offset: (lastT.text || '').length }
            };
            el.focus();
            el.dispatchEvent(new InputEvent('beforeinput', {
              bubbles: true,
              cancelable: true,
              inputType: 'deleteContentBackward',
              data: null
            }));
            return { ok: true };
          },

          ensureLongTextHistoryCapture: function() {
            if (window.__minimaxLongTextHistoryCapture?.installed) {
              return { ok: true, alreadyInstalled: true };
            }

            var originalOpen = XMLHttpRequest.prototype.open;
            var capture = {
              installed: true,
              snapshot: null,
              capturedAt: 0
            };

            XMLHttpRequest.prototype.open = function(method, url) {
              this.__minimaxHistoryUrl = String(url || '');
              if (!this.__minimaxHistoryHooked) {
                this.__minimaxHistoryHooked = true;
                this.addEventListener('load', function() {
                  if (String(this.__minimaxHistoryUrl || '').indexOf('/v1/api/audio/history_list') < 0) return;
                  try {
                    var payload = JSON.parse(this.responseText || '{}');
                    capture.snapshot = payload;
                    capture.capturedAt = Date.now();
                  } catch (error) {
                    console.warn('[MiniMax Long Text] History response parse failed:', error);
                  }
                });
              }
              return originalOpen.apply(this, arguments);
            };

            capture.reset = function() {
              this.snapshot = null;
              this.capturedAt = 0;
              return { ok: true };
            };
            window.__minimaxLongTextHistoryCapture = capture;
            return { ok: true, alreadyInstalled: false };
          },

          resetLongTextHistoryCapture: function() {
            var capture = window.__minimaxLongTextHistoryCapture;
            if (!capture?.installed || typeof capture.reset !== 'function') {
              return { ok: false, reason: 'history_capture_not_installed' };
            }
            return capture.reset();
          },

          consumeLongTextHistory: async function(tasks, timeout) {
            var capture = window.__minimaxLongTextHistoryCapture;
            if (!capture?.installed) return { ok: false, reason: 'history_capture_not_installed' };
            var startedAt = Date.now();
            var maxWait = Number(timeout) || 10000;

            while (!capture.snapshot && Date.now() - startedAt < maxWait) {
              await new Promise(function(resolve) { setTimeout(resolve, 200); });
            }
            if (!capture.snapshot) return { ok: false, reason: 'history_response_timeout' };

            var list = capture.snapshot?.data?.audio_list;
            if (!Array.isArray(list)) return { ok: false, reason: 'history_list_missing' };

            var claimedIds = new Set();
            (Array.isArray(tasks) ? tasks : []).forEach(function(task) {
              (Array.isArray(task.excludedAudioIds) ? task.excludedAudioIds : []).forEach(function(id) {
                claimedIds.add(String(id));
              });
            });
            var matches = (Array.isArray(tasks) ? tasks : []).map(function(task) {
              var candidates = list.filter(function(item) {
                if (task.audioId) return String(item.audio_id || '') === String(task.audioId);
                if (!task.text) return false;
                var audioId = String(item.audio_id || '');
                var itemText = String(item.text || '').replace(/\s+/g, ' ').trim();
                var taskText = String(task.text || '').replace(/\s+/g, ' ').trim();
                return itemText === taskText && !claimedIds.has(audioId);
              });
              if (!task.audioId && task.voiceId) {
                candidates = candidates.filter(function(item) {
                  var actual = String(item.voice_name || '').trim().toLowerCase();
                  var expected = String(task.voiceId || '').trim().toLowerCase();
                  actual = actual.replace(/\s+/g, ' ');
                  expected = expected.replace(/\s+/g, ' ');
                  if (!expected) return true;
                  if (!actual) return false;
                  return actual === expected
                    || expected.indexOf(actual + ' -') === 0
                    || actual.indexOf(expected + ' -') === 0;
                });
              }
              candidates.sort(function(a, b) {
                if (!task.submittedAt) return Number(b.update_time || 0) - Number(a.update_time || 0);
                return Math.abs(Number(a.update_time || 0) - Number(task.submittedAt))
                  - Math.abs(Number(b.update_time || 0) - Number(task.submittedAt));
              });
              var record = candidates.find(function(item) {
                if (task.audioId || !task.submittedAt) return true;
                return Number(item.update_time || 0) >= Number(task.submittedAt) - 10000;
              }) || null;
              if (!record) return { localId: task.localId, record: null };
              claimedIds.add(String(record.audio_id || ''));
              return {
                localId: task.localId,
                record: {
                  audioId: String(record.audio_id || ''),
                  status: Number(record.status),
                  async: Number(record.async),
                  audioUrl: String(record.audio_url || ''),
                  updateTime: Number(record.update_time || 0),
                  voiceName: String(record.voice_name || ''),
                  hasWav: record.has_wav === true,
                  hasSrt: record.has_srt === true
                }
              };
            });
            return {
              ok: true,
              matches: matches,
              audioIds: list.map(function(item) { return String(item.audio_id || ''); }).filter(Boolean),
              capturedAt: capture.capturedAt
            };
          },

          consumeGeneratedAudioHistory: async function(task, timeout) {
            var capture = window.__minimaxLongTextHistoryCapture;
            if (!capture?.installed) return { ok: false, reason: 'history_capture_not_installed' };
            var startedAt = Date.now();
            var maxWait = Number(timeout) || 60000;
            var taskText = String(task?.text || '').replace(/\s+/g, ' ').trim();
            var expectedVoice = String(task?.voiceId || '').trim().toLowerCase().replace(/\s+/g, ' ');
            var submittedAt = Number(task?.submittedAt || 0);

            while (Date.now() - startedAt < maxWait) {
              var list = capture.snapshot?.data?.audio_list;
              if (Array.isArray(list)) {
                var candidates = list.filter(function(item) {
                  var itemText = String(item.text || '').replace(/\s+/g, ' ').trim();
                  if (!taskText || itemText !== taskText) return false;
                  if (submittedAt && Number(item.update_time || 0) < submittedAt) return false;
                  var actualVoice = String(item.voice_name || '').trim().toLowerCase().replace(/\s+/g, ' ');
                  if (!expectedVoice) return true;
                  if (!actualVoice) return false;
                  return actualVoice === expectedVoice
                    || expectedVoice.indexOf(actualVoice + ' -') === 0
                    || actualVoice.indexOf(expectedVoice + ' -') === 0;
                });
                candidates.sort(function(a, b) {
                  return Number(b.update_time || 0) - Number(a.update_time || 0);
                });
                var record = candidates.find(function(item) {
                  return Number(item.status) === 0 && !!item.audio_url;
                });
                if (record) {
                  return {
                    ok: true,
                    record: {
                      audioId: String(record.audio_id || ''),
                      status: Number(record.status),
                      audioUrl: String(record.audio_url || ''),
                      updateTime: Number(record.update_time || 0),
                      voiceName: String(record.voice_name || '')
                    }
                  };
                }
              }
              await new Promise(function(resolve) { setTimeout(resolve, 200); });
            }

            return { ok: false, reason: 'generated_audio_history_timeout' };
          },

          ensureAudioCaptureInstalled: function() {
            function buildSession() {
              return {
                resetAt: Date.now(),
                state: 'started',
                cancelled: false,
                blob: null,
                blobType: '',
                blobUrl: '',
                mediaSource: null,
                mediaSourceUrl: '',
                sourceBufferTypes: [],
                chunks: [],
                totalBytes: 0,
                firstChunkAt: 0,
                lastChunkAt: 0,
                endedAt: 0,
                finalSignalAt: 0,
                finalSignalKind: ''
              };
            }

            if (window.__minimaxAudioCapture && window.__minimaxAudioCapture.installed) {
              return { ok: true, alreadyInstalled: true };
            }

            if (typeof MediaSource === 'undefined' || !MediaSource.prototype) {
              return { ok: false, reason: 'mediasource_unavailable' };
            }

            var originalCreateObjectURL = URL.createObjectURL.bind(URL);
            var originalAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
            var originalEndOfStream = MediaSource.prototype.endOfStream;
            var originalWebSocketDispatchEvent = typeof WebSocket !== 'undefined' && WebSocket.prototype
              ? WebSocket.prototype.dispatchEvent
              : null;
            var mediaSourceSessions = new WeakMap();
            var sourceBufferSessions = new WeakMap();

            function shouldCaptureBlob(blob) {
              if (!(blob instanceof Blob)) return false;
              var type = String(blob.type || '').toLowerCase();
              return type.indexOf('audio/') === 0 || type.indexOf('mpeg') >= 0 || type.indexOf('mp3') >= 0;
            }

            function normalizeChunk(data) {
              if (!data) return null;
              var view = data instanceof Uint8Array ? data : new Uint8Array(data);
              return view.slice ? view.slice(0) : new Uint8Array(view);
            }

            function registerMediaSourceSession(mediaSource, session, url) {
              session.mediaSource = mediaSource;
              session.mediaSourceUrl = url;
              session.state = 'receiving_chunks';
              mediaSourceSessions.set(mediaSource, session);
            }

            function markFinalSignal(kind) {
              var session = capture && capture.activeSession;
              if (!session) return;
              session.finalSignalAt = Date.now();
              session.finalSignalKind = kind || 'unknown';
              if (session.state !== 'stream_closed') {
                session.state = 'terminal_signal_seen';
              }
            }

            function inspectWebSocketPayload(payload) {
              if (!payload || typeof payload !== 'object') return;
              if (payload.extra_info) {
                markFinalSignal('extra_info');
                return;
              }
              if (payload.base_resp && (payload.base_resp.status_code === 0 || payload.base_resp.code === 0) && payload.data && !payload.input_sensitive) {
                if (payload.data.finish_reason || payload.data.is_final || payload.data.completed) {
                  markFinalSignal('data_final');
                }
              }
            }

            function blobToDataUrl(blob) {
              return new Promise(function(resolve, reject) {
                var reader = new FileReader();
                reader.onloadend = function() { resolve(reader.result); };
                reader.onerror = function() { reject(reader.error || new Error('blob read failed')); };
                reader.readAsDataURL(blob);
              });
            }

            function isGenerationUiBusy() {
              var buttons = Array.from(document.querySelectorAll('button'));
              return buttons.some(function(btn) {
                var text = String(btn.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
                if (!text) return false;
                var isGenerateButton = text.indexOf('generate') >= 0 || text.indexOf('regenerate') >= 0 || text.indexOf('generating') >= 0;
                if (!isGenerateButton) return false;
                return text.indexOf('generating') >= 0 || !!btn.disabled || btn.classList.contains('opacity-60');
              });
            }

            var capture = {
              installed: true,
              activeSession: buildSession(),
              resetSession: function() {
                if (this.activeSession) this.activeSession.cancelled = true;
                this.activeSession = buildSession();
                return { ok: true, resetAt: this.activeSession.resetAt };
              },
              consumeCapturedAudio: async function(timeout) {
                var maxWait = Number(timeout) || 10000;
                var startedAt = Date.now();
                var session = this.activeSession;

                while (Date.now() - startedAt < maxWait) {
                  if (session.cancelled) {
                    return { ok: false, reason: 'capture_cancelled', state: session.state };
                  }
                  if (session.blob && session.blob.size > 0) {
                    session.state = 'ready_to_consume';
                    return {
                      ok: true,
                      source: 'blob',
                      completionReason: 'blob_ready',
                      src: session.blobUrl || '',
                      size: session.blob.size,
                      terminalSignalSeen: !!session.finalSignalAt,
                      streamClosed: !!session.endedAt,
                      dataUrl: await blobToDataUrl(session.blob)
                    };
                  }

                  if (session.chunks.length > 0) {
                    var quietForMs = session.lastChunkAt ? (Date.now() - session.lastChunkAt) : 0;
                    var hasFinalSignal = !!session.finalSignalAt;
                    var streamClosed = !!session.endedAt;
                    var websocketFinished = hasFinalSignal && quietForMs > 1500;
                    if (streamClosed || websocketFinished) {
                      var audioType = session.sourceBufferTypes.find(function(type) {
                        return String(type || '').toLowerCase().indexOf('audio/') === 0;
                      }) || 'audio/mpeg';
                      var chunkBlob = new Blob(session.chunks, { type: audioType });
                      if (chunkBlob.size > 0) {
                        session.state = 'ready_to_consume';
                        return {
                          ok: true,
                          source: 'mediasource',
                          completionReason: streamClosed
                            ? 'endofstream'
                            : ('ws_' + (session.finalSignalKind || 'final')),
                          src: session.mediaSourceUrl || '',
                          size: chunkBlob.size,
                          chunkCount: session.chunks.length,
                          quietForMs: quietForMs,
                          terminalSignalSeen: hasFinalSignal,
                          streamClosed: streamClosed,
                          dataUrl: await blobToDataUrl(chunkBlob)
                        };
                      }
                    }
                  }

                  await new Promise(function(resolve) { setTimeout(resolve, 250); });
                }

                return {
                  ok: false,
                  reason: session.totalBytes > 0
                    ? (session.finalSignalAt || session.endedAt ? 'generation_stalled_after_audio' : 'final_signal_missing')
                    : 'generation_never_started',
                  state: session.state,
                  src: session.blobUrl || session.mediaSourceUrl || '',
                  chunkCount: session.chunks.length,
                  totalBytes: session.totalBytes,
                  terminalSignalSeen: !!session.finalSignalAt,
                  streamClosed: !!session.endedAt,
                  sourceBufferTypes: session.sourceBufferTypes
                };
              }
            };

            URL.createObjectURL = function(object) {
              var url = originalCreateObjectURL(object);
              var session = capture.activeSession;

              try {
                if (shouldCaptureBlob(object)) {
                  session.blob = object;
                  session.blobType = object.type || 'audio/mpeg';
                  session.blobUrl = url;
                } else if (object instanceof MediaSource) {
                  registerMediaSourceSession(object, session, url);
                }
              } catch (error) {
                console.warn('[MiniMax Capture] createObjectURL hook failed:', error);
              }

              return url;
            };

            MediaSource.prototype.addSourceBuffer = function(mimeType) {
              var sourceBuffer = originalAddSourceBuffer.apply(this, arguments);

              try {
                var session = mediaSourceSessions.get(this);
                if (session) {
                  session.sourceBufferTypes.push(String(mimeType || ''));

                  if (!sourceBufferSessions.has(sourceBuffer)) {
                    sourceBufferSessions.set(sourceBuffer, session);
                    var originalAppendBuffer = sourceBuffer.appendBuffer;
                    sourceBuffer.appendBuffer = function(data) {
                      var targetSession = sourceBufferSessions.get(sourceBuffer);
                      if (targetSession) {
                        var chunk = normalizeChunk(data);
                        if (chunk && chunk.byteLength > 0) {
                          if (!targetSession.firstChunkAt) {
                            targetSession.firstChunkAt = Date.now();
                          }
                          targetSession.state = 'receiving_chunks';
                          targetSession.chunks.push(chunk);
                          targetSession.totalBytes += chunk.byteLength;
                          targetSession.lastChunkAt = Date.now();
                        }
                      }
                      return originalAppendBuffer.apply(this, arguments);
                    };
                  }
                }
              } catch (error) {
                console.warn('[MiniMax Capture] addSourceBuffer hook failed:', error);
              }

              return sourceBuffer;
            };

            MediaSource.prototype.endOfStream = function() {
              try {
                var session = mediaSourceSessions.get(this);
                if (session) {
                  session.endedAt = Date.now();
                  session.state = 'stream_closed';
                }
              } catch (error) {
                console.warn('[MiniMax Capture] endOfStream hook failed:', error);
              }

              return originalEndOfStream.apply(this, arguments);
            };

            if (originalWebSocketDispatchEvent) {
              WebSocket.prototype.dispatchEvent = function(event) {
                try {
                  if (event && event.type === 'message' && typeof event.data === 'string') {
                    var trimmed = event.data.trim();
                    if (trimmed && (trimmed[0] === '{' || trimmed[0] === '[')) {
                      inspectWebSocketPayload(JSON.parse(trimmed));
                    }
                  }
                } catch (error) {
                  console.warn('[MiniMax Capture] websocket hook failed:', error);
                }
                return originalWebSocketDispatchEvent.apply(this, arguments);
              };
            }

            window.__minimaxAudioCapture = capture;
            return { ok: true, alreadyInstalled: false };
          },

          resetAudioCaptureSession: function() {
            var capture = window.__minimaxAudioCapture;
            if (!capture || !capture.installed || typeof capture.resetSession !== 'function') {
              return { ok: false, reason: 'capture_not_installed' };
            }
            return capture.resetSession();
          },

          consumeCapturedAudio: async function(timeout) {
            var capture = window.__minimaxAudioCapture;
            if (!capture || !capture.installed || typeof capture.consumeCapturedAudio !== 'function') {
              return { ok: false, reason: 'capture_not_installed' };
            }
            return await capture.consumeCapturedAudio(timeout);
          },

        };

        const func = slateFunctions[request.method];
        if (!func) {
          sendResponse({ success: false, reason: 'unknown method: ' + request.method });
          return;
        }

        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId: tabId },
            world: 'MAIN',
            func: func,
            args: request.args || []
          });
          sendResponse({ success: true, result: results[0]?.result });
        } catch (e) {
          sendResponse({ success: false, reason: e.message });
        }
      }
    } catch (error) {
      console.error('Error:', error);
      sendResponse({ success: false, reason: error.message });
    }
  })();

  return true;
});

// Функция удалена - теперь пользователь сам отмечает записи как готовые через кнопку

// ============================================
// BATCH MANAGER (Очередь файлов с персистентным хранением)
// ============================================

// В Manifest V3 Service Worker "усыпляется" через ~30 секунд бездействия.
// Все переменные в памяти сбрасываются. Храним состояние в chrome.storage.local.

const MINIMAX_TTS_URL = 'https://www.minimax.io/audio/text-to-speech';
const LONG_TEXT_ALARM = 'longTextHistoryPoll';

function getDefaultLongTextState() {
  return {
    tasks: [],
    baselineAudioIds: [],
    monitorTabId: null,
    isSubmitting: false,
    updatedAt: null
  };
}

let longTextState = getDefaultLongTextState();

async function loadLongTextState() {
  const data = await chrome.storage.local.get('longTextState');
  longTextState = data.longTextState || getDefaultLongTextState();
  return longTextState;
}

async function saveLongTextState() {
  longTextState.updatedAt = Date.now();
  const activeTasks = longTextState.tasks.filter((task) => {
    return ['queued', 'submitting', 'awaiting_match', 'pending', 'ready', 'downloading'].includes(task.status);
  });
  const finishedTasks = longTextState.tasks.filter((task) => !activeTasks.includes(task)).slice(-100);
  longTextState.tasks = [...finishedTasks, ...activeTasks];
  await chrome.storage.local.set({ longTextState });
}

function getLongTextSummary() {
  const tasks = Array.isArray(longTextState.tasks) ? longTextState.tasks : [];
  const count = (statuses) => tasks.filter((task) => statuses.includes(task.status)).length;
  return {
    total: tasks.length,
    queued: count(['queued', 'submitting']),
    pending: count(['awaiting_match', 'pending']),
    ready: count(['ready', 'downloading']),
    completed: count(['completed']),
    failed: count(['error']),
    isSubmitting: longTextState.isSubmitting === true,
    hasActive: count(['queued', 'submitting', 'awaiting_match', 'pending', 'ready', 'downloading']) > 0
  };
}

function broadcastLongTextProgress() {
  chrome.runtime.sendMessage({
    action: 'longTextProgress',
    summary: getLongTextSummary()
  }).catch(() => {});
}

function partitionLongTextJobs(jobs) {
  const longTextEntries = [];
  const regularJobs = [];

  (Array.isArray(jobs) ? jobs : []).forEach((job) => {
    const regularQueue = [];
    (Array.isArray(job.queue) ? job.queue : []).forEach((entry) => {
      const length = String(entry.text || '').length;
      if (length > 5000 && length <= 200000) {
        longTextEntries.push({ ...entry, mode: job.mode, scriptName: entry.scriptName || job.scriptName || null });
        return;
      }
      regularQueue.push(entry);
    });
    if (regularQueue.length > 0) regularJobs.push({ ...job, queue: regularQueue });
  });

  return { longTextEntries, regularJobs };
}

function createLongTextTask(entry) {
  return {
    localId: `long-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    status: 'queued',
    text: String(entry.text || ''),
    preview: String(entry.text || '').slice(0, 160),
    audioId: null,
    audioUrl: null,
    serverStatus: null,
    submittedAt: null,
    completedAt: null,
    error: null,
    voiceId: entry.voiceId || null,
    voiceName: entry.originalTag || entry.speaker || 'dictor',
    speakerName: entry.speaker || null,
    language: entry.language || 'Auto',
    scriptName: entry.scriptName || null,
    downloadIndex: entry.downloadIndex || entry.speakerIndex || null,
    downloadLayout: entry.downloadLayout || null,
    sourceFileName: entry.sourceFileName || null,
    sourceFileBaseName: entry.sourceFileBaseName || null,
    mode: entry.mode || 'single'
  };
}

function applyLongTextHistoryRecord(task, record) {
  if (!task || !record) return;
  task.audioId = record.audioId || task.audioId;
  task.serverStatus = record.status;
  task.hasWav = record.hasWav === true;
  task.hasSrt = record.hasSrt === true;
  task.lastSeenAt = Date.now();
  task.error = null;
  if (task.audioId) task.text = null;

  if (record.status === 0 && record.audioUrl) {
    task.audioUrl = record.audioUrl;
    task.status = 'ready';
    return;
  }
  if (record.status === 1) {
    task.status = 'pending';
    return;
  }
  task.status = 'error';
  task.error = `MiniMax returned Long Text status ${record.status}`;
}

async function ensureLongTextAlarm() {
  const summary = getLongTextSummary();
  if (!summary.hasActive || longTextState.isSubmitting) return;
  await chrome.alarms.create(LONG_TEXT_ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
}

async function initializeLongTextState() {
  await loadLongTextState();
  const hasInterruptedSubmissions = longTextState.tasks.some((task) => {
    return task.status === 'queued' || task.status === 'submitting';
  });
  if (longTextState.isSubmitting || hasInterruptedSubmissions) {
    longTextState.isSubmitting = false;
    longTextState.tasks.forEach((task) => {
      if (task.status !== 'queued' && task.status !== 'submitting') return;
      if (task.status === 'submitting' && task.submittedAt) {
        task.status = 'awaiting_match';
        task.error = null;
        return;
      }
      task.status = 'error';
      task.error = 'Long Text submission was interrupted before confirmation';
    });
    await saveLongTextState();
  }
  await ensureLongTextAlarm();
}

async function stopLongTextAlarmIfIdle() {
  if (getLongTextSummary().hasActive) return;
  await chrome.alarms.clear(LONG_TEXT_ALARM);
}

async function submitLongTextEntries(entries, tabId) {
  if (!Array.isArray(entries) || entries.length === 0) return { submitted: 0, failed: 0 };

  const baselineResponse = await sendTabMessageWithTimeout(tabId, {
    action: 'queryLongTextHistory',
    tasks: []
  }, 30000);
  if (!baselineResponse?.success) {
    throw new Error(baselineResponse?.reason || 'long_text_history_preflight_failed');
  }

  const tasks = entries.map(createLongTextTask);
  longTextState.tasks = tasks;
  longTextState.baselineAudioIds = Array.isArray(baselineResponse.audioIds) ? baselineResponse.audioIds : [];
  longTextState.monitorTabId = tabId;
  longTextState.isSubmitting = true;
  await saveLongTextState();
  broadcastLongTextProgress();

  let restoreError = null;
  try {
    for (const task of tasks) {
      task.status = 'submitting';
      task.submittedAt = Date.now();
      await saveLongTextState();
      broadcastLongTextProgress();

      try {
        const response = await sendTabMessageWithTimeout(tabId, {
          action: 'submitLongText',
          task: {
            localId: task.localId,
            text: task.text,
            voiceId: task.voiceId,
            language: task.language
          }
        }, 120000);
        if (!response?.success) {
          task.status = 'error';
          task.error = response?.reason || 'long_text_submit_failed';
        } else {
          task.submittedAt = response.submittedAt || Date.now();
          task.status = 'awaiting_match';
          task.error = null;

          try {
            const claimedAudioIds = longTextState.tasks.map((item) => item.audioId).filter(Boolean);
            const unmatchedTasks = longTextState.tasks
              .filter((item) => item.status === 'awaiting_match')
              .sort((a, b) => Number(a.submittedAt || 0) - Number(b.submittedAt || 0));
            const historyResponse = await sendTabMessageWithTimeout(tabId, {
              action: 'queryLongTextHistory',
              tasks: unmatchedTasks.map((item) => ({
                localId: item.localId,
                text: item.text,
                voiceId: item.voiceId,
                submittedAt: item.submittedAt,
                excludedAudioIds: [...(longTextState.baselineAudioIds || []), ...claimedAudioIds]
              }))
            }, 30000);
            if (historyResponse?.success) {
              (historyResponse.matches || []).forEach((match) => {
                const matchedTask = longTextState.tasks.find((item) => item.localId === match.localId);
                if (match.record) applyLongTextHistoryRecord(matchedTask, match.record);
              });
            }
          } catch (error) {
            console.warn('[Background] Long Text accepted but not matched yet:', error);
          }
        }
      } catch (error) {
        task.status = 'awaiting_match';
        task.error = error.message;
      }

      await saveLongTextState();
      broadcastLongTextProgress();
    }
  } finally {
    longTextState.isSubmitting = false;
    try {
      await sendTabMessageWithTimeout(tabId, { action: 'resetLongTextMode' }, 15000);
    } catch (error) {
      console.warn('[Background] Failed to restore regular text mode:', error);
      restoreError = error;
    }
    await saveLongTextState();
    await ensureLongTextAlarm();
    broadcastLongTextProgress();
  }

  if (restoreError) {
    throw new Error(`Long Text submitted, but regular mode was not restored: ${restoreError.message}`);
  }

  return {
    submitted: tasks.filter((task) => task.status !== 'error').length,
    failed: tasks.filter((task) => task.status === 'error').length
  };
}

async function findLongTextMonitorTab() {
  if (longTextState.monitorTabId) {
    try {
      const tab = await chrome.tabs.get(longTextState.monitorTabId);
      if (String(tab.url || '').startsWith(MINIMAX_TTS_URL)) return tab.id;
    } catch (error) {
      // Fall through to another open MiniMax tab.
    }
  }
  const tabs = await chrome.tabs.query({ url: `${MINIMAX_TTS_URL}*` });
  return tabs[0]?.id || null;
}

async function confirmLongTextDownload(task) {
  if (!task.downloadId) {
    const startedAt = Number(task.downloadStartedAt || 0);
    if (!startedAt) {
      task.status = 'ready';
      return;
    }
    const recentItems = await chrome.downloads.search({
      startedAfter: new Date(startedAt - 5000).toISOString()
    });
    const matchingDownload = recentItems.find((item) => item.url === task.audioUrl && item.state !== 'interrupted');
    if (matchingDownload) {
      task.downloadId = matchingDownload.id;
    } else if (Date.now() - startedAt > 60000) {
      task.status = 'ready';
      task.downloadStartedAt = null;
      return;
    } else {
      return;
    }
  }
  const items = await chrome.downloads.search({ id: task.downloadId });
  const item = items[0];
  if (!item || item.error || item.state === 'interrupted') {
    task.status = 'ready';
    task.downloadId = null;
    task.downloadStartedAt = null;
    task.error = item?.error || 'download_interrupted';
    return;
  }
  if (item.state !== 'complete') return;

  task.status = 'completed';
  task.completedAt = Date.now();
  task.error = null;
  if (!task.historySaved) {
    await saveToDownloadHistory(task.folderName, task.targetFilename, task.fileNumber);
    task.historySaved = true;
  }
}

async function downloadReadyLongTextTask(task) {
  if (!isValidAudioUrl(task.audioUrl)) throw new Error('invalid_long_text_audio_url');
  const target = await buildDownloadTarget({
    voiceName: task.voiceName,
    scriptName: task.scriptName,
    forceIndex: task.downloadIndex,
    speakerName: task.speakerName,
    downloadLayout: task.downloadLayout,
    sourceFileName: task.sourceFileName,
    sourceFileBaseName: task.sourceFileBaseName
  });

  task.status = 'downloading';
  task.downloadStartedAt = Date.now();
  task.folderName = target.folderName;
  task.targetFilename = target.newFilename;
  task.fileNumber = target.fileNumber;
  task.error = null;
  await saveLongTextState();

  const namedReservation = reserveNamedDownload(task.audioUrl, target.newFilename);
  try {
    task.downloadId = await chrome.downloads.download({
      url: task.audioUrl,
      filename: target.newFilename,
      conflictAction: 'uniquify',
      saveAs: false
    });
  } catch (error) {
    releaseNamedDownload(namedReservation);
    throw error;
  }
  await saveLongTextState();
  await confirmLongTextDownload(task);
}

async function pollLongTextTasks() {
  await Promise.all([loadLongTextState(), loadBatchState(), loadParallelBatchState()]);
  if (longTextState.isSubmitting || batchState.isRunning || parallelBatchState.isRunning) return;

  const activeTasks = longTextState.tasks.filter((task) => {
    return ['awaiting_match', 'pending', 'ready', 'downloading'].includes(task.status);
  });
  if (activeTasks.length === 0) {
    await stopLongTextAlarmIfIdle();
    return;
  }

  const tabId = await findLongTextMonitorTab();
  if (!tabId) return;
  longTextState.monitorTabId = tabId;

  const pendingTasks = activeTasks.filter((task) => {
    return task.status === 'awaiting_match' || task.status === 'pending';
  });
  if (pendingTasks.length > 0) {
    const claimedAudioIds = longTextState.tasks.map((task) => task.audioId).filter(Boolean);
    const response = await sendTabMessageWithTimeout(tabId, {
      action: 'queryLongTextHistory',
      tasks: pendingTasks.map((task) => ({
        localId: task.localId,
        audioId: task.audioId,
        text: task.text,
        voiceId: task.voiceId,
        submittedAt: task.submittedAt,
        excludedAudioIds: [...(longTextState.baselineAudioIds || []), ...claimedAudioIds]
      }))
    }, 30000);
    if (!response?.success) throw new Error(response?.reason || 'long_text_history_poll_failed');

    (response.matches || []).forEach((match) => {
      const task = longTextState.tasks.find((item) => item.localId === match.localId);
      if (!task) return;
      task.pollAttempts = Number(task.pollAttempts || 0) + 1;
      if (match.record) applyLongTextHistoryRecord(task, match.record);
      const submittedAt = Number(task.submittedAt || 0);
      if (!match.record && submittedAt && Date.now() - submittedAt > 24 * 60 * 60 * 1000) {
        task.status = 'error';
        task.error = 'Long Text task was not found in History within 24 hours';
      }
    });
  }

  for (const task of longTextState.tasks.filter((item) => item.status === 'downloading')) {
    await confirmLongTextDownload(task);
  }
  for (const task of longTextState.tasks.filter((item) => item.status === 'ready')) {
    try {
      await downloadReadyLongTextTask(task);
    } catch (error) {
      task.status = 'ready';
      task.error = error.message;
    }
  }

  await saveLongTextState();
  await stopLongTextAlarmIfIdle();
  broadcastLongTextProgress();
}

function getDefaultParallelBatchState() {
  return {
    isRunning: false,
    isPaused: false,
    isFallingBack: false,
    runId: null,
    primaryTabId: null,
    secondaryTabId: null,
    originalJobs: [],
    workers: [],
    startedAt: null
  };
}

let parallelBatchState = getDefaultParallelBatchState();
let parallelOperationQueue = Promise.resolve();

function queueParallelOperation(operation) {
  const result = parallelOperationQueue.then(operation);
  parallelOperationQueue = result.catch(() => {});
  return result;
}

async function loadParallelBatchState() {
  const data = await chrome.storage.local.get('parallelBatchState');
  parallelBatchState = data.parallelBatchState || getDefaultParallelBatchState();
  return parallelBatchState;
}

async function saveParallelBatchState() {
  await chrome.storage.local.set({ parallelBatchState });
}

function annotateParallelJobs(jobs) {
  return (Array.isArray(jobs) ? jobs : []).map((job, jobIndex) => ({
    ...job,
    queue: (Array.isArray(job.queue) ? job.queue : []).map((entry, entryIndex) => ({
      ...entry,
      _parallelKey: entry._parallelKey || `${jobIndex}:${entryIndex}:${entry.id || 'entry'}`
    }))
  }));
}

function buildParallelPlan(jobs) {
  const groups = new Map();

  jobs.forEach((job) => {
    job.queue.forEach((entry) => {
      const voiceId = String(entry.voiceId || '').trim();
      if (!voiceId) return;
      if (!groups.has(voiceId)) groups.set(voiceId, []);
      groups.get(voiceId).push(entry);
    });
  });

  const totalEntries = jobs.reduce((total, job) => total + job.queue.length, 0);
  const mappedEntries = [...groups.values()].reduce((total, entries) => total + entries.length, 0);
  if (mappedEntries !== totalEntries) {
    return { ok: false, reason: 'Для двух потоков нужны голоса у всех реплик' };
  }
  if (groups.size < 2) {
    return { ok: false, reason: 'Для двух потоков нужны минимум два разных голоса' };
  }

  const workers = [
    { workerId: 'worker-1', queue: [], weight: 0 },
    { workerId: 'worker-2', queue: [], weight: 0 }
  ];
  const sortedGroups = [...groups.entries()].sort((a, b) => {
    const weightA = a[1].reduce((sum, entry) => sum + String(entry.text || '').length, 0);
    const weightB = b[1].reduce((sum, entry) => sum + String(entry.text || '').length, 0);
    return weightB - weightA;
  });

  sortedGroups.forEach(([, entries]) => {
    const target = workers[0].weight <= workers[1].weight ? workers[0] : workers[1];
    target.queue.push(...entries);
    target.weight += entries.reduce((sum, entry) => sum + String(entry.text || '').length, 0);
  });

  if (workers.some((worker) => worker.queue.length === 0)) {
    return { ok: false, reason: 'Не удалось равномерно разделить очередь' };
  }

  return { ok: true, workers };
}

function getParallelQueueSnapshot(queue) {
  return (Array.isArray(queue) ? queue : []).map((entry) => ({
    _parallelKey: entry._parallelKey,
    id: entry.id,
    status: entry.status || 'pending',
    downloadConfirmed: entry.downloadConfirmed === true,
    error: entry.error || null
  }));
}

async function waitForParallelTab(tabId, timeoutMs = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') {
        const health = await sendTabMessageWithTimeout(tabId, { action: 'parallelHealthCheck' }, 7000);
        if (health?.success) return health;
      }
    } catch (error) {
      // Content script may not be injected yet.
    }
    await sleep(500);
  }
  throw new Error('Вторая вкладка MiniMax не готова');
}

async function closeTabSafely(tabId) {
  if (!tabId) return;
  try {
    await chrome.tabs.remove(tabId);
  } catch (error) {
    // The tab may already be closed.
  }
}

function sendTabMessageWithTimeout(tabId, message, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Tab message timed out: ${message.action}`)), timeoutMs);
    chrome.tabs.sendMessage(tabId, message).then(
      (response) => {
        clearTimeout(timer);
        resolve(response);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function getParallelProgress() {
  const workers = parallelBatchState.workers || [];
  const completedIds = workers.flatMap((worker) => (worker.queue || [])
    .filter((entry) => entry.status === 'completed' || entry.downloadConfirmed)
    .map((entry) => entry.id));
  const currentIndex = workers.reduce((sum, worker) => sum + Number(worker.currentIndex || 0), 0);
  const total = workers.reduce((sum, worker) => sum + Number(worker.total || 0), 0);
  return {
    currentIndex,
    total,
    completedIds,
    isRunning: parallelBatchState.isRunning,
    isPaused: parallelBatchState.isPaused,
    workerCount: workers.length
  };
}

async function broadcastParallelProgress() {
  const progress = getParallelProgress();
  await saveAutomationState({ progress, mode: 'multi' });
  chrome.runtime.sendMessage({
    action: 'parallelBatchProgress',
    runId: parallelBatchState.runId,
    progress,
    workers: parallelBatchState.workers.map((worker) => ({
      workerId: worker.workerId,
      currentIndex: worker.currentIndex,
      total: worker.total,
      status: worker.status
    }))
  }).catch(() => {});
}

function buildRemainingParallelJobs() {
  const completedKeys = new Set((parallelBatchState.workers || []).flatMap((worker) => {
    return (worker.queue || [])
      .filter((entry) => entry.status === 'completed'
        || entry.status === 'skipped_manual'
        || entry.status === 'skipped_voice_not_found'
        || entry.downloadConfirmed)
      .map((entry) => entry._parallelKey);
  }));

  return (parallelBatchState.originalJobs || [])
    .map((job) => ({
      ...job,
      queue: job.queue.filter((entry) => !completedKeys.has(entry._parallelKey))
    }))
    .filter((job) => job.queue.length > 0);
}

async function finishParallelBatch() {
  const secondaryTabId = parallelBatchState.secondaryTabId;
  parallelBatchState = getDefaultParallelBatchState();
  await saveParallelBatchState();
  await chrome.alarms.clear('parallelBatchWatchdog');
  await closeTabSafely(secondaryTabId);
  await saveAutomationState({
    progress: { currentIndex: 0, total: 0, completedIds: [], isRunning: false, isPaused: false, workerCount: 0 },
    mode: 'multi'
  });
  chrome.runtime.sendMessage({ action: 'parallelBatchComplete' }).catch(() => {});
}

async function fallbackParallelBatch(reason) {
  await loadParallelBatchState();
  if (!parallelBatchState.isRunning || parallelBatchState.isFallingBack) return;

  parallelBatchState.isFallingBack = true;
  await saveParallelBatchState();

  const primaryTabId = parallelBatchState.primaryTabId;
  const secondaryTabId = parallelBatchState.secondaryTabId;
  await Promise.allSettled((parallelBatchState.workers || []).map((worker) => {
    return sendTabMessageWithTimeout(worker.tabId, {
      action: 'stopAutomation',
      runId: parallelBatchState.runId,
      workerId: worker.workerId
    }, 7000);
  }));
  await sleep(500);

  const remainingJobs = buildRemainingParallelJobs();
  parallelBatchState = getDefaultParallelBatchState();
  await saveParallelBatchState();
  await chrome.alarms.clear('parallelBatchWatchdog');
  await closeTabSafely(secondaryTabId);

  if (remainingJobs.length === 0) {
    await finishParallelBatch();
    return;
  }

  await ensureAutomationStateLoaded();
  await saveAutomationState({
    progress: { ...(automationState.progress || {}), workerCount: 1 }
  });
  await startLegacyBatchProcessing(remainingJobs, primaryTabId);
  chrome.runtime.sendMessage({
    action: 'parallelBatchFallback',
    reason,
    remaining: remainingJobs.reduce((sum, job) => sum + job.queue.length, 0)
  }).catch(() => {});
}

async function updateParallelWorker(request, sender, isComplete = false) {
  await loadParallelBatchState();
  if (!parallelBatchState.isRunning || request.runId !== parallelBatchState.runId) return;

  const worker = parallelBatchState.workers.find((item) => item.workerId === request.workerId);
  if (!worker || (sender.tab?.id && worker.tabId !== sender.tab.id)) return;

  worker.queue = Array.isArray(request.queue) ? getParallelQueueSnapshot(request.queue) : worker.queue;
  worker.currentIndex = Number(request.currentIndex ?? request.completed ?? worker.currentIndex ?? 0);
  worker.total = worker.queue.length;
  worker.lastProgressAt = Date.now();
  if (isComplete) worker.status = 'complete';
  await saveParallelBatchState();
  await broadcastParallelProgress();

  if (!isComplete) return;
  const hasErrors = worker.queue.some((entry) => entry.status === 'error');
  if (hasErrors) {
    await fallbackParallelBatch('Один из потоков завершился с ошибкой');
    return;
  }
  if (parallelBatchState.workers.every((item) => item.status === 'complete')) {
    await finishParallelBatch();
  }
}

async function startParallelBatchProcessing(jobs, primaryTabId) {
  await Promise.all([loadBatchState(), loadParallelBatchState()]);
  if (batchState.isRunning || parallelBatchState.isRunning) {
    return { success: false, reason: 'automation_already_running' };
  }

  const originalJobs = annotateParallelJobs(jobs);
  const plan = buildParallelPlan(originalJobs);
  if (!plan.ok) {
    await startLegacyBatchProcessing(originalJobs, primaryTabId);
    return { success: true, parallel: false, fallback: true, reason: plan.reason };
  }

  let secondaryTab = null;
  try {
    await waitForParallelTab(primaryTabId, 10000);
    secondaryTab = await chrome.tabs.create({ url: MINIMAX_TTS_URL, active: false });
    await waitForParallelTab(secondaryTab.id);

    const runId = `parallel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const workers = plan.workers.map((worker, index) => ({
      ...worker,
      tabId: index === 0 ? primaryTabId : secondaryTab.id,
      currentIndex: 0,
      total: worker.queue.length,
      status: 'preparing',
      lastProgressAt: Date.now()
    }));

    await Promise.all(workers.map((worker) => {
      const firstEntry = worker.queue[0];
      return sendTabMessageWithTimeout(worker.tabId, {
        action: 'prepareParallelWorker',
        voiceId: firstEntry.voiceId,
        language: firstEntry.language || 'Auto'
      }, 30000).then((response) => {
        if (!response?.success) throw new Error(response?.reason || 'Worker preflight failed');
      });
    }));

    parallelBatchState = {
      isRunning: true,
      isPaused: false,
      isFallingBack: false,
      runId,
      primaryTabId,
      secondaryTabId: secondaryTab.id,
      originalJobs,
      workers: workers.map((worker) => ({
        ...worker,
        queue: getParallelQueueSnapshot(worker.queue),
        status: 'running'
      })),
      startedAt: Date.now()
    };
    await saveParallelBatchState();
    await chrome.alarms.create('parallelBatchWatchdog', { periodInMinutes: 0.5 });
    await broadcastParallelProgress();

    const startResults = await Promise.all(workers.map((worker) => {
      return sendTabMessageWithTimeout(worker.tabId, {
        action: 'startAutomation',
        queue: worker.queue,
        mode: 'multi',
        scriptName: null,
        runId,
        workerId: worker.workerId
      }, 10000);
    }));
    if (startResults.some((response) => !response?.success)) {
      throw new Error('Один из потоков не принял очередь');
    }

    return { success: true, parallel: true, runId, workerCount: workers.length };
  } catch (error) {
    if (parallelBatchState.isRunning) {
      await fallbackParallelBatch(error.message);
      return { success: true, parallel: false, fallback: true, reason: error.message };
    }
    await closeTabSafely(secondaryTab?.id);
    await startLegacyBatchProcessing(originalJobs, primaryTabId);
    return { success: true, parallel: false, fallback: true, reason: error.message };
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'parallelBatchWatchdog') return;
  queueParallelOperation(async () => {
    await loadParallelBatchState();
    if (!parallelBatchState.isRunning || parallelBatchState.isFallingBack) return;

    const now = Date.now();
    for (const worker of parallelBatchState.workers) {
      if (worker.status === 'complete') continue;
      if (!parallelBatchState.isPaused && now - Number(worker.lastProgressAt || parallelBatchState.startedAt || now) > 360000) {
        await fallbackParallelBatch('Поток не сообщил о прогрессе более 360 секунд');
        return;
      }
      try {
        const runtime = await sendTabMessageWithTimeout(worker.tabId, { action: 'getAutomationRuntimeState' }, 7000);
        if (!runtime?.success || !runtime.state?.isRunning || runtime.state.runId !== parallelBatchState.runId) {
          throw new Error('Worker runtime unavailable');
        }
      } catch (error) {
        await fallbackParallelBatch('Одна из вкладок перестала отвечать');
        return;
      }
    }
  }).catch((error) => console.error('[Background] Parallel watchdog failed:', error));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== LONG_TEXT_ALARM) return;
  queueParallelOperation(() => pollLongTextTasks()).catch((error) => {
    console.error('[Background] Long Text polling failed:', error);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  queueParallelOperation(async () => {
    await loadParallelBatchState();
    if (!parallelBatchState.isRunning) return;
    if (!parallelBatchState.workers.some((worker) => worker.tabId === tabId)) return;

    if (tabId === parallelBatchState.primaryTabId && parallelBatchState.secondaryTabId) {
      parallelBatchState.primaryTabId = parallelBatchState.secondaryTabId;
      parallelBatchState.secondaryTabId = null;
      await saveParallelBatchState();
    }
    await fallbackParallelBatch('Одна из рабочих вкладок была закрыта');
  }).catch((error) => console.error('[Background] Parallel tab close handling failed:', error));
});

let batchState = {
  queue: [],
  activeTabId: null,
  isRunning: false
};

// Загружаем состояние при старте воркера
async function loadBatchState() {
  try {
    const data = await chrome.storage.local.get('batchState');
    if (data.batchState) {
      batchState = data.batchState;
      console.log('[Background] Batch state loaded:', batchState);
    }
  } catch (e) {
    console.error('[Background] Error loading batch state:', e);
  }
}

// Сохраняем состояние в storage
async function saveBatchState() {
  try {
    await chrome.storage.local.set({ batchState });
    console.log('[Background] Batch state saved');
  } catch (e) {
    console.error('[Background] Error saving batch state:', e);
  }
}

async function startLegacyBatchProcessing(jobs, tabId) {
  batchState = {
    queue: Array.isArray(jobs) ? jobs : [],
    activeTabId: tabId,
    isRunning: true
  };
  await saveBatchState();
  processNextBatchItem().catch((error) => {
    console.error('[Background] Legacy batch start failed:', error);
  });
}

async function startLongTextAwareBatch(jobs, tabId, useParallel) {
  await Promise.all([loadBatchState(), loadParallelBatchState(), loadLongTextState()]);
  if (batchState.isRunning || parallelBatchState.isRunning || getLongTextSummary().hasActive) {
    return { success: false, reason: 'automation_already_running' };
  }

  const { longTextEntries, regularJobs } = partitionLongTextJobs(jobs);
  const longTextResult = await submitLongTextEntries(longTextEntries, tabId);
  let regularResult = { success: true, parallel: false };

  if (regularJobs.length > 0) {
    if (useParallel) {
      regularResult = await startParallelBatchProcessing(regularJobs, tabId);
    } else {
      await startLegacyBatchProcessing(regularJobs, tabId);
    }
  }

  return {
    ...regularResult,
    success: regularResult.success !== false,
    regularStarted: regularJobs.length > 0,
    longTextSubmitted: longTextResult.submitted,
    longTextFailed: longTextResult.failed
  };
}

// Инициализация при пробуждении Service Worker
loadBatchState();
queueParallelOperation(() => initializeLongTextState()).catch((error) => {
  console.error('[Background] Long Text state initialization failed:', error);
});

// Слушаем команды от POPUP и CONTENT SCRIPT
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getLongTextStatus') {
    queueParallelOperation(async () => {
      await loadLongTextState();
      return getLongTextSummary();
    }).then((summary) => {
      sendResponse({ success: true, summary });
    }).catch((error) => sendResponse({ success: false, reason: error.message }));
    return true;
  }

  if (request.action === "getBatchStatus") {
    Promise.all([loadBatchState(), loadParallelBatchState()]).then(async () => {
      if (parallelBatchState.isRunning) {
        sendResponse({
          success: true,
          isRunning: true,
          isParallel: true,
          state: parallelBatchState,
          runtime: { ...getParallelProgress(), mode: 'multi' }
        });
        return;
      }
      if (!batchState.isRunning || !batchState.activeTabId) {
        sendResponse({ success: true, isRunning: false, state: batchState });
        return;
      }

      chrome.tabs.sendMessage(batchState.activeTabId, { action: 'getAutomationRuntimeState' }, async (runtimeResponse) => {
        const hasRuntimeError = !!chrome.runtime.lastError;
        const runtimeRunning = !!(runtimeResponse?.success && runtimeResponse?.state?.isRunning);

        if (hasRuntimeError || !runtimeRunning) {
          batchState.isRunning = false;
          batchState.activeTabId = null;
          batchState.queue = [];
          await saveBatchState();
          await ensureAutomationStateLoaded();
          await saveAutomationState({
            progress: {
              ...(automationState.progress || {}),
              isRunning: false,
              isPaused: false
            }
          });
          sendResponse({ success: true, isRunning: false, state: batchState });
          return;
        }

        sendResponse({
          success: true,
          isRunning: true,
          state: batchState,
          runtime: runtimeResponse.state
        });
      });
    }).catch((error) => {
      console.error('[Background] getBatchStatus error:', error);
      sendResponse({ success: false, reason: error.message });
    });
    return true;
  }

  
  // 1. Команда от POPUP: Начать обработку списка файлов
  if (request.action === "startBatchProcessing") {
    if (!extensionEnabled) {
      sendResponse({ success: false, reason: 'disabled' });
      return;
    }
    
    console.log(`[Background] Получен пакет задач: ${request.jobs.length} файлов`);
    queueParallelOperation(async () => {
        return startLongTextAwareBatch(request.jobs, request.tabId, false);
      })
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, reason: error.message }));
    return true;
  }

  if (request.action === "startParallelBatchProcessing") {
    if (!extensionEnabled) {
      sendResponse({ success: false, reason: 'disabled' });
      return;
    }
    queueParallelOperation(() => startLongTextAwareBatch(request.jobs, request.tabId, true))
      .then(sendResponse)
      .catch((error) => sendResponse({ success: false, reason: error.message }));
    return true;
  }

  if (request.action === 'automationProgress' && request.runId) {
    queueParallelOperation(() => updateParallelWorker(request, sender, false)).catch((error) => {
      console.error('[Background] Parallel progress failed:', error);
    });
    return;
  }

  // 2. Сигнал от CONTENT SCRIPT: Текущий файл завершен
  if (request.action === "automationComplete") {
    if (request.runId) {
      queueParallelOperation(() => updateParallelWorker(request, sender, true)).catch((error) => {
        console.error('[Background] Parallel completion failed:', error);
      });
      return;
    }
    // Сначала обновляем состояние из storage (воркер мог спать)
    loadBatchState().then(() => {
      if (batchState.isRunning && batchState.queue.length > 0) {
        console.log(`[Background] Файл завершен. Осталось файлов: ${batchState.queue.length}`);
        
        setTimeout(() => {
          processNextBatchItem();
        }, 3000);
      } else if (batchState.isRunning && batchState.queue.length === 0) {
        console.log(`[Background] Все файлы из пакета обработаны.`);
        batchState.isRunning = false;
        batchState.activeTabId = null;
        saveBatchState();
      }
    });
  }

  if (request.action === 'pauseBatchProcessing' || request.action === 'resumeBatchProcessing') {
    queueParallelOperation(async () => {
      await Promise.all([loadBatchState(), loadParallelBatchState()]);
      const action = request.action === 'pauseBatchProcessing' ? 'pauseAutomation' : 'resumeAutomation';
      const tabIds = parallelBatchState.isRunning
        ? parallelBatchState.workers.map((worker) => worker.tabId)
        : [batchState.activeTabId].filter(Boolean);
      await Promise.allSettled(tabIds.map((tabId) => sendTabMessageWithTimeout(tabId, { action }, 7000)));
      if (parallelBatchState.isRunning) {
        parallelBatchState.isPaused = action === 'pauseAutomation';
        await saveParallelBatchState();
        await broadcastParallelProgress();
      }
      sendResponse({ success: true, isPaused: action === 'pauseAutomation' });
    }).catch((error) => sendResponse({ success: false, reason: error.message }));
    return true;
  }

  // 3. Команда остановки
  if (request.action === "stopAutomation") {
    queueParallelOperation(async () => {
      await Promise.all([loadBatchState(), loadParallelBatchState()]);
      if (parallelBatchState.isRunning) {
        const tabIds = parallelBatchState.workers.map((worker) => worker.tabId);
        const secondaryTabId = parallelBatchState.secondaryTabId;
        parallelBatchState = getDefaultParallelBatchState();
        await saveParallelBatchState();
        await chrome.alarms.clear('parallelBatchWatchdog');
        await Promise.allSettled(tabIds.map((tabId) => sendTabMessageWithTimeout(tabId, { action: 'stopAutomation' }, 7000)));
        await closeTabSafely(secondaryTabId);
        await saveAutomationState({
          progress: { currentIndex: 0, total: 0, completedIds: [], isRunning: false, isPaused: false, workerCount: 0 },
          mode: 'multi'
        });
        sendResponse({ success: true, stopped: true });
        return;
      }
      const activeTabId = batchState.activeTabId;
      let deliveryError = null;

      if (activeTabId) {
        try {
          await chrome.tabs.sendMessage(activeTabId, { action: 'stopAutomation' });
        } catch (error) {
          deliveryError = error;
        }
      }

      batchState.isRunning = false;
      batchState.queue = [];
      batchState.activeTabId = null;
      await saveBatchState();

      await ensureAutomationStateLoaded();
      await saveAutomationState({
        progress: {
          ...(automationState.progress || {}),
          isRunning: false,
          isPaused: false
        }
      });

      if (deliveryError) {
        sendResponse({ success: true, stopped: true, warning: deliveryError.message });
        return;
      }
      sendResponse({ success: true, stopped: true });
    }).catch((error) => {
      sendResponse({ success: false, reason: error.message });
    });
    return true;
  }
});

// Функция отправки задачи во вкладку
async function processNextBatchItem() {
  // Загружаем актуальное состояние
  await loadBatchState();
  
  if (!batchState.activeTabId || batchState.queue.length === 0) {
    console.log('[Background] No more items or no active tab');
    return;
  }

  const nextJob = batchState.queue[0];
  
  console.log(`[Background] Запуск файла: ${nextJob.scriptName}`);

  // Отправляем команду content_script'у
  chrome.tabs.sendMessage(batchState.activeTabId, {
    action: 'startAutomation',
    queue: nextJob.queue,
    mode: nextJob.mode,
    scriptName: nextJob.scriptName
  }, async (response) => {
     if (chrome.runtime.lastError) {
       console.error('[Background] Ошибка отправки во вкладку:', chrome.runtime.lastError);
       setTimeout(() => {
         if (batchState.isRunning) processNextBatchItem().catch(() => {});
       }, 3000);
       return;
     }

     if (!response || !response.success) {
       console.error('[Background] Вкладка не приняла startAutomation:', response);
       setTimeout(() => {
         if (batchState.isRunning) processNextBatchItem().catch(() => {});
       }, 3000);
       return;
     }

     batchState.queue.shift();
     await saveBatchState();
  });
}
