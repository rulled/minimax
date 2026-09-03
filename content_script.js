// Храним состояние расширения
let extensionEnabled = false;

// Глобальные ошибки контент-скрипта — в диагностический журнал (diag_log.js грузится раньше по манифесту)
window.addEventListener('error', (event) => {
  try {
    DiagLog.error('content', 'Uncaught error', { message: event.message, filename: event.filename, lineno: event.lineno });
  } catch (_) {}
});
window.addEventListener('unhandledrejection', (event) => {
  try {
    DiagLog.error('content', 'Unhandled rejection', { reason: event.reason?.message || String(event.reason) });
  } catch (_) {}
});
let isInitialized = false;
let automationOverrideIndex = null;
let automationOverrideSpeaker = null; 
let automationOverrideScriptName = null; 
let currentAutomationMode = 'single'; 

// Сохранение пропущенных записей
let skippedEntriesBuffer = [];
const MAX_ENTRY_ATTEMPTS = 3;
const AUTOMATION_HEARTBEAT_MS = 45000;

async function initialize() {
  try {
    const data = await chrome.storage.local.get('extensionEnabled');
    extensionEnabled = data.extensionEnabled !== false;
    isInitialized = true;
  } catch (error) {
    extensionEnabled = true;
    isInitialized = true;
  }
}

const initializationReady = initialize();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.extensionEnabled) {
    extensionEnabled = changes.extensionEnabled.newValue;
    if (!extensionEnabled && automation && automation.isRunning) {
      automation.stop();
    }
  }
});

function isValidDownloadLink(url) {
  if (!url.endsWith('.mp3')) return false;
  return url.includes('cdn.hailuoai.video') || url.includes('minimax.io'); 
}

function isVisibleElement(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function sanitizeFilenamePart(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .replace(/\s+/g, '_')
    .slice(0, 100);
}

let lastClickTime = 0;
const CLICK_DEBOUNCE_MS = 300;

async function handleClick(event) {
  // --- ВАЖНЫЙ ФИКС: Игнорируем клики от робота ---
  if (!event.isTrusted) return;
  // ----------------------------------------------

  const now = Date.now();
  if (now - lastClickTime < CLICK_DEBOUNCE_MS) return;

  const target = event.target.closest('a, div.cursor-pointer');
  if (!target) return;

  const hasDownloadIcon = target.querySelector('path[d^="M12.3984 13.6006H3.59844"]');
  const isAudioLink = target.tagName === 'A' && target.href && target.href.includes('.mp3');

  if (!hasDownloadIcon && !isAudioLink) return;

  if (!isInitialized) await initialize();
  if (!extensionEnabled) return;

  lastClickTime = now;

  if (automationOverrideIndex === null && hasDownloadIcon) {
      const res = await chrome.runtime.sendMessage({ action: "getTabVoiceName" });
      const voiceName = res?.voiceName || 'dictor';

      await chrome.runtime.sendMessage({
          action: "primeNextDownload",
          voiceName: voiceName
      });
  }
  
  if (isAudioLink) {
    event.preventDefault();
    
    const link = target;
    const originalOpacity = link.style.opacity;
    link.style.opacity = '0.5';

    try {
      const message = {
        action: "downloadFile",
        url: link.href
      };

      if (automationOverrideIndex !== null) {
        message.forceIndex = automationOverrideIndex;
        automationOverrideIndex = null;
      }
      
      if (automationOverrideSpeaker !== null) {
          message.forceSpeaker = automationOverrideSpeaker;
          automationOverrideSpeaker = null;
      }
      
      if (automationOverrideScriptName !== null) {
          message.scriptName = automationOverrideScriptName;
          automationOverrideScriptName = null;
      }
      
      message.mode = currentAutomationMode;

      const response = await chrome.runtime.sendMessage(message);

      if (response && response.success) {
        link.style.opacity = originalOpacity;
      } else {
        console.error('Download error:', response?.reason);
        link.style.opacity = originalOpacity;
        if (response?.reason === 'disabled' || response?.reason === 'invalid-url') {
          setTimeout(() => {
            const newEvent = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
            document.removeEventListener('click', handleClick, true);
            link.dispatchEvent(newEvent);
            setTimeout(() => document.addEventListener('click', handleClick, true), 100);
          }, 100);
        }
      }
    } catch (error) {
      console.error('Message error:', error);
      link.style.opacity = originalOpacity;
    }
  }
}

document.addEventListener('click', handleClick, true);

// ============================================
// AUTOMATION CLASS
// ============================================

let automation = null;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'startAutomation') {
    initializationReady.then(() => {
      if (!extensionEnabled) {
        sendResponse({ success: false, reason: 'disabled' });
        return;
      }
      if (automation && (automation.isRunning || automation.longTextInFlight)) {
        sendResponse({ success: false, reason: 'automation_already_running' });
        return;
      }
      automation = new VoiceoverAutomation();
      automation.setRunContext(request.runId || null, request.workerId || null);
      automation.setLegacyJobId(request.legacyJobId || null);
      automation.setQueue(request.queue);
      automation.setMode(request.mode || 'single');
      automation.setScriptName(request.scriptName || null);
      DiagLog.info('automation', 'Воркер принял очередь', {
        runId: request.runId || null,
        workerId: request.workerId || null,
        mode: request.mode || 'single',
        queueSize: request.queue?.length || 0
      });
      automation.start();
      sendResponse({ success: true });
    }).catch((error) => sendResponse({ success: false, reason: error.message }));
    return true;
  }
  if (request.action === 'pauseAutomation') {
    if (!automation?.isRunning) {
      sendResponse({ success: false, reason: 'automation_not_running' });
      return true;
    }
    automation.pause();
    sendResponse({ success: automation.isPaused === true });
    return true;
  }
  if (request.action === 'resumeAutomation') {
    if (!automation?.isRunning) {
      sendResponse({ success: false, reason: 'automation_not_running' });
      return true;
    }
    automation.resume();
    sendResponse({ success: automation.isPaused === false });
    return true;
  }
  if (request.action === 'stopAutomation') {
    if (!automation) {
      sendResponse({ success: true });
      return true;
    }
    automation.stop();
    automation.cancelPendingCapture()
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: true, warning: error.message }));
    return true;
  }
  if (request.action === 'cancelLongTextSubmissions') {
    if (!automation) automation = new VoiceoverAutomation();
    automation.longTextCancellationRequested = true;
    sendResponse({ success: true });
    return true;
  }
  if (request.action === 'resetLongTextCancellation') {
    if (!automation) automation = new VoiceoverAutomation();
    automation.longTextCancellationRequested = false;
    sendResponse({ success: true });
    return true;
  }
  if (request.action === 'getAutomationRuntimeState') {
    sendResponse({
      success: true,
      state: {
        isRunning: !!(automation && automation.isRunning),
        isPaused: !!(automation && automation.isPaused),
        currentIndex: automation ? automation.currentIndex : 0,
        total: automation && Array.isArray(automation.queue) ? automation.queue.length : 0,
        mode: automation?.mode || currentAutomationMode || 'single',
          runId: automation?.runId || null,
          workerId: automation?.workerId || null,
          legacyJobId: automation?.legacyJobId || null,
          longTextInFlight: automation?.longTextInFlight === true,
          longTextCancellationRequested: automation?.longTextCancellationRequested === true,
        queue: automation?.queue?.map((entry) => ({
          id: entry.id,
          status: entry.status,
          error: entry.error || null,
          submissionRejected: entry.submissionRejected === true,
          downloadConfirmed: entry.downloadConfirmed === true
        })) || []
      }
    });
    return true;
  }
  if (request.action === 'parallelHealthCheck') {
    if (!automation) automation = new VoiceoverAutomation();
    Promise.all([
      automation.waitForElement('[data-slate-editor="true"]', 5000),
      automation.findGenerateButton()
    ]).then(([editor, generateButton]) => {
      sendResponse({
        success: !!editor && !!generateButton,
        editorReady: !!editor,
        generateReady: !!generateButton,
        url: location.href
      });
    }).catch((error) => sendResponse({ success: false, reason: error.message }));
    return true;
  }
  if (request.action === 'prepareParallelWorker') {
    if (!automation) automation = new VoiceoverAutomation();
    automation.prepareParallelWorker(
      request.voiceName || request.voiceId || '',
      request.voiceId || '',
      request.language || 'Auto'
    )
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, reason: error.message }));
    return true;
  }
  if (request.action === 'verifyVoiceSwitch') {
    if (!automation) automation = new VoiceoverAutomation();
    automation.switchVoice(request.voiceName || request.voiceId || '', request.voiceId || '')
      .then(async () => {
        const state = await automation.callBridge('getDirectTtsReadyState', '', request.voiceId || '');
        sendResponse({
          success: String(state?.voiceId || '') === String(request.voiceId || ''),
          expectedVoiceId: String(request.voiceId || ''),
          activeVoiceId: String(state?.voiceId || '')
        });
      })
      .catch((error) => sendResponse({ success: false, reason: error.message }));
    return true;
  }
  if (request.action === 'submitLongText') {
    if (!automation) automation = new VoiceoverAutomation();
    if (automation.isRunning) {
      sendResponse({ success: false, reason: 'automation_running' });
      return true;
    }
    automation.submitLongText(request.task)
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((error) => sendResponse({ success: false, reason: error.message }));
    return true;
  }
  if (request.action === 'queryLongTextHistory') {
    if (!automation) automation = new VoiceoverAutomation();
    automation.queryLongTextHistory(request.tasks || [], request.timeout || 12000)
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((error) => sendResponse({ success: false, reason: error.message }));
    return true;
  }
  if (request.action === 'resetLongTextMode') {
    if (!automation) automation = new VoiceoverAutomation();
    automation.restoreRegularTextMode()
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, reason: error.message }));
    return true;
  }
  if (request.action === 'listMyVoices') {
    if (!automation) automation = new VoiceoverAutomation();
    automation.listMyVoices().then((result) => {
      sendResponse({
        success: !!result?.ok,
        voices: Array.isArray(result?.voices) ? result.voices : [],
        reason: result?.reason || null
      });
    }).catch((error) => {
      sendResponse({
        success: false,
        voices: [],
        reason: error?.message || 'list_my_voices_failed'
      });
    });
    return true;
  }
  if (request.action === 'inspectVoiceMappingPlan') {
    if (automation?.isRunning) {
      sendResponse({ success: false, reason: 'automation_running' });
      return true;
    }
    if (!automation) automation = new VoiceoverAutomation();
    automation.inspectVoiceMappingPlan(request.plan || {})
      .then((result) => sendResponse({ success: true, ...result }))
      .catch((error) => sendResponse({ success: false, reason: error?.message || 'mapping_inspection_failed' }));
    return true;
  }
  if (request.action === 'getGenerationCredit') {
    if (!automation) automation = new VoiceoverAutomation();
    automation.getGenerationCredit(request.requestedCharacters || 0).then((result) => {
      sendResponse({ success: !!result?.ok, ...result });
    }).catch((error) => {
      sendResponse({ success: false, reason: error?.message || 'generation_credit_failed' });
    });
    return true;
  }
  if (request.action === 'getDirectTtsCapability') {
    if (!automation) automation = new VoiceoverAutomation();
    automation.getDirectTtsCapability().then((result) => {
      sendResponse({ success: !!result?.ok, ...result });
    }).catch((error) => {
      sendResponse({ success: false, reason: error?.message || 'direct_tts_capability_failed' });
    });
    return true;
  }
  if (request.action === 'prepareDirectProbeText') {
    if (!automation) automation = new VoiceoverAutomation();
    const text = String(request.text || 'Safe blocked direct transport probe.');
    automation.setLongTextMode(false)
      .then(() => automation.callBridge('clearTextContent'))
      .then(() => automation.callBridge('insertText', text))
      .then((result) => sendResponse({ success: !!result?.ok, textLength: text.length, reason: result?.reason || null }))
      .catch((error) => sendResponse({ success: false, reason: error.message }));
    return true;
  }
  if (request.action === 'voiceCleanupPreview') {
    if (!automation) automation = new VoiceoverAutomation();
    automation.getVoiceCleanupPreview(request.protectedVoiceNames || [], request.count || 20, request.protectedVoiceIds || [])
      .then((result) => sendResponse({ success: !!result?.ok, ...result }))
      .catch((error) => sendResponse({ success: false, reason: error.message }));
    return true;
  }
  if (request.action === 'voiceCleanupDelete') {
    if (!automation) automation = new VoiceoverAutomation();
    automation.deleteVoiceCleanupCandidates(request.candidates || [], request.protectedVoiceNames || [], request.protectedVoiceIds || [])
      .then((result) => sendResponse({ success: !!result?.ok, ...result }))
      .catch((error) => sendResponse({ success: false, reason: error.message }));
    return true;
  }
});

