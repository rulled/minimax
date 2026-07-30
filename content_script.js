// Храним состояние расширения
let extensionEnabled = false;
let isInitialized = false;
let automationOverrideIndex = null;
let automationOverrideSpeaker = null; 
let automationOverrideScriptName = null; 
let currentAutomationMode = 'single'; 

// Сохранение пропущенных записей
let skippedEntriesBuffer = [];

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

initialize();

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
    if (!extensionEnabled) {
      sendResponse({ success: false, reason: 'disabled' });
      return true;
    }
    if (!automation || !automation.isRunning) automation = new VoiceoverAutomation();
    automation.setRunContext(request.runId || null, request.workerId || null);
    automation.setQueue(request.queue);
    automation.setMode(request.mode || 'single');
    automation.setScriptName(request.scriptName || null);
    automation.start();
    sendResponse({ success: true });
    return true;
  }
  if (request.action === 'pauseAutomation') {
    if (automation) automation.pause();
    sendResponse({ success: true });
    return true;
  }
  if (request.action === 'resumeAutomation') {
    if (automation) automation.resume();
    sendResponse({ success: true });
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
        workerId: automation?.workerId || null
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
    automation.prepareParallelWorker(request.voiceId || '', request.language || 'Auto')
      .then(() => sendResponse({ success: true }))
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
    if (automation.isRunning) {
      sendResponse({ success: false, reason: 'automation_running' });
      return true;
    }
    automation.queryLongTextHistory(request.tasks || [])
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
  if (request.action === 'listVoicesFromUi') {
    if (!automation) automation = new VoiceoverAutomation();
    automation.listVoicesFromUi(request.prefix || '').then((result) => {
      sendResponse({
        success: !!result?.ok,
        voices: Array.isArray(result?.voices) ? result.voices : [],
        reason: result?.reason || null
      });
    }).catch((error) => {
      sendResponse({
        success: false,
        voices: [],
        reason: error?.message || 'list_voices_from_ui_failed'
      });
    });
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
        this.skippedEntries = []; 
        
        this.selectors = {
            textarea: '[data-slate-editor="true"]',
            switchVoiceBtnXPath: '//div[contains(@class, "flex") and .//path[starts-with(@d, "M5.24492 3.34774")]',
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

    async prepareParallelWorker(voiceId, language) {
        const editor = await this.waitForElement('[data-slate-editor="true"]', 5000);
        const generateButton = await this.findGenerateButton();
        if (!editor || !generateButton) throw new Error('MiniMax editor is not ready');
        if (voiceId) await this.switchVoice(voiceId);
        if (language) await this.ensureLanguage(language);
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

    async queryLongTextHistory(tasks) {
        const installResult = await this.callBridge('ensureLongTextHistoryCapture');
        if (!installResult?.ok) throw new Error(installResult?.reason || 'history_capture_install_failed');
        const resetResult = await this.callBridge('resetLongTextHistoryCapture');
        if (!resetResult?.ok) throw new Error(resetResult?.reason || 'history_capture_reset_failed');

        const historyTab = this.getPageTab('History');
        if (!historyTab) throw new Error('History tab not found');
        if (historyTab.getAttribute('aria-selected') === 'true') {
            await this.openPageTab('Settings');
        }
        historyTab.click();

        const result = await this.callBridge('consumeLongTextHistory', tasks, 12000);
        await this.openPageTab('Settings');
        if (!result?.ok) throw new Error(result?.reason || 'history_query_failed');
        return result;
    }

    async submitLongText(task) {
        if (!task || !task.text) throw new Error('Long Text task is empty');
        if (String(task.text).length <= 5000 || String(task.text).length > 200000) {
            throw new Error('Long Text length is outside 5001-200000');
        }

        await this.openPageTab('Settings');
        if (task.voiceId) await this.switchVoice(task.voiceId);
        if (task.language) await this.ensureLanguage(task.language);
        await this.setLongTextMode(true);

        const editor = await this.waitForElement('[data-slate-editor="true"]', 5000);
        if (!editor) throw new Error('Textarea (Slate editor) not found');
        await this.insertText(editor, task.text);

        const generateButton = await this.waitForGenerateButtonReady(30000);
        if (!generateButton) throw new Error('Generate button not active for Long Text');
        generateButton.click();

        const proceedButton = await this.waitForVisibleButtonByText('Proceed', 10000);
        if (!proceedButton) throw new Error('Long Text Proceed button not found');
        const submittedAt = Date.now();
        proceedButton.click();
        await this.sleep(1000);
        return { submittedAt };
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
                await this.sleep(900);
                modal = document.querySelector(modalSelector);
            }

            if (!modal || !isVisibleElement(modal)) {
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
        this.notifyProgress();
        this.log('Automation STARTED');
        try {
            this.log('Ensuring Long Text mode is disabled...');
            await this.setLongTextMode(false);
            if (!this.isRunning) return;
            this.log('Regular Text mode is ready');
            await this.processQueue();
        } catch (error) {
            const entry = this.queue[this.currentIndex];
            if (entry && entry.status !== 'completed') {
                entry.status = 'error';
                entry.error = error.message;
            }
            this.error('Fatal error in processQueue', error);
        } finally {
            this.isRunning = false;
            if (!this.isStopped) this.notifyComplete();
            this.log('Automation FINISHED');
        }
    }

    pause() { if (this.isRunning) { this.isPaused = true; this.notifyPause(); this.log('PAUSED'); } }
    resume() { if (this.isRunning && this.isPaused) { this.isPaused = false; this.notifyResume(); this.log('RESUMED'); } }
    stop() { this.isRunning = false; this.isPaused = false; this.isStopped = true; this.notifyStop(); this.log('STOPPED'); }

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
                this.notifyProgress();
                this.currentIndex++;
                await this.sleep(1000);
            } catch (error) {
                this.error(`Failed processing entry #${this.currentIndex}`, error);
                entry.attempt++;
                if (entry.attempt < 2 && this.isRunning && !this.runId) {
                    this.log('Retrying...');
                    await this.sleep(2000);
                    continue;
                }
                entry.status = 'error';
                entry.error = error.message;
                this.currentIndex++;
            }
        }
    }

    async processEntry(entry) {
        // Проверяем флаг остановки перед каждой операцией
        if (!this.isRunning) {
            this.log('STOP requested, aborting processEntry');
            return;
        }
        
        if (entry.voiceId) {
            this.log(`Switching voice to: ${entry.voiceId}`);
            try {
                await this.switchVoice(entry.voiceId);
            }
            catch (e) {
                // Если голос не найден - пропускаем эту реплику
                if (String(e.message || '').toLowerCase().includes('not found')) {
                    this.log(`Voice "${entry.voiceId}" not found, skipping entry`);
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

        const captureInstallResult = await this.callBridge('ensureAudioCaptureInstalled');
        if (!captureInstallResult || !captureInstallResult.ok) {
            throw new Error(`Audio capture install failed: ${captureInstallResult && captureInstallResult.reason ? captureInstallResult.reason : 'unknown reason'}`);
        }
        this.log(captureInstallResult.alreadyInstalled ? 'Audio capture installed (already active)' : 'Audio capture installed');

        const captureResetResult = await this.callBridge('resetAudioCaptureSession');
        if (!captureResetResult || !captureResetResult.ok) {
            throw new Error(`Audio capture reset failed: ${captureResetResult && captureResetResult.reason ? captureResetResult.reason : 'unknown reason'}`);
        }
        this.log('Audio capture session reset');

        const historyInstallResult = await this.callBridge('ensureLongTextHistoryCapture');
        if (!historyInstallResult?.ok) {
            throw new Error(`History capture install failed: ${historyInstallResult?.reason || 'unknown reason'}`);
        }
        const historyResetResult = await this.callBridge('resetLongTextHistoryCapture');
        if (!historyResetResult?.ok) {
            throw new Error(`History capture reset failed: ${historyResetResult?.reason || 'unknown reason'}`);
        }

        const submittedAt = Date.now();
        generateBtn.click();
        this.log('Clicked Generate');

        if (!this.isRunning) {
            this.log('STOP requested, aborting after generate click');
            return;
        }

        this.log('Waiting for generated audio in History...');

        if (!this.isRunning) {
            this.log('STOP requested, aborting before download');
            return;
        }

        const fileNameBase = entry.originalTag || entry.speaker || 'dictor';
        const historyResult = await this.callBridge('consumeGeneratedAudioHistory', {
            text: entry.text,
            voiceId: entry.voiceId || '',
            submittedAt
        }, 60000);
        if (!this.isRunning) {
            this.log('STOP requested, discarding generated audio');
            return;
        }
        const historyRecord = historyResult?.record;
        let downloadRes;

        if (historyRecord?.status === 0 && historyRecord.audioUrl) {
            this.log(`Audio matched in History: ${historyRecord.audioId}`);
            downloadRes = await chrome.runtime.sendMessage({
                action: 'downloadFile',
                url: historyRecord.audioUrl,
                forceIndex: entry.downloadIndex || entry.speakerIndex || null,
                forceSpeaker: entry.speaker || fileNameBase,
                scriptName: entry.scriptName || null,
                downloadLayout: entry.downloadLayout || null,
                sourceFileName: entry.sourceFileName || null,
                sourceFileBaseName: entry.sourceFileBaseName || null
            });
        } else {
            this.log('History match unavailable, falling back to MediaSource capture');
            const captureResult = await this.getCapturedAudioData(this.runId ? 120000 : 180000);
            this.log(`Audio captured via ${captureResult.source || 'unknown'} (${captureResult.size || 0} bytes)`);
            downloadRes = await chrome.runtime.sendMessage({
                action: 'downloadAudioData',
                dataUrl: captureResult.dataUrl,
                voiceName: fileNameBase,
                scriptName: entry.scriptName || null,
                forceIndex: entry.downloadIndex || entry.speakerIndex || null,
                speakerName: entry.speaker || null,
                downloadLayout: entry.downloadLayout || null,
                sourceFileName: entry.sourceFileName || null,
                sourceFileBaseName: entry.sourceFileBaseName || null
            });
        }
        if (!downloadRes || !downloadRes.success) {
            throw new Error(`Audio download failed: ${downloadRes && downloadRes.reason ? downloadRes.reason : 'unknown reason'}`);
        }
        this.log(`Download started (id: ${downloadRes.downloadId || 'n/a'})`);
        this.log(`Download confirmed (index: ${downloadRes.fileNumber || 'n/a'})`);
        entry.downloadConfirmed = true;
        if (this.runId) this.notifyProgress();

        this.log('Waiting for MiniMax UI to settle...');
        generateBtn = await this.waitForGenerateButtonReady(10000);
        if (!generateBtn) {
            this.log('MiniMax UI still busy after final signal, waiting grace period...');
            generateBtn = await this.waitForGenerateButtonReady(10000);
            if (!generateBtn) {
                throw new Error('MiniMax UI did not settle after final signal');
            }
        }
        this.log('UI settled, proceeding');

          await this.sleep(1500);
          // Очистка в конце, чтобы подготовить почву (но insertText тоже очистит)
        await this.clearText();
    }

    // ============================================
    // MAIN WORLD BRIDGE
    // Content script живёт в isolated world и не видит __reactFiber$.
    // Все операции с Slate state идут через background.js -> chrome.scripting.executeScript с world:'MAIN'.
    // ============================================

    async callBridge(action, ...args) {
        // Шлём только имя метода (строку) и аргументы.
        // Сами функции определены в background.js — Chrome не сериализует функции через sendMessage.
        const response = await chrome.runtime.sendMessage({
            action: 'executeInMainWorld',
            method: action,
            args
        });

        if (!response || !response.success) {
            this.error('Bridge call failed: ' + (response && response.reason || 'unknown'));
            return null;
        }
        return response.result;
    }

    // --- ОЧИСТКА: просто выставляем selection на всё (замена произойдёт при следующей вставке) ---
    async clearText() {
        this.log('🧹 Preparing editor for next insert...');
        const ok = await this.callBridge('selectAll');
        if (ok) {
            this.log('   ✨ Selection set to full range.');
        } else {
            this.log('   ⚠️ selectAll returned false (editor empty or not found).');
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
        const waitTime = text.length > 500 ? 1500 : 800;
        this.log(`   ⏳ Waiting ${waitTime}ms for Slate...`);
        await this.sleep(waitTime);

        // Проверяем state
        let slateText = await this.callBridge('getText');
        if (normalizeText(slateText) === normalizeText(text)) {
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
    
    async switchVoice(targetId) {
        // 1. ОПТИМИЗАЦИЯ: Сначала проверяем внутреннее состояние
        if (this.currentVoiceId === targetId) {
            this.log(`Voice "${targetId}" internal state matches, skipping switch`);
            return;
        }

        await this.ensureSettingsPanelOpen();

        // 2. Проверяем реальный DOM (в т.ч. блок с copy-иконкой в h4)
        if (await this.isTargetVoiceAlreadyActive(targetId)) {
            this.log(`DOM Check: Voice "${targetId}" is already active on page.`);
            this.currentVoiceId = targetId;
            return;
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
        } finally {
            if (modalOpened) {
                this.closeVoiceModal();
            }
        }
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
            workerId: this.workerId
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
    notifyComplete() {
        chrome.runtime.sendMessage({
            action: 'automationComplete',
            completed: this.currentIndex,
            queue: this.queue,
            runId: this.runId,
            workerId: this.workerId
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
        chrome.runtime.sendMessage({ action: 'automationStopped', runId: this.runId, workerId: this.workerId }).catch(()=>{});
        chrome.runtime.sendMessage({ action: 'clearAutomationState', runId: this.runId, workerId: this.workerId }).catch(()=>{});
    }
    notifyError(msg) { chrome.runtime.sendMessage({ action: 'automationError', error: msg, runId: this.runId, workerId: this.workerId }).catch(()=>{}); }

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
