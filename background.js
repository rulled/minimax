﻿// Состояние расширения
let extensionEnabled = false;

// "Бронь" для следующего скачивания (для новых DIV-кнопок без href)
let nextDownloadConfig = null;
const PRIME_TTL_MS = 120000;

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
  if (!extensionEnabled) return;
  if (nextDownloadConfig) {
    console.log('[Background] onDeterminingFilename item:', { url: item.url, tabId: item.tabId, filename: item.filename });
    const isExpired = Date.now() - nextDownloadConfig.createdAt > PRIME_TTL_MS;
    if (isExpired) {
      console.log('[Background] Prime expired, skipping rename');
      nextDownloadConfig = null;
      return;
    }
    const primedTabId = nextDownloadConfig.tabId;
    const itemTabId = typeof item.tabId === 'number' ? item.tabId : null;
    const hasKnownPrimedTab = typeof primedTabId === 'number' && primedTabId >= 0;
    const hasKnownItemTab = typeof itemTabId === 'number' && itemTabId >= 0;
    if (hasKnownPrimedTab && hasKnownItemTab && itemTabId !== primedTabId) {
      console.log('[Background] Prime tab mismatch, keeping reservation for target tab', { primedTabId, itemTabId });
      return;
    }

    const isBlobUrl = typeof item.url === 'string' && item.url.startsWith('blob:');
    const isBlobMp3 = isBlobUrl && typeof item.filename === 'string' && item.filename.toLowerCase().endsWith('.mp3');
    const isDataAudio = typeof item.url === 'string' && item.url.startsWith('data:audio/');
    if (!item.url || (!isValidAudioUrl(item.url) && !isBlobMp3 && !isDataAudio)) {
      console.log('[Background] Prime active but download is not a valid audio url, skipping rename');
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
  }
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

async function buildDownloadTarget({ voiceName, scriptName, forceIndex, speakerName, downloadLayout }) {
  const sanitizedVoice = sanitizeFilename(voiceName || 'dictor');
  const sanitizedScript = scriptName ? sanitizeFilename(scriptName) : null;
  const sanitizedSpeaker = speakerName ? sanitizeFilename(speakerName) : sanitizedVoice;
  const normalizedLayout = String(downloadLayout || '').trim().toLowerCase();

  let folderName;
  let fileNamePrefix;
  let padLength = 4;

  if (normalizedLayout === 'package') {
    folderName = sanitizedScript || sanitizedSpeaker || sanitizedVoice;
    fileNamePrefix = sanitizedSpeaker || sanitizedVoice || sanitizedScript || 'dictor';
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

async function waitForDownloadConfirmation(downloadId, timeoutMs = 15000) {
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

      if (item.state === 'in_progress' || item.state === 'complete') {
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

// Сохраняем в историю
async function saveToDownloadHistory(voiceName, filename, fileNumber) {
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
        await saveAutomationState({
          progress: { ...(automationState.progress || {}), ...request.progress }
        });
        sendResponse({ success: true });
        return;
      }

      if (request.action === "clearAutomationState") {
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
          downloadLayout: request.downloadLayout || null
        });

        console.log(`Скачиваем как ${target.newFilename}`);

        chrome.downloads.download({
          url: url,
          filename: target.newFilename,
          conflictAction: 'uniquify',
          saveAs: false
        }, async (downloadId) => {
          if (chrome.runtime.lastError) {
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

        console.log(`Скачиваем audio data как ${target.newFilename}`);

        chrome.downloads.download({
          url: request.dataUrl,
          saveAs: false
        }, async (downloadId) => {
          if (chrome.runtime.lastError) {
            console.error('Ошибка скачивания data url:', chrome.runtime.lastError);
            nextDownloadConfig = null;
            sendResponse({ success: false, reason: chrome.runtime.lastError.message });
          } else {
            const confirmResult = await waitForDownloadConfirmation(downloadId);
            if (!confirmResult.ok) {
              nextDownloadConfig = null;
              sendResponse({ success: false, reason: confirmResult.reason, downloadId });
              return;
            }

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

      } else if (request.action === "incrementFileCounter") {
        const tabId = sender.tab?.id ? String(sender.tab.id) : 'fallback-tab';
        const data = await chrome.storage.local.get('tabVoices');
        const tabVoices = data.tabVoices || {};
        let voiceName = tabVoices[tabId] || 'dictor';
        voiceName = sanitizeFilename(voiceName);

        // ИСПРАВЛЕНО: Формат "ScriptName - SpeakerName"
        let folderName = voiceName;
        if (request.scriptName) {
            const sanitizedScriptName = sanitizeFilename(request.scriptName);
            folderName = `${sanitizedScriptName} - ${voiceName}`;
        }

        const fileNumber = await getNextFileNumber(folderName);
        sendResponse({ success: true, skippedNumber: fileNumber });
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

          ensureAudioCaptureInstalled: function() {
            function buildSession() {
              return {
                resetAt: Date.now(),
                blob: null,
                blobType: '',
                blobUrl: '',
                mediaSource: null,
                mediaSourceUrl: '',
                sourceBufferTypes: [],
                chunks: [],
                totalBytes: 0,
                lastChunkAt: 0,
                endedAt: 0
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
              mediaSourceSessions.set(mediaSource, session);
            }

            function blobToDataUrl(blob) {
              return new Promise(function(resolve, reject) {
                var reader = new FileReader();
                reader.onloadend = function() { resolve(reader.result); };
                reader.onerror = function() { reject(reader.error || new Error('blob read failed')); };
                reader.readAsDataURL(blob);
              });
            }

            var capture = {
              installed: true,
              activeSession: buildSession(),
              resetSession: function() {
                this.activeSession = buildSession();
                return { ok: true, resetAt: this.activeSession.resetAt };
              },
              consumeCapturedAudio: async function(timeout) {
                var maxWait = Number(timeout) || 10000;
                var startedAt = Date.now();
                var session = this.activeSession;

                while (Date.now() - startedAt < maxWait) {
                  if (session.blob && session.blob.size > 0) {
                    return {
                      ok: true,
                      source: 'blob',
                      src: session.blobUrl || '',
                      size: session.blob.size,
                      dataUrl: await blobToDataUrl(session.blob)
                    };
                  }

                  if (session.chunks.length > 0) {
                    var isQuiet = session.lastChunkAt && (Date.now() - session.lastChunkAt > 800);
                    if (session.endedAt || isQuiet) {
                      var audioType = session.sourceBufferTypes.find(function(type) {
                        return String(type || '').toLowerCase().indexOf('audio/') === 0;
                      }) || 'audio/mpeg';
                      var chunkBlob = new Blob(session.chunks, { type: audioType });
                      if (chunkBlob.size > 0) {
                        return {
                          ok: true,
                          source: 'mediasource',
                          src: session.mediaSourceUrl || '',
                          size: chunkBlob.size,
                          chunkCount: session.chunks.length,
                          dataUrl: await blobToDataUrl(chunkBlob)
                        };
                      }
                    }
                  }

                  await new Promise(function(resolve) { setTimeout(resolve, 250); });
                }

                return {
                  ok: false,
                  reason: 'audio_not_captured',
                  src: session.blobUrl || session.mediaSourceUrl || '',
                  chunkCount: session.chunks.length,
                  totalBytes: session.totalBytes,
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
                }
              } catch (error) {
                console.warn('[MiniMax Capture] endOfStream hook failed:', error);
              }

              return originalEndOfStream.apply(this, arguments);
            };

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

          getLatestAudioDataUrl: async function(timeout) {
            var capture = window.__minimaxAudioCapture;
            if (!capture || !capture.installed || typeof capture.consumeCapturedAudio !== 'function') {
              return { ok: false, reason: 'capture_not_installed' };
            }
            return await capture.consumeCapturedAudio(timeout);
          },

          triggerMp3Download: function() {
            function isVisibleElement(el) {
              if (!el) return false;
              var style = window.getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
              var rect = el.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            }

            function findMp3Item() {
              var dropdowns = Array.from(document.querySelectorAll('.ant-dropdown, [role="menu"]'))
                .filter(function(el) { return isVisibleElement(el) && !el.classList.contains('ant-dropdown-hidden'); });

              for (var i = 0; i < dropdowns.length; i++) {
                var items = Array.from(dropdowns[i].querySelectorAll('li[role="menuitem"], .ant-dropdown-menu-item, [role="menuitem"]'));
                var byId = items.find(function(item) {
                  var dataMenuId = String(item.getAttribute('data-menu-id') || '').toLowerCase();
                  return dataMenuId.includes('tts_no_watermark') && !dataMenuId.includes('wav');
                });
                if (byId) return byId;

                var byText = items.find(function(item) {
                  var text = String(item.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
                  return text.includes('mp3');
                });
                if (byText) return byText;
              }

              return null;
            }

            function invokeReactClick(el) {
              var current = el;
              while (current) {
                var propsKey = Object.keys(current).find(function(k) { return k.startsWith('__reactProps$'); });
                if (propsKey && current[propsKey]) {
                  var props = current[propsKey];
                  if (typeof props.onClick === 'function') {
                    props.onClick({
                      type: 'click',
                      target: el,
                      currentTarget: current,
                      nativeEvent: new MouseEvent('click', { bubbles: true, cancelable: true, view: window }),
                      preventDefault: function() {},
                      stopPropagation: function() {}
                    });
                    return { ok: true, mode: 'react-onClick' };
                  }
                }
                current = current.parentElement;
              }
              return { ok: false, mode: 'react-onClick-missing' };
            }

            var item = findMp3Item();
            if (!item) {
              return { ok: false, reason: 'mp3_item_not_found' };
            }

            var invoked = invokeReactClick(item);
            if (invoked.ok) {
              return invoked;
            }

            item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            item.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
            item.click();
            return { ok: true, mode: 'native-click-fallback' };
          }
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

// Инициализация при пробуждении Service Worker
loadBatchState();

// Слушаем команды от POPUP и CONTENT SCRIPT
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "getBatchStatus") {
    loadBatchState().then(async () => {
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
    
    batchState = {
      queue: request.jobs,
      activeTabId: request.tabId,
      isRunning: true
    };
    
    console.log(`[Background] Получен пакет задач: ${batchState.queue.length} файлов`);
    
    saveBatchState().then(() => {
      processNextBatchItem();
    });
    
    sendResponse({ success: true });
    return;
  }

  // 2. Сигнал от CONTENT SCRIPT: Текущий файл завершен
  if (request.action === "automationComplete") {
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

  // 3. Команда остановки
  if (request.action === "stopAutomation") {
    batchState.isRunning = false;
    batchState.queue = [];
    batchState.activeTabId = null;
    saveBatchState();
    
    // Пересылаем команду остановки в активную вкладку
    if (sender.tab?.id) {
      chrome.tabs.sendMessage(sender.tab.id, { action: 'stopAutomation' });
    }
    sendResponse({ success: true });
    return;
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