class VoiceoverAutomation {
    constructor() {
        this.queue = [];
        this.currentIndex = 0;
        this.isRunning = false;
        this.isPaused = false;
        this.isStopped = false;
        this.currentVoiceId = null;
        this.mode = 'single';
        this.scriptName = null;
        this.runId = null;
        this.workerId = null;
        this.legacyJobId = null;
        this.skippedEntries = []; 
        this.heartbeatTimer = null;
        this.longTextCancellationRequested = false;
        this.longTextInFlight = false;
        
        this.selectors = {
            textarea: '[data-slate-editor="true"]',
            switchVoiceBtnXPath: '//div[contains(@class, "flex") and .//path[starts-with(@d, "M5.24492 3.34774")]]',
            searchVoiceInput: 'input[placeholder*="Search"], input[placeholder*="voices"], input[placeholder*="Voices"]',
            useVoiceBtnXPath: '//div[contains(text(), "Use") and contains(@class, "ant-btn")]',
            closeModalBtnXPath: '//span[contains(@class, "anticon-close")]',
            languageDropdownTrigger: '.language-select .ant-select-selector',
            languageCurrentValue: '.language-select .ant-select-selection-item',
            languageOptionXPath: (lang) => `//div[contains(@class, "ant-select-item-option") and text()="${lang}"]`
        };
    }

    setMode(mode) {
        this.mode = mode;
        currentAutomationMode = mode;
    }

    setScriptName(name) {
        this.scriptName = name;
    }

    setRunContext(runId, workerId) {
        this.runId = runId;
        this.workerId = workerId;
    }

    setLegacyJobId(legacyJobId) {
        this.legacyJobId = legacyJobId;
    }

    async prepareParallelWorker(voiceName, voiceId, language) {
        const editor = await this.waitForElement('[data-slate-editor="true"]', 5000);
        const generateButton = await this.findGenerateButton();
        if (!editor || !generateButton) throw new Error('MiniMax editor is not ready');
        if (voiceName || voiceId) await this.switchVoice(voiceName || voiceId, voiceId);
        if (language) await this.ensureLanguage(language);
    }

    startHeartbeat() {
        this.stopHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            if (this.isRunning && !this.isPaused) this.notifyProgress();
        }, AUTOMATION_HEARTBEAT_MS);
    }

    stopHeartbeat() {
        if (!this.heartbeatTimer) return;
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
    }

    getPageTab(label) {
        const normalizedLabel = String(label || '').trim().toLowerCase();
        return Array.from(document.querySelectorAll('[role="tab"]')).find((tab) => {
            return String(tab.textContent || '').trim().toLowerCase() === normalizedLabel;
        }) || null;
    }

    async openPageTab(label) {
        const tab = this.getPageTab(label);
        if (!tab) throw new Error(`${label} tab not found`);
        if (tab.getAttribute('aria-selected') !== 'true') {
            tab.click();
            await this.sleep(500);
        }
        return tab;
    }

    async setLongTextMode(enabled) {
        await this.openPageTab('Settings');
        const toggle = await this.waitForElement('.long-text-stats [role="switch"]', 5000);
        if (!toggle) throw new Error('Long Text switch not found');
        const expected = enabled ? 'true' : 'false';
        if (toggle.getAttribute('aria-checked') !== expected) {
            toggle.click();
        }

        const startedAt = Date.now();
        while (Date.now() - startedAt < 5000) {
            if (toggle.getAttribute('aria-checked') === expected) return;
            await this.sleep(100);
        }
        throw new Error(`Long Text switch did not turn ${enabled ? 'on' : 'off'}`);
    }

    findVisibleButtonByText(label) {
        const normalizedLabel = String(label || '').trim().toLowerCase();
        return Array.from(document.querySelectorAll('button')).find((button) => {
            return isVisibleElement(button)
                && String(button.textContent || '').trim().toLowerCase() === normalizedLabel;
        }) || null;
    }

    async waitForVisibleButtonByText(label, timeout = 10000) {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeout) {
            const button = this.findVisibleButtonByText(label);
            if (button) return button;
            await this.sleep(100);
        }
        return null;
    }

    async queryLongTextHistory(tasks, timeout = 12000) {
        const result = await this.callBridge('consumeLongTextHistory', tasks, timeout);
        if (!result?.ok) throw new Error(result?.reason || 'history_query_failed');
        return result;
    }

    async getVoiceCleanupPreview(protectedVoiceNames, count, protectedVoiceIds) {
        return this.callBridge('getVoiceCleanupPreview', protectedVoiceNames, count, protectedVoiceIds);
    }

    async deleteVoiceCleanupCandidates(candidates, protectedVoiceNames, protectedVoiceIds) {
        return this.callBridge('deleteVoiceCleanupCandidates', candidates, protectedVoiceNames, protectedVoiceIds);
    }

    async listMyVoices() {
        return this.callBridge('listMyVoices');
    }

    async inspectVoiceMappingPlan(plan) {
        const result = await this.listMyVoices();
        if (!result?.ok) throw new Error(result?.reason || 'list_my_voices_failed');
        return VoiceMappingResolver.inspectPlan(plan, result.voices || []);
    }

    async getGenerationCredit(requestedCharacters) {
        return this.callBridge('getGenerationCredit', requestedCharacters);
    }

    async getDirectTtsCapability() {
        return this.callBridge('getDirectTtsCapability');
    }

    async waitForDirectTtsReady(expectedText, expectedVoiceId = '', expectedLanguage = '', timeout = 10000) {
        const startedAt = Date.now();
        let stableLanguage = '';
        let stableCount = 0;
        let lastState = null;
        let pollCount = 0;
        let okSeenCount = 0;
        while (Date.now() - startedAt < timeout) {
            if (this.longTextCancellationRequested) {
                throw new Error('Long text submission cancelled during ready-wait');
            }
            const state = await this.callBridge(
                'getDirectTtsReadyState',
                expectedText,
                expectedVoiceId,
                expectedLanguage
            );
            lastState = state;
            pollCount += 1;
            if (state?.ok) okSeenCount += 1;
            if (state?.ok && state.language === stableLanguage) {
                stableCount += 1;
                if (stableCount >= 2) return state;
            } else {
                stableLanguage = state?.ok ? state.language : '';
                stableCount = state?.ok ? 1 : 0;
            }
            // 150ms достаточно для поимки транзиентного "готового" состояния
            // (сокращение с 300ms ускоряет стабилизацию на ~150ms/итер).
            await this.sleep(150);
        }
        DiagLog.warn('longText', 'Direct TTS state did not stabilize', {
            expectedLen: String(expectedText || '').length,
            textMatches: lastState?.textMatches ?? null,
            ok: lastState?.ok ?? null,
            okSeenCount,
            language: lastState?.language ?? null,
            languageMatches: lastState?.languageMatches ?? null,
            isDetecting: lastState?.isDetecting ?? null,
            voiceId: lastState?.voiceId ?? null,
            model: lastState?.model ?? null,
            pollCount,
            timeoutMs: timeout
        });
        throw new Error('Direct TTS state did not stabilize');
    }

    async submitLongText(task) {
        if (!task || !task.text) throw new Error('Long Text task is empty');
        if (String(task.text).length <= 5000 || String(task.text).length > 200000) {
            throw new Error('Long Text length is outside 5001-200000');
        }

        this.longTextInFlight = true;
        try {
            await this.openPageTab('Settings');
            const voiceLabel = task.voiceName || task.voiceId;
            if (voiceLabel) await this.switchVoice(voiceLabel, task.voiceId || '');
            if (task.language) await this.ensureLanguage(task.language);
            await this.setLongTextMode(true);

            const editor = await this.waitForElement('[data-slate-editor="true"]', 5000);
            if (!editor) throw new Error('Textarea (Slate editor) not found');
            await this.clearText();
            await this.insertText(editor, task.text);

            const generateButton = await this.waitForGenerateButtonReady(30000);
            if (!generateButton) throw new Error('Generate button not active for Long Text');
            this.throwIfLongTextCancelled();
            const readyTimeout = Math.max(10000, Math.ceil(String(task.text).length / 1000) * 1500);
            const readyState = await this.waitForDirectTtsReady(
                task.text,
                task.voiceId || '',
                task.language || '',
                readyTimeout
            );
            this.throwIfLongTextCancelled();
            const submittedAt = Date.now();
            const reservation = await chrome.runtime.sendMessage({
                action: 'reserveLongTextSubmission',
                localId: task.localId,
                reservedAt: submittedAt,
                transport: 'direct'
            });
            if (!reservation?.success) {
                throw new Error(`Long Text reservation failed: ${reservation?.reason || 'unknown error'}`);
            }
            if (this.longTextCancellationRequested) {
                await this.releaseLongTextReservation(task.localId);
                this.throwIfLongTextCancelled();
            }
            const dispatchMarker = await chrome.runtime.sendMessage({
                action: 'markLongTextDispatched',
                localId: task.localId,
                dispatchedAt: submittedAt
            });
            if (!dispatchMarker?.success) {
                await this.releaseLongTextReservation(task.localId);
                throw new Error(`Long Text dispatch marker failed: ${dispatchMarker?.reason || 'unknown error'}`);
            }
            if (this.longTextCancellationRequested) {
                await this.releaseLongTextReservation(task.localId);
                this.throwIfLongTextCancelled();
            }
            if (this.longTextCancellationRequested || this.isStopped) {
                return { success: false, reason: 'cancelled_before_dispatch' };
            }
            const directResult = await this.callDirectBridge(
                'submitDirectLongText',
                task.text,
                readyState.signature,
                task.voiceId || ''
            );
            await chrome.storage.local.set({
                directTtsLastResult: {
                    mode: 'long',
                    recordedAt: Date.now(),
                    ok: directResult?.ok === true,
                    disposition: directResult?.disposition || 'bridge_failed',
                    category: directResult?.category || '',
                    code: directResult?.code ?? null,
                    responseMeta: directResult?.responseMeta || null
                }
            });
            if (this.longTextCancellationRequested) {
                return { success: false, reason: 'cancelled_after_dispatch', submittedAt: Date.now() };
            }
            if (directResult?.ok) {
                return {
                    submittedAt,
                    transport: 'direct',
                    disposition: directResult.disposition,
                    msgId: directResult.msgId || ''
                };
            }
            if (directResult?.disposition === 'rejected') {
                await chrome.runtime.sendMessage({
                    action: 'markLongTextRejected',
                    localId: task.localId,
                    reason: directResult?.reason || directResult?.disposition || 'unknown'
                });
                throw new Error(`Direct Long Text rejected: ${directResult?.reason || directResult?.disposition || 'unknown'}`);
            }
            if (!['not_sent', 'not_invoked'].includes(directResult?.disposition)) {
                throw new Error(`Direct Long Text may have been accepted: ${directResult?.reason || directResult?.disposition || 'unknown'}`);
            }
            const release = await chrome.runtime.sendMessage({
                action: 'releaseLongTextReservation',
                localId: task.localId
            });
            if (!release?.success) {
                throw new Error(`Long Text reservation release failed: ${release?.reason || 'unknown error'}`);
            }
            throw new Error(`Direct Long Text was not sent: ${directResult?.reason || directResult?.disposition || 'unknown'}`);
        } finally {
            this.longTextInFlight = false;
        }
    }

    throwIfLongTextCancelled() {
        if (this.longTextCancellationRequested) {
            throw new Error('Long Text submission stopped before dispatch');
        }
    }

    async releaseLongTextReservation(localId) {
        const release = await chrome.runtime.sendMessage({
            action: 'releaseLongTextReservation',
            localId
        });
        if (!release?.success) {
            throw new Error(`Long Text reservation release failed: ${release?.reason || 'unknown error'}`);
        }
    }

    async restoreRegularTextMode() {
        await this.openPageTab('Settings');
        const clearResult = await this.callBridge('clearTextContent');
        if (!clearResult?.ok) this.log(`Long Text editor cleanup skipped: ${clearResult?.reason || 'unknown'}`);
        await this.sleep(300);
        await this.setLongTextMode(false);
    }

    async cancelPendingCapture() {
        await this.callBridge('resetAudioCaptureSession');
    }

    buildExpectedOutputInfo(entry) {
        const downloadLayout = String(entry.downloadLayout || '').trim().toLowerCase();
        const folderBase = sanitizeFilenamePart(entry.scriptName || this.scriptName || entry.speaker || 'dictor');
        const speakerBase = sanitizeFilenamePart(entry.speaker || entry.originalTag || 'dictor');
        const sourceFileBase = sanitizeFilenamePart(entry.sourceFileBaseName || entry.sourceFileName || entry.scriptName || '');
        const fileNumber = Number(entry.downloadIndex || entry.speakerIndex || 1);

        if (downloadLayout === 'package') {
            const paddedNumber = String(fileNumber).padStart(3, '0');
            const packagePrefix = [sourceFileBase, speakerBase].filter(Boolean).join('__') || speakerBase || 'dictor';
            return {
                folderName: folderBase || speakerBase || 'dictor',
                fileNamePrefix: packagePrefix,
                fullFileName: `${folderBase || speakerBase || 'dictor'}/${paddedNumber}__${packagePrefix}.mp3`
            };
        }

        const paddedNumber = String(fileNumber).padStart(4, '0');
        const folderName = this.scriptName ? `${folderBase} - ${speakerBase}` : speakerBase;
        const fileNamePrefix = this.scriptName ? `${folderBase} - ${speakerBase}` : speakerBase;
        return {
            folderName,
            fileNamePrefix,
            fullFileName: `${folderName}/${paddedNumber}_${fileNamePrefix}.mp3`
        };
    }

    setQueue(entries) {
        this.queue = entries.map(e => ({ ...e, status: 'pending', attempt: 0 }));
        this.currentIndex = 0;
        this.skippedEntries = []; 
        this.notifyProgress();
        this.log('Queue set:', this.queue.length);
    }

    log(msg, data = '') {
        console.log(`%c[Auto-Log] ${msg}`, 'color: #00ff00; font-weight: bold;', data);
    }

    error(msg, err = '') {
        console.error(`%c[Auto-Error] ${msg}`, 'color: #ff0000; font-weight: bold;', err);
        this.notifyError(msg);
    }

    normalizeVoiceLabel(value) {
        return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
    }

    voiceLabelsMatch(a, b) {
        const left = this.normalizeVoiceLabel(a);
        const right = this.normalizeVoiceLabel(b);
        return !!left && left === right;
    }

    closeVoiceModal() {
        const modalRoot = document.querySelector('.ant-modal-root .ant-modal-content, .ant-modal-content, .ant-modal');

        if (modalRoot) {
            const titleClosePath = modalRoot.querySelector('.ant-modal-title path[d^="M12 13.8998L7.10005 18.7998"]');
            if (titleClosePath) {
                const clickable = titleClosePath.closest('div.cursor-pointer, button, [role="button"], div');
                if (clickable) {
                    clickable.click();
                    return true;
                }
            }

            const genericClose = modalRoot.querySelector(
                '.ant-modal-close, .ant-modal-header div.cursor-pointer, button[aria-label*="Close"], button[aria-label*="close"]'
            );
            if (genericClose) {
                genericClose.click();
                return true;
            }
        }

        const closeBtn = this.getElementByXPath(this.selectors.closeModalBtnXPath);
        if (closeBtn) {
            closeBtn.click();
            return true;
        }

        return false;
    }

    installStealthVoiceModalStyle() {
        const style = document.createElement('style');
        style.setAttribute('data-minimax-voice-modal-stealth', 'true');
        style.textContent = `
            .ant-modal-root,
            .ant-modal-wrap,
            .ant-modal-mask {
                opacity: 0 !important;
                animation: none !important;
                transition: none !important;
            }
        `;
        (document.head || document.documentElement).appendChild(style);
        return () => {
            if (style.parentNode) style.parentNode.removeChild(style);
        };
    }

    getVoiceSelectorButton() {
        const currentVoiceNameEl = document.querySelector('section h4 > span, div.selected-voice-icon h4 > span, div[class*="selected-voice"] h4 > span');
        if (currentVoiceNameEl) {
            const clickable = currentVoiceNameEl.closest('[role="button"], button, div.cursor-pointer, div');
            if (clickable) return clickable;
        }

        const svgPath = document.querySelector('path[d^="M5.24492 3.34774"]');
        if (svgPath) {
            const clickable = svgPath.closest('[role="button"], button, div.cursor-pointer, div.flex, div');
            if (clickable) return clickable;
        }

        return null;
    }

    getVoiceTabButton(label) {
        const target = String(label || '').replace(/\s+/g, ' ').trim().toLowerCase();
        return Array.from(document.querySelectorAll('[role="tab"]')).find((tab) => {
            const text = String(tab.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
            return text === target;
        }) || null;
    }

    setNativeInputValue(input, value) {
        if (!input) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(input, value);
        else input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    async ensureSettingsPanelOpen() {
        const visibleVoiceHeading = Array.from(document.querySelectorAll('h4')).find(isVisibleElement);
        if (visibleVoiceHeading) return;

        const settingsTab = Array.from(document.querySelectorAll('h2, [role="tab"], button')).find((element) => {
            return isVisibleElement(element) && String(element.textContent || '').trim().toLowerCase() === 'settings';
        });
        if (!settingsTab) return;
        settingsTab.click();
        await this.sleep(500);
    }

    getCurrentVoiceCandidates() {
        const candidates = [];

        const pushCandidate = (value) => {
            const text = String(value || '').trim();
            if (text) candidates.push(text);
        };

        const headerNameEl = document.querySelector('section h4 > span') ||
                             document.querySelector('div.selected-voice-icon h4 > span') ||
                             document.querySelector('div[class*="selected-voice"] h4 > span');
        if (headerNameEl) pushCandidate(headerNameEl.textContent);

        const copyIcon = document.querySelector('h4 path[d^="M3.75 1.5C3.61192"]');
        const copyH4 = copyIcon ? copyIcon.closest('h4') : null;
        if (copyH4) {
            const spans = Array.from(copyH4.querySelectorAll('span'));
            spans.forEach((span) => pushCandidate(span.textContent));
        }

        return [...new Set(candidates)];
    }

    async tryReadCurrentVoiceFromCopyButton() {
        const copyIcon = document.querySelector('h4 path[d^="M3.75 1.5C3.61192"]');
        if (!copyIcon) return '';

        const copyH4 = copyIcon.closest('h4');
        const visibleLabel = copyH4?.querySelector('span')?.textContent?.trim() || '';

        const btn = copyIcon.closest('div');
        if (!btn || !navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
            return visibleLabel;
        }

        try {
            const readClipboard = () => Promise.race([
                navigator.clipboard.readText().then((value) => ({ ok: true, value })),
                new Promise((resolve) => setTimeout(() => resolve({ ok: false, value: '' }), 300))
            ]);
            const before = await readClipboard();
            if (!before.ok) return visibleLabel;
            btn.click();
            await this.sleep(120);
            const after = await readClipboard();
            if (after.ok && after.value.trim() && after.value !== before.value) {
                return after.value.trim();
            }
        } catch (e) {
            return visibleLabel;
        }

        return visibleLabel;
    }

    async isTargetVoiceAlreadyActive(targetId) {
        const candidates = this.getCurrentVoiceCandidates();
        if (candidates.some((candidate) => this.voiceLabelsMatch(candidate, targetId))) {
            return true;
        }

        const copied = await this.tryReadCurrentVoiceFromCopyButton();
        if (copied && this.voiceLabelsMatch(copied, targetId)) {
            return true;
        }

        return false;
    }

    findVoiceResultCards() {
        const modalRoot = document.querySelector('.ant-modal-root .ant-modal-content, .ant-modal-content, .ant-modal') || document;
        const cards = Array.from(modalRoot.querySelectorAll(
            '[role="tabpanel"] [class*="cursor-pointer"], [role="tabpanel"] [role="button"], [role="tabpanel"] button, #voice-selection-scroll-list .ant-list-item, #voice-selection-scroll-list > div > div, #voice-selection-scroll-list > div, div.grid > div'
        )).filter((card) => {
            const text = String(card && card.textContent || '').trim();
            return text && (card.querySelector('h4') || /use|selected/i.test(text));
        });
        const unique = [];
        const seen = new Set();
        cards.forEach((card) => {
            if (!card || seen.has(card)) return;
            seen.add(card);
            unique.push(card);
        });
        return unique;
    }

    extractVoiceNames(cards) {
        const names = [];
        const seen = new Set();

        cards.forEach((card) => {
            const heading = card.querySelector('h4');
            const voiceName = String(heading?.textContent || '').replace(/\s+/g, ' ').trim();
            if (!voiceName) return;

            const key = this.normalizeVoiceLabel(voiceName);
            if (!key || seen.has(key)) return;
            seen.add(key);
            names.push(voiceName);
        });

        return names;
    }

    async listVoicesFromUi(prefix = '') {
        const normalizedPrefix = this.normalizeVoiceLabel(prefix);
        const modalSelector = '.ant-modal-root .ant-modal-content, .ant-modal-content, .ant-modal, [role="dialog"]';
        let modal = document.querySelector(modalSelector);
        let openedByScript = false;
        let removeStealthStyle = null;

        try {
            if (!modal || !isVisibleElement(modal)) {
                const switchBtn = this.getVoiceSelectorButton();
                if (!switchBtn) {
                    return { ok: false, reason: 'voice_selector_button_not_found', voices: [] };
                }
                removeStealthStyle = this.installStealthVoiceModalStyle();
                switchBtn.click();
                openedByScript = true;
                const modalStartedAt = Date.now();
                while (Date.now() - modalStartedAt < 5000) {
                    modal = document.querySelector(modalSelector);
                    // The temporary stealth style intentionally sets opacity to zero.
                    // Once this method opened the modal itself, its presence is enough.
                    if (modal && (openedByScript || isVisibleElement(modal))) break;
                    await this.sleep(100);
                }
            }

            if (!modal || (!openedByScript && !isVisibleElement(modal))) {
                return { ok: false, reason: 'voice_modal_not_visible', voices: [] };
            }

            const myVoicesTab = this.getVoiceTabButton('My Voices');
            if (!myVoicesTab) {
                return { ok: false, reason: 'my_voices_tab_not_found', voices: [] };
            }
            if (myVoicesTab.getAttribute('aria-selected') !== 'true') {
                myVoicesTab.click();
                await this.sleep(800);
            }

            const input = await this.waitForElement(this.selectors.searchVoiceInput, 2500);
            if (input) {
                this.setNativeInputValue(input, prefix);
                await this.sleep(1200);
            }

            const voices = this.extractVoiceNames(this.findVoiceResultCards()).filter((name) => {
                if (!normalizedPrefix) return true;
                return this.normalizeVoiceLabel(name).includes(normalizedPrefix);
            });

            return { ok: true, voices };
        } finally {
            if (openedByScript) {
                this.closeVoiceModal();
                await this.sleep(120);
            }
            if (removeStealthStyle) removeStealthStyle();
        }
    }

    getVoiceActionState(scope) {
        const root = scope || document;
        const normalize = (v) => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const spans = Array.from(root.querySelectorAll('span'));

        const selectedSpan = spans.find((span) => normalize(span.textContent) === 'selected');
        if (selectedSpan) {
            const el = selectedSpan.closest('div.cursor-not-allowed, button, [role="button"], div') || selectedSpan;
            return { state: 'selected', element: el };
        }

        const useSpan = spans.find((span) => normalize(span.textContent) === 'use');
        if (useSpan) {
            const el = useSpan.closest('div.cursor-pointer, button, [role="button"], div') || useSpan;
            return { state: 'use', element: el };
        }

        // Fallback: иконка кнопки Use из текущего UI Minimax.
        const useIcon = root.querySelector('div.cursor-pointer path[d^="M11.2553 1.57855"]');
        if (useIcon) {
            const el = useIcon.closest('div.cursor-pointer, button, [role="button"], div') || useIcon;
            return { state: 'use', element: el };
        }

        // Fallback: disabled кнопка без явного текста.
        const selectedContainer = root.querySelector('div.cursor-not-allowed');
        if (selectedContainer) {
            return { state: 'selected', element: selectedContainer };
        }

        return null;
    }

    async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.isPaused = false;
        this.isStopped = false;
        this.startHeartbeat();
        this.notifyProgress();
        this.log('Automation STARTED');
        let terminalError = null;
        try {
            this.log('Ensuring Long Text mode is disabled...');
            await this.setLongTextMode(false);
            if (!this.isRunning) return;
            this.log('Regular Text mode is ready');
            await this.processQueue();
        } catch (error) {
            terminalError = error;
            const entry = this.queue[this.currentIndex];
            if (entry && entry.status !== 'completed') {
                entry.status = 'error';
                entry.error = error.message;
            }
            this.error('Fatal error in processQueue', error);
        } finally {
            this.isRunning = false;
            this.stopHeartbeat();
            if (!this.isStopped) this.notifyComplete(terminalError);
            this.log('Automation FINISHED');
        }
    }

    pause() { if (this.isRunning) { this.isPaused = true; this.notifyPause(); this.log('PAUSED'); } }
    resume() { if (this.isRunning && this.isPaused) { this.isPaused = false; this.notifyResume(); this.log('RESUMED'); } }
    stop() { this.isRunning = false; this.isPaused = false; this.isStopped = true; this.stopHeartbeat(); this.notifyStop(); this.log('STOPPED'); }

    async waitForDispatchAllowed() {
        while (this.isPaused && this.isRunning) await this.sleep(200);
        if (!this.isRunning) throw new Error('Stopped before paid submission dispatch');
    }

    async processQueue() {
        while (this.currentIndex < this.queue.length) {
            if (!this.isRunning) break;
            while (this.isPaused) await this.sleep(500);

            const entry = this.queue[this.currentIndex];
            const fileLabel = entry.sourceFileName ? ` File=${entry.sourceFileName}` : '';
            this.log(`Processing #${this.currentIndex + 1}:${fileLabel} Speaker=${entry.speaker}`);

            if (entry.text.length > 5000) {
                this.log('Skipping text > 5000 chars');
                const outputInfo = this.buildExpectedOutputInfo(entry);
                
                const skippedEntry = {
                    ...entry,
                    scriptName: entry.scriptName || this.scriptName,
                    mode: this.mode,
                    speakerIndex: Number(entry.speakerIndex || 1),
                    downloadIndex: Number(entry.downloadIndex || entry.speakerIndex || 1),
                    fullFileName: outputInfo.fullFileName,
                    folderName: outputInfo.folderName
                };
                
                this.skippedEntries.push(skippedEntry);
                chrome.runtime.sendMessage({
                    action: 'saveSkippedEntries',
                    entries: this.skippedEntries,
                    mode: this.mode
                }).catch(() => {});
                
                entry.status = 'skipped_manual';
                this.notifyProgress();
                this.currentIndex++;
                continue;
            }

            try {
                entry.status = 'processing';
                this.notifyProgress();

                await this.processEntry(entry);

                if (!this.isRunning) break;
                if (entry.status === 'skipped_voice_not_found') {
                    this.currentIndex++;
                    continue;
                }

                entry.status = 'completed';
                DiagLog.info('entry', 'Реплика готова', { speaker: entry.speaker, voiceId: entry.voiceId });
                this.notifyProgress();
                this.currentIndex++;
                await this.sleep(1000);
            } catch (error) {
                this.error(`Failed processing entry #${this.currentIndex}`, error);
                DiagLog.warn('entry', 'Ошибка обработки реплики', {
                    speaker: entry.speaker,
                    voiceId: entry.voiceId,
                    attempt: Number(entry.attempt || 0) + 1,
                    paidSubmissionStarted: !!entry.paidSubmissionStarted,
                    error: error.message
                });
                entry.attempt = Number(entry.attempt || 0) + 1;
                if (!entry.paidSubmissionStarted
                    && !entry.submissionRejected
                    && entry.attempt < MAX_ENTRY_ATTEMPTS
                    && this.isRunning) {
                    this.log(`Retrying entry (${entry.attempt + 1}/${MAX_ENTRY_ATTEMPTS})...`);
                    this.notifyProgress();
                    await this.sleep(2000);
                    continue;
                }
                entry.status = 'error';
                entry.error = entry.paidSubmissionStarted
                    ? `Generation may have been accepted; not retried: ${error.message}`
                    : error.message;
                this.notifyProgress();
                this.currentIndex++;
                throw new Error(entry.error);
            }
        }
    }

    async processEntry(entry) {
        const capability = await this.getDirectTtsCapability();
        if (!capability?.ok) {
            throw new Error(`MiniMax direct TTS is incompatible: ${capability?.reason || 'direct_tts_capability_unavailable'}`);
        }
        // Проверяем флаг остановки перед каждой операцией
        if (!this.isRunning) {
            this.log('STOP requested, aborting processEntry');
            return;
        }
        
        const voiceLabel = entry.voiceName || entry.voiceId;
        if (voiceLabel) {
            this.log(`Switching voice to: ${voiceLabel}`);
            try {
                await this.switchVoice(voiceLabel, entry.voiceId || '');
            }
            catch (e) {
                // Если голос не найден - пропускаем эту реплику
                if (String(e.message || '').toLowerCase().includes('not found')) {
                    this.log(`Voice "${voiceLabel}" not found, skipping entry`);
                    entry.status = 'skipped_voice_not_found';
                    this.notifyProgress();
                    return; // Выходим из processEntry, не обрабатываем эту реплику
                } else {
                    this.error('Voice switch FAILED', e);
                    throw new Error(`Voice switch failed: ${e.message}`);
                }
            }
        }

        if (!this.isRunning) {
            this.log('STOP requested, aborting after voice switch');
            return;
        }

        if (entry.language) {
            this.log(`Checking language: ${entry.language}`);
            await this.ensureLanguage(entry.language);
        }

        if (!this.isRunning) {
            this.log('STOP requested, aborting after language check');
            return;
        }

        const textarea = await this.waitForElement('[data-slate-editor="true"]', 5000);
        const targetEl = textarea || await this.waitForElement(this.selectors.textarea, 5000);

        if (!targetEl) throw new Error('Textarea (Slate editor) not found');

        // MiniMax may keep the prior entry in Slate after a generation. Clear it first
        // so the next insert is never appended to stale content.
        await this.clearText();

        // === ГЛАВНОЕ: Вставка текста (Замена всего старого на новое) ===
        await this.insertText(targetEl, entry.text);

        this.log('Waiting for React to validate input...');
        await this.sleep(1000); 

        if (!this.isRunning) {
            this.log('STOP requested, aborting before generate');
            return;
        }

        // Дожидаемся, пока кнопка генерации реально готова к следующему запуску.
        let generateBtn = await this.waitForGenerateButtonReady();
        if (!generateBtn) {
            throw new Error('Generate button not active');
        }

        const historyInstallResult = await this.callBridge('ensureLongTextHistoryCapture');
        if (!historyInstallResult?.ok) {
            throw new Error(`History capture install failed: ${historyInstallResult?.reason || 'unknown reason'}`);
        }
        const historyResetResult = await this.callBridge('resetLongTextHistoryCapture');
        if (!historyResetResult?.ok) {
            throw new Error(`History capture reset failed: ${historyResetResult?.reason || 'unknown reason'}`);
        }

        const submittedAt = Date.now();
        const baselineHistory = await this.queryLongTextHistory([], 30000);
        const baselineAudioIds = Array.isArray(baselineHistory.audioIds) ? baselineHistory.audioIds : [];
        await this.waitForDispatchAllowed();
        let submissionId = crypto.randomUUID();
        entry.paidSubmissionStarted = true;
        entry.submittedAt = submittedAt;
        entry.submissionId = submissionId;
        const durableReservation = await chrome.runtime.sendMessage({
            action: 'reserveRegularSubmission',
            submissionId,
            submittedAt,
            runId: this.runId,
            workerId: this.workerId,
            parallelKey: entry._parallelKey || null,
            text: entry.text,
            voiceId: entry.voiceId || '',
            voiceName: entry.voiceName || '',
            transport: 'direct',
            baselineAudioIds,
            speakerName: entry.speaker || entry.originalTag || '',
            scriptName: entry.scriptName || this.scriptName || null,
            downloadIndex: entry.downloadIndex || entry.speakerIndex || null,
            downloadLayout: entry.downloadLayout || null,
            sourceFileName: entry.sourceFileName || null,
            sourceFileBaseName: entry.sourceFileBaseName || null
        });
        if (!durableReservation?.success) {
            entry.paidSubmissionStarted = false;
            throw new Error(`Paid submission ledger failed: ${durableReservation?.reason || 'unknown error'}`);
        }
        if (this.runId) {
            const reservation = await chrome.runtime.sendMessage({
                action: 'reservePaidSubmission',
                runId: this.runId,
                workerId: this.workerId,
                parallelKey: entry._parallelKey,
                submittedAt
            });
            if (!reservation?.success) {
                entry.paidSubmissionStarted = false;
                await chrome.runtime.sendMessage({
                    action: 'completeRegularSubmission',
                    submissionId
                });
                throw new Error(`Paid submission reservation failed: ${reservation?.reason || 'unknown error'}`);
            }
        }
        this.notifyProgress();
        try {
            await this.waitForDispatchAllowed();
        } catch (error) {
            await this.rollbackUndispatchedSubmission(entry, submissionId);
            throw error;
        }
        let directResult = null;
            const dispatchMarker = await chrome.runtime.sendMessage({
                action: 'markRegularSubmissionSent',
                submissionId,
                sentAt: Date.now()
            });
            if (!dispatchMarker?.success) {
                await this.rollbackUndispatchedSubmission(entry, submissionId);
                throw new Error(`Paid submission dispatch marker failed: ${dispatchMarker?.reason || 'unknown error'}`);
            }
            try {
                await this.waitForDispatchAllowed();
            } catch (error) {
                await this.rollbackUndispatchedSubmission(entry, submissionId);
                throw error;
            }
            directResult = await this.callDirectBridge(
                'generateDirectAudio',
                entry.text,
                '',
                entry.voiceId || ''
            );
            await chrome.storage.local.set({
                directTtsLastResult: {
                    mode: 'regular',
                    recordedAt: Date.now(),
                    ok: directResult?.ok === true,
                    disposition: directResult?.disposition || 'bridge_failed',
                    category: directResult?.category || '',
                    code: directResult?.code ?? null,
                    responseMeta: directResult?.responseMeta || null
                }
            });
            if (!directResult?.ok && ['not_sent', 'not_invoked'].includes(directResult?.disposition)) {
                DiagLog.warn('direct', 'Прямая отправка не состоялась (не оплачено)', {
                    speaker: entry.speaker,
                    disposition: directResult?.disposition,
                    code: directResult?.code ?? null,
                    reason: directResult?.reason || null
                });
                entry.paidSubmissionStarted = false;
                const ledgerRelease = await chrome.runtime.sendMessage({
                    action: 'completeRegularSubmission',
                    submissionId
                });
                if (!ledgerRelease?.success) {
                    throw new Error(`Paid submission ledger release failed: ${ledgerRelease?.reason || 'unknown error'}`);
                }
                if (this.runId) {
                    const release = await chrome.runtime.sendMessage({
                        action: 'releasePaidSubmission',
                        runId: this.runId,
                        workerId: this.workerId,
                        parallelKey: entry._parallelKey
                    });
                    if (!release?.success) {
                        throw new Error(`Paid submission release failed: ${release?.reason || 'unknown error'}`);
                    }
                }
                throw new Error(`Direct generation was not sent: ${directResult?.reason || directResult?.disposition || 'unknown'}`);
            } else if (!directResult?.ok) {
                DiagLog.warn('direct', 'Прямая отправка в неоднозначном состоянии — нужна сверка с History', {
                    speaker: entry.speaker,
                    disposition: directResult?.disposition,
                    code: directResult?.code ?? null,
                    reason: directResult?.reason || null
                });
                if (directResult?.disposition === 'rejected') {
                    const ledgerCleanup = await chrome.runtime.sendMessage({
                        action: 'completeRegularSubmission',
                        submissionId
                    });
                    let parallelCleanup = { success: true };
                    if (this.runId) {
                        parallelCleanup = await chrome.runtime.sendMessage({
                            action: 'releasePaidSubmission',
                            runId: this.runId,
                            workerId: this.workerId,
                            parallelKey: entry._parallelKey
                        });
                    }
                    if (!ledgerCleanup?.success || !parallelCleanup?.success) {
                        throw new Error('Direct rejection cleanup failed; reconciliation required');
                    }
                    entry.paidSubmissionStarted = false;
                    entry.submissionRejected = true;
                }
                throw new Error(`Direct generation may have been accepted: ${directResult?.reason || directResult?.disposition || 'unknown'}`);
            } else {
                this.log(`Direct audio completed (${directResult.size || 0} bytes)`);
                DiagLog.info('direct', 'Генерация готова', {
                    speaker: entry.speaker,
                    voiceId: entry.voiceId,
                    bytes: directResult.size || 0,
                    durationMs: directResult.durationMs ?? null
                });
            }

        const fileNameBase = entry.originalTag || entry.speaker || 'dictor';
        let downloadRes;

        if (directResult?.ok && directResult.dataUrl) {
            downloadRes = await chrome.runtime.sendMessage({
                action: 'downloadAudioData',
                dataUrl: directResult.dataUrl,
                voiceName: fileNameBase,
                scriptName: entry.scriptName || null,
                forceIndex: entry.downloadIndex || entry.speakerIndex || null,
                speakerName: entry.speaker || null,
                downloadLayout: entry.downloadLayout || null,
                sourceFileName: entry.sourceFileName || null,
                sourceFileBaseName: entry.sourceFileBaseName || null,
                submissionId
            });
        } else {
            throw new Error('Direct generation returned no downloadable audio');
        }
        if (!downloadRes || !downloadRes.success) {
            throw new Error(`Audio download failed: ${downloadRes && downloadRes.reason ? downloadRes.reason : 'unknown reason'}`);
        }
        this.log(`Download started (id: ${downloadRes.downloadId || 'n/a'})`);
        this.log(`Download confirmed (index: ${downloadRes.fileNumber || 'n/a'})`);
        entry.downloadConfirmed = true;
        const completion = await chrome.runtime.sendMessage({
            action: 'completeRegularSubmission',
            submissionId
        });
        if (!completion?.success) {
            throw new Error(`Paid submission completion failed: ${completion?.reason || 'unknown error'}`);
        }
        entry.paidSubmissionStarted = false;
        if (this.runId) this.notifyProgress();

        await this.clearText();
    }

    async rollbackUndispatchedSubmission(entry, submissionId) {
        const ledgerCleanup = await chrome.runtime.sendMessage({
            action: 'completeRegularSubmission',
            submissionId
        });
        let parallelCleanup = { success: true };
        if (this.runId) {
            parallelCleanup = await chrome.runtime.sendMessage({
                action: 'releasePaidSubmission',
                runId: this.runId,
                workerId: this.workerId,
                parallelKey: entry._parallelKey
            });
        }
        if (!ledgerCleanup?.success || !parallelCleanup?.success) {
            throw new Error('Pre-dispatch rollback failed; reconciliation required');
        }
        entry.paidSubmissionStarted = false;
    }

    // ============================================
    // MAIN WORLD BRIDGE
    // Content script живёт в isolated world и не видит __reactFiber$.
    // Все операции с Slate state идут через background.js -> chrome.scripting.executeScript с world:'MAIN'.
    // ============================================

    async callBridge(action, ...args) {
        // Шлём только имя метода (строку) и аргументы.
        // Сами функции определены в background.js — Chrome не сериализует функции через sendMessage.
        const response = await Promise.race([
            chrome.runtime.sendMessage({
                action: 'executeInMainWorld',
                method: action,
                args
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('bridge_timeout')), 15000))
        ]);

        if (!response || !response.success) {
            this.error('Bridge call failed: ' + (response && response.reason || 'unknown'));
            return null;
        }
        return response.result;
    }

    async callDirectBridge(action, ...args) {
        try {
            const response = await Promise.race([
                chrome.runtime.sendMessage({
                    action: 'executeInMainWorld',
                    method: action,
                    args
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('bridge_timeout')), 15000))
            ]);
            if (!response?.success) {
                return { ok: false, disposition: 'accepted_unknown', reason: response?.reason || 'direct_bridge_response_failed' };
            }
            return response.result || { ok: false, disposition: 'accepted_unknown', reason: 'direct_bridge_empty_result' };
        } catch (error) {
            if (error?.message === 'bridge_timeout') {
                return { ok: false, disposition: 'bridge_timeout', reason: 'bridge_timeout' };
            }
            return { ok: false, disposition: 'accepted_unknown', reason: error?.message || 'direct_bridge_response_failed' };
        }
    }

    // --- ОЧИСТКА Slate перед следующей репликой ---
    async clearText() {
        this.log('Clearing editor before next insert...');
        const result = await this.callBridge('clearTextContent');
        if (!result?.ok) {
            throw new Error(`Editor clear failed: ${result?.reason || 'unknown reason'}`);
        }

        await this.sleep(300);
        const remainingText = await this.callBridge('getText');
        if (String(remainingText || '').trim()) {
            throw new Error('Editor still contains text after clear');
        }
    }

    // --- ВСТАВКА через main world bridge ---
    async insertText(el, text) {
        text = String(text || '').replace(/\r\n?|\n/g, ' ');
        this.log(`🚀 Slate Insert (Length: ${text.length})...`);
        const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();

        const result = await this.callBridge('insertText', text);
        if (!result || !result.ok) {
            throw new Error('insertText via bridge failed: ' + (result && result.reason || 'unknown'));
        }
        this.log('✅ beforeinput dispatched via main world bridge');

        // Ожидание обновления state
        const waitTime = Math.max(1500, Math.ceil(text.length / 1000) * 200);
        this.log(`   ⏳ Waiting ${waitTime}ms for Slate...`);
        await this.sleep(waitTime);

        // Проверяем state
        let slateText = null;
        let confirmed = false;
        for (let attempt = 0; attempt < 5 && !confirmed; attempt++) {
            if (attempt > 0) await this.sleep(500);
            slateText = await this.callBridge('getText');
            confirmed = normalizeText(slateText) === normalizeText(text);
        }
        if (confirmed) {
            this.log(`✅ Slate state confirmed: "${slateText.slice(0, 50)}${slateText.length > 50 ? '...' : ''}"`);
        } else {
            this.log('⚠️ Slate state mismatch, пробуем paste fallback...');
            const freshEl = document.querySelector('[data-slate-editor="true"]');
            if (freshEl) {
                const dataTransfer = new DataTransfer();
                dataTransfer.setData('text/plain', text);
                freshEl.dispatchEvent(new ClipboardEvent('paste', {
                    bubbles: true, cancelable: true, clipboardData: dataTransfer, view: window
                }));
                await this.sleep(waitTime);
            }
            slateText = await this.callBridge('getText');
            if (normalizeText(slateText) !== normalizeText(text)) {
                throw new Error(`Editor text mismatch after insert. Expected ${text.length} chars, got ${(slateText || '').length}`);
            }
        }

        await this.sleep(300);
    }

    // --- Остальные методы без изменений ---
    
    async switchVoice(targetId, expectedVoiceId = '') {
        // 1. ОПТИМИЗАЦИЯ: Сначала проверяем внутреннее состояние
        if (this.currentVoiceId === targetId) {
            this.log(`Voice "${targetId}" internal state matches, skipping switch`);
            if (!expectedVoiceId || await this.isExpectedVoiceIdActive(expectedVoiceId)) return;
        }

        await this.ensureSettingsPanelOpen();

        // 2. Проверяем реальный DOM (в т.ч. блок с copy-иконкой в h4)
        if (await this.isTargetVoiceAlreadyActive(targetId)) {
            this.log(`DOM Check: Voice "${targetId}" is already active on page.`);
            this.currentVoiceId = targetId;
            if (!expectedVoiceId || await this.isExpectedVoiceIdActive(expectedVoiceId)) return;
            this.currentVoiceId = null;
        }

        this.log('1. Clicking voice selector...');

        let switchBtn = null;
        let attempts = 0;
        while(!switchBtn && attempts < 10) {
            switchBtn = this.getVoiceSelectorButton();
            if (!switchBtn) {
                 const xpathResult = document.evaluate(this.selectors.switchVoiceBtnXPath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                switchBtn = xpathResult.singleNodeValue;
            }
            if(!switchBtn) { await this.sleep(500); attempts++; }
        }

        if (!switchBtn) throw new Error('Could not find Voice Selector button');
        switchBtn.click();
        await this.sleep(1500);
        let modalOpened = true;

        try {
            const targetTabs = targetId.startsWith('moss_audio_') ? ['My Voices'] : ['My Voices', 'Library'];
            let applied = false;

            for (const targetTab of targetTabs) {
                let tabButton = this.getVoiceTabButton(targetTab);
                if (!tabButton) {
                    const legacyTabId = targetTab === 'My Voices' ? 'MyVoices' : targetTab;
                    const tabXPath = `//div[@role="tab" and @id[contains(., "${legacyTabId}")]]`;
                    tabButton = this.getElementByXPath(tabXPath);
                }

                if (tabButton && !tabButton.classList.contains('ant-tabs-tab-active') && tabButton.getAttribute('aria-selected') !== 'true') {
                    this.log(`Switching to ${targetTab} tab...`);
                    tabButton.click();
                    await this.sleep(1000);
                }

                const input = await this.waitForElement(this.selectors.searchVoiceInput, 5000);
                if (!input) continue;

                this.setNativeInputValue(input, '');
                await this.sleep(200);
                this.setNativeInputValue(input, targetId);
                await this.sleep(1800);

                const cards = this.findVoiceResultCards();
                const normalizedTarget = this.normalizeVoiceLabel(targetId);
                let targetCard = cards.find((card) => {
                    const heading = this.normalizeVoiceLabel(card.querySelector('h4')?.textContent || '');
                    return heading === normalizedTarget;
                });
                if (!targetCard) continue;

                targetCard.click();
                await this.sleep(200);

                const actionState = this.getVoiceActionState(targetCard);
                if (!actionState) continue;
                this.log(`[VoiceSwitch] action=${actionState.state} via ${targetTab}`);

                if (actionState.state === 'selected') {
                    if (!await this.isTargetVoiceAlreadyActive(targetId)) continue;
                    this.log('Voice already selected in search result.');
                    this.currentVoiceId = targetId;
                    applied = true;
                    break;
                }

                if (actionState.state === 'use') {
                    this.log('[VoiceSwitch] clicking Use');
                    actionState.element.click();
                    await this.sleep(1000);
                    if (!await this.isTargetVoiceAlreadyActive(targetId)) continue;
                    this.currentVoiceId = targetId;
                    applied = true;
                    break;
                }
            }

            if (!applied) throw new Error(`Voice ID "${targetId}" not found`);
            if (expectedVoiceId && !await this.isExpectedVoiceIdActive(expectedVoiceId)) {
                this.currentVoiceId = null;
                throw new Error(`Voice "${targetId}" did not apply expected ID ${expectedVoiceId}`);
            }
        } finally {
            if (modalOpened) {
                this.closeVoiceModal();
            }
        }
    }

    async isExpectedVoiceIdActive(expectedVoiceId) {
        const state = await this.callBridge('getDirectTtsReadyState', '', expectedVoiceId);
        return String(state?.voiceId || '') === String(expectedVoiceId || '');
    }

    async ensureLanguage(targetLang) {
        const getCurrentLanguageText = () => {
            const currentValEl = document.querySelector(this.selectors.languageCurrentValue);
            return currentValEl ? currentValEl.innerText.trim() : '';
        };

        const trigger = document.querySelector(this.selectors.languageDropdownTrigger);
        if (!trigger) throw new Error('Language selector not found');

        const currentText = getCurrentLanguageText();

        if (currentText === targetLang) return;

        const chooseLanguageOption = async () => {
            trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            trigger.click();
            await this.sleep(1000);

            const optionXPath = this.selectors.languageOptionXPath(targetLang);
            let option = this.getElementByXPath(optionXPath);

            if (!option) {
                const dropdowns = document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .rc-virtual-list-holder');
                const listHolder = dropdowns[dropdowns.length - 1];
                if (listHolder) {
                    for (let i = 0; i < 10; i++) {
                        listHolder.scrollTop += 200;
                        await this.sleep(200);
                        option = this.getElementByXPath(optionXPath);
                        if (option) break;
                    }
                }
            }

            if (!option) {
                trigger.click();
                return false;
            }

            option.scrollIntoView({ block: 'center' });
            await this.sleep(200);
            option.click();
            await this.sleep(800);
            return getCurrentLanguageText() === targetLang;
        };

        for (let attempt = 0; attempt < 2; attempt++) {
            const applied = await chooseLanguageOption();
            if (applied) return;
            await this.sleep(400);
        }

        throw new Error(`Language "${targetLang}" was not applied`);
    }

    getElementByXPath(xpath) {
        return document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
    }

    async getCapturedAudioData(timeout = 10000) {
        const result = await this.callBridge('consumeCapturedAudio', timeout);
        if (!result || !result.ok) {
            throw new Error(result && result.reason ? result.reason : 'Audio capture failed');
        }
        if (result.src) {
            this.log(`Audio source candidate found: ${String(result.src).slice(0, 120)}`);
        }
        if (typeof result.dataUrl === 'string' && result.dataUrl.startsWith('data:audio/')) {
            return result;
        }
        throw new Error('Audio blob conversion failed');
    }

    async findGenerateButton() {
        const btns = Array.from(document.querySelectorAll('button'));
        return btns.find(btn => {
            const text = btn.textContent.toLowerCase();
            return (text.includes('generate') || text.includes('create') || text.includes('regenerate')) && !btn.closest('.nav-list'); 
        });
    }

    async waitForGenerateButtonReady(timeout = 30000) {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeout) {
            const btn = await this.findGenerateButton();
            if (btn) {
                const text = String(btn.textContent || '').trim().toLowerCase();
                const isBusy = text.includes('generating');
                const isDisabled = !!btn.disabled || btn.classList.contains('opacity-60');
                if (!isBusy && !isDisabled) {
                    return btn;
                }
            }
            await this.sleep(300);
        }
        return null;
    }

    async waitForElement(sel, timeout=5000) {
        const start = Date.now();
        while(Date.now() - start < timeout) {
            const el = document.querySelector(sel);
            if(el) return el;
            await this.sleep(100);
        }
        return null;
    }

    sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    notifyProgress() {
        chrome.runtime.sendMessage({
            action: 'automationProgress',
            currentIndex: this.currentIndex,
            queue: this.queue,
            runId: this.runId,
            workerId: this.workerId,
            legacyJobId: this.legacyJobId
        }).catch(()=>{});
        chrome.runtime.sendMessage({
            action: 'updateAutomationProgress',
            runId: this.runId,
            workerId: this.workerId,
            progress: {
                currentIndex: this.currentIndex,
                total: this.queue.length,
                isRunning: this.isRunning,
                isPaused: this.isPaused,
                completedIds: this.queue
                    .slice(0, this.currentIndex)
                    .filter(e => e.status === 'completed')
                    .map(e => e.id)
            }
        }).catch(()=>{});
    }
    notifyComplete(error = null) {
        DiagLog.info('automation', 'Воркер закончил очередь', {
            runId: this.runId,
            workerId: this.workerId,
            success: !error,
            completed: this.currentIndex,
            total: this.queue.length,
            error: error?.message || null
        });
        chrome.runtime.sendMessage({
            action: 'automationComplete',
            success: !error,
            unresolved: !!error && this.queue.some((entry) => entry.paidSubmissionStarted),
            error: error?.message || null,
            completed: this.currentIndex,
            queue: this.queue,
            runId: this.runId,
            workerId: this.workerId,
            legacyJobId: this.legacyJobId
        }).catch(()=>{});
        chrome.runtime.sendMessage({
            action: 'updateAutomationProgress',
            runId: this.runId,
            workerId: this.workerId,
            progress: { isRunning: false, isPaused: false, currentIndex: this.currentIndex, total: this.queue.length }
        }).catch(()=>{});
    }
    notifyPause() { chrome.runtime.sendMessage({ action: 'automationPaused', runId: this.runId, workerId: this.workerId }).catch(()=>{}); this.updateState(); }
    notifyResume() { chrome.runtime.sendMessage({ action: 'automationResumed', runId: this.runId, workerId: this.workerId }).catch(()=>{}); this.updateState(); }
    notifyStop() {
        DiagLog.info('automation', 'Воркер остановлен', { runId: this.runId, workerId: this.workerId, completed: this.currentIndex, total: this.queue.length });
        chrome.runtime.sendMessage({ action: 'automationStopped', runId: this.runId, workerId: this.workerId }).catch(()=>{});
        chrome.runtime.sendMessage({ action: 'clearAutomationState', runId: this.runId, workerId: this.workerId }).catch(()=>{});
    }
    notifyError(msg) {
        DiagLog.error('automation', 'Воркер сообщил об ошибке', { runId: this.runId, workerId: this.workerId, error: msg });
        chrome.runtime.sendMessage({ action: 'automationError', error: msg, runId: this.runId, workerId: this.workerId }).catch(()=>{});
    }

    updateState() {
        chrome.runtime.sendMessage({
            action: 'updateAutomationProgress',
            runId: this.runId,
            workerId: this.workerId,
            progress: {
                currentIndex: this.currentIndex,
                total: this.queue.length,
                isRunning: this.isRunning,
                isPaused: this.isPaused
            }
        }).catch(()=>{});
    }
}
