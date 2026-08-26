const CDP_PORT = process.env.MINIMAX_CDP_PORT || '9223';
const CDP_BASE_URL = `http://127.0.0.1:${CDP_PORT}`;
const fs = require('node:fs');
const path = require('node:path');
const { parseMarkdown } = require('./parser');
const { resolveVoice } = require('./voice_mapping');

async function getTargets() {
  return fetch(`${CDP_BASE_URL}/json/list`).then((response) => response.json());
}

async function evaluate(target, expression) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });

  return new Promise((resolve, reject) => {
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      socket.close();
      if (message.error) return reject(new Error(message.error.message));
      if (message.result?.exceptionDetails) {
        return reject(new Error(message.result.exceptionDetails.exception?.description || message.result.exceptionDetails.text));
      }
      resolve(message.result?.result?.value);
    };
    socket.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true },
    }));
  });
}

async function main() {
  const paidCommands = [
    '--start-parallel-test',
    '--start-source-parallel-test',
    '--start-three-voice-source-parallel-test',
    '--start-fallback-source-parallel-test',
    '--start-direct-file-canary',
    '--start-direct-long-canary',
    '--start-direct-sequential-canary',
    '--start-bg-multivoice-direct',
    '--refresh-and-start-multi'
  ];
  const paidCommand = paidCommands.find((command) => process.argv.includes(command));
  if (paidCommand && !process.argv.includes('--confirm-paid-generation')) {
    throw new Error(`${paidCommand} requires --confirm-paid-generation`);
  }

  const targets = await getTargets();
  const extensionsPage = targets.find((target) => target.type === 'page' && target.url.startsWith('chrome://extensions'));
  const minimaxPage = targets.find((target) => target.type === 'page' && target.url.startsWith('https://www.minimax.io/audio/'));
  const popup = targets.find((target) => target.type === 'page' && target.url.endsWith('/popup.html'));

  if (process.argv.includes('--extensions-toolbar')) {
    if (!extensionsPage) throw new Error('chrome://extensions target not found');
    const result = await evaluate(extensionsPage, `(() => {
      const toolbar = document.querySelector('extensions-manager')?.shadowRoot?.querySelector('extensions-toolbar');
      const root = toolbar?.shadowRoot;
      const devMode = root?.querySelector('#devMode');
      const loadButton = root?.querySelector('#loadUnpacked');
      return {
        developerMode: devMode?.checked === true,
        loadButtonVisible: !!loadButton,
        loadButtonDisabled: loadButton?.disabled === true
      };
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--click-load-unpacked')) {
    if (!extensionsPage) throw new Error('chrome://extensions target not found');
    const result = await evaluate(extensionsPage, `(async () => {
      const toolbar = document.querySelector('extensions-manager')?.shadowRoot?.querySelector('extensions-toolbar');
      const root = toolbar?.shadowRoot;
      const devMode = root?.querySelector('#devMode');
      if (!devMode?.checked) {
        devMode.click();
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const loadButton = root?.querySelector('#loadUnpacked');
      if (!loadButton) return { clicked: false, reason: 'load_button_not_found' };
      loadButton.click();
      return { clicked: true };
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--reload-extension')) {
    if (!extensionsPage) throw new Error('chrome://extensions target not found');
    const result = await evaluate(extensionsPage, `(() => {
      const manager = document.querySelector('extensions-manager');
      const list = manager?.shadowRoot?.querySelector('extensions-item-list');
      const item = [...(list?.shadowRoot?.querySelectorAll('extensions-item') || [])]
        .find((entry) => entry.data?.name === 'MiniMax TTS Automation');
      const reloadButton = item?.shadowRoot?.querySelector('#dev-reload-button');
      if (!reloadButton) return { reloaded: false, reason: 'reload_button_not_found' };
      reloadButton.click();
      return { reloaded: true };
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--extension-state')) {
    if (!extensionsPage) throw new Error('chrome://extensions target not found');
    const result = await evaluate(extensionsPage, `(() => {
      const list = document.querySelector('extensions-manager')?.shadowRoot?.querySelector('extensions-item-list');
      const item = [...(list?.shadowRoot?.querySelectorAll('extensions-item') || [])]
        .find((entry) => entry.data?.name === 'MiniMax TTS Automation');
      if (!item) return { found: false };
      return {
        found: true,
        id: item.data?.id || '',
        enabled: item.shadowRoot?.querySelector('#enableToggle')?.hasAttribute('checked') === true,
        version: item.data?.version || '',
        manifestErrors: item.data?.manifestErrors || [],
        runtimeErrors: item.data?.runtimeErrors || []
      };
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--enable-extension')) {
    if (!extensionsPage) throw new Error('chrome://extensions target not found');
    const result = await evaluate(extensionsPage, `(() => {
      const list = document.querySelector('extensions-manager')?.shadowRoot?.querySelector('extensions-item-list');
      const item = [...(list?.shadowRoot?.querySelectorAll('extensions-item') || [])]
        .find((entry) => entry.data?.name === 'MiniMax TTS Automation');
      if (!item) return { enabled: false, reason: 'extension_not_found' };
      if (item.data?.state === 1) return { enabled: true, changed: false };
      const toggle = item.shadowRoot?.querySelector('#enableToggle');
      if (!toggle) return { enabled: false, reason: 'enable_toggle_not_found' };
      toggle.click();
      return { enabled: true, changed: true };
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--extension-worker-info')) {
    const worker = targets.find((target) => target.type === 'worker');
    if (!worker) throw new Error('extension service worker not found');
    const result = await evaluate(worker, `(async () => ({
      runtimeId: chrome.runtime.id,
      tabs: (await chrome.tabs.query({ url: 'https://www.minimax.io/audio/text-to-speech*' }))
        .map((tab) => ({ id: tab.id, active: tab.active, url: tab.url, status: tab.status }))
    }))()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--extension-controls')) {
    if (!extensionsPage) throw new Error('chrome://extensions target not found');
    const result = await evaluate(extensionsPage, `(() => {
      const list = document.querySelector('extensions-manager')?.shadowRoot?.querySelector('extensions-item-list');
      const item = [...(list?.shadowRoot?.querySelectorAll('extensions-item') || [])]
        .find((entry) => entry.data?.name === 'MiniMax TTS Automation');
      if (!item) return { found: false };
      const root = item.shadowRoot;
      return {
        found: true,
        buttons: [...root.querySelectorAll('button, cr-toggle, input, [role="switch"]')].map((element) => ({
          tag: element.tagName,
          id: element.id || '',
          role: element.getAttribute('role') || '',
          ariaChecked: element.getAttribute('aria-checked') || '',
          text: element.textContent.trim().slice(0, 100),
          html: element.outerHTML.slice(0, 500)
        }))
      };
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--page-state')) {
    if (!minimaxPage) throw new Error('MiniMax page not found');
    const result = await evaluate(minimaxPage, `(() => ({
      title: document.title,
      url: location.href,
      bodyText: document.body?.innerText?.slice(0, 2000) || '',
      editorPresent: !!document.querySelector('[data-slate-editor="true"]'),
      generateButtons: [...document.querySelectorAll('button')]
        .filter((button) => /generate/i.test(button.textContent || ''))
        .map((button) => ({ text: button.textContent.trim(), disabled: button.disabled }))
    }))()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--voice-clone-research')) {
    if (!minimaxPage) throw new Error('MiniMax page not found');
    const result = await evaluate(minimaxPage, `(() => {
      let webpackRequire = null;
      window.webpackChunk_N_E = window.webpackChunk_N_E || [];
      window.webpackChunk_N_E.push([['minimax-voice-clone-research-' + Date.now()], {}, (require) => {
        webpackRequire = require;
      }]);

      const links = [...document.querySelectorAll('a')]
        .map((link) => ({ text: link.textContent.trim(), href: link.href }))
        .filter((link) => /voice\s*clone/i.test(link.text) || /voice[^/]*clone/i.test(link.href));
      const needles = [
        'voice/clone',
        'voice_clone',
        'voice-clone',
        'upload',
        '300',
        '20 * 1024 * 1024',
        '20*1024*1024'
      ];
      const modules = Object.entries(webpackRequire?.m || {})
        .map(([id, factory]) => ({ id, source: String(factory) }))
        .filter(({ source }) => needles.some((needle) => source.toLowerCase().includes(needle.toLowerCase())))
        .map(({ id, source }) => ({
          id,
          matches: needles.filter((needle) => source.toLowerCase().includes(needle.toLowerCase())),
          excerpts: needles.flatMap((needle) => {
            const index = source.toLowerCase().indexOf(needle.toLowerCase());
            return index < 0 ? [] : [source.slice(Math.max(0, index - 350), index + needle.length + 700)];
          }).slice(0, 8)
        }));

      return {
        ok: true,
        url: location.href,
        links,
        inputConstraints: [...document.querySelectorAll('input[type="file"]')].map((input) => ({
          accept: input.accept,
          multiple: input.multiple,
          outerHTML: input.outerHTML.slice(0, 1000)
        })),
        visibleText: document.body?.innerText?.slice(0, 5000) || '',
        modules
      };
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--voice-clone-internals')) {
    if (!minimaxPage) throw new Error('MiniMax page not found');
    const result = await evaluate(minimaxPage, `(() => {
      let webpackRequire = null;
      window.webpackChunk_N_E = window.webpackChunk_N_E || [];
      window.webpackChunk_N_E.push([['minimax-voice-clone-internals-' + Date.now()], {}, (require) => {
        webpackRequire = require;
      }]);
      if (!webpackRequire?.m) return { ok: false, reason: 'webpack_runtime_missing' };

      const sources = Object.fromEntries(Object.entries(webpackRequire.m).map(([id, factory]) => [id, String(factory)]));
      const excerpt = (source, needle, before = 900, after = 2200) => {
        const index = source.indexOf(needle);
        return index < 0 ? '' : source.slice(Math.max(0, index - before), index + needle.length + after);
      };
      const callerIds = Object.entries(sources)
        .filter(([id, source]) => id !== '89932' && source.includes('89932') && /clone|voiceClone|VoiceClone/i.test(source))
        .map(([id]) => id);
      const policyIds = Object.entries(sources)
        .filter(([, source]) => source.includes('fileScene') && source.includes('VOICE_CLONE'))
        .map(([id]) => id);

      return {
        ok: true,
        routeModule: sources['71981'] || '',
        apiModule: sources['89932'] || '',
        constraintsModule: sources['78002'] || '',
        callerModules: callerIds.map((id) => ({
          id,
          cloneCall: excerpt(sources[id], 'clone_v2') || excerpt(sources[id], '.Fm)') || excerpt(sources[id], '.Fm('),
          filePayload: excerpt(sources[id], 'file_id') || excerpt(sources[id], 'fileId'),
          voicePayload: excerpt(sources[id], 'voice_name') || excerpt(sources[id], 'voiceName'),
          convertCall: excerpt(sources[id], 'convertLoading')
        })),
        uploadPolicyModules: policyIds.map((id) => ({ id, source: sources[id] }))
      };
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--billing-credit')) {
    if (!minimaxPage) throw new Error('MiniMax page not found');
    const result = await evaluate(minimaxPage, `(async () => {
      const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
      const creditUrls = [...new Set(urls.filter((url) => (
        url.includes('/v1/api/audio/billing/credit')
      )))];
      const responses = [];
      for (const url of creditUrls) {
        const response = await fetch(url, { credentials: 'include' });
        const text = await response.text();
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch (error) { body = text.slice(0, 1000); }
        responses.push({ url: url.split('?')[0], status: response.status, body });
      }
      return { ok: true, responses };
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--credit-preflight')) {
    if (!popup) throw new Error('MiniMax popup not found');
    const optionIndex = process.argv.indexOf('--credit-preflight');
    const requestedCharacters = Number(process.argv[optionIndex + 1] || 0);
    const result = await evaluate(popup, `(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://www.minimax.io/audio/text-to-speech*' });
      if (!tab?.id) return { success: false, reason: 'minimax_tab_not_found' };
      return chrome.tabs.sendMessage(tab.id, {
        action: 'getGenerationCredit',
        requestedCharacters: ${JSON.stringify(requestedCharacters)}
      });
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--direct-capability')) {
    if (!popup) throw new Error('MiniMax popup not found');
    const result = await evaluate(popup, `(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://www.minimax.io/audio/text-to-speech*' });
      if (!tab?.id) return { success: false, reason: 'minimax_tab_not_found' };
      return chrome.tabs.sendMessage(tab.id, { action: 'getDirectTtsCapability' });
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--probe-direct-blocked')) {
    if (!popup) throw new Error('MiniMax popup not found');
    const result = await evaluate(popup, `(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://www.minimax.io/audio/text-to-speech*' });
      if (!tab?.id) return { success: false, reason: 'minimax_tab_not_found' };
      return chrome.tabs.sendMessage(tab.id, { action: 'probeDirectRegularBlocked' });
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--probe-direct-long-blocked')) {
    if (!popup) throw new Error('MiniMax popup not found');
    const result = await evaluate(popup, `(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://www.minimax.io/audio/text-to-speech*' });
      if (!tab?.id) return { success: false, reason: 'minimax_tab_not_found' };
      return chrome.tabs.sendMessage(tab.id, { action: 'probeDirectLongBlocked' });
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--prepare-direct-probe')) {
    if (!popup) throw new Error('MiniMax popup not found');
    const result = await evaluate(popup, `(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://www.minimax.io/audio/text-to-speech*' });
      if (!tab?.id) return { success: false, reason: 'minimax_tab_not_found' };
      return chrome.tabs.sendMessage(tab.id, {
        action: 'prepareDirectProbeText',
        text: 'Safe blocked direct transport probe.'
      });
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--trigger-blocked-capture')) {
    if (!minimaxPage) throw new Error('MiniMax page not found');
    const optionIndex = process.argv.indexOf('--trigger-blocked-capture');
    const mode = String(process.argv[optionIndex + 1] || 'regular').toLowerCase();
    if (!['regular', 'long'].includes(mode)) {
      throw new Error('Usage: --trigger-blocked-capture [regular|long]');
    }
    const result = await evaluate(minimaxPage, `(async () => {
      const mode = ${JSON.stringify(mode)};
      const state = window.__minimaxBlockedTtsCapture;
      if (!state?.installed) return { ok: false, reason: 'tts_capture_not_armed' };
      const settingsTab = [...document.querySelectorAll('[role="tab"]')]
        .find((element) => element.textContent.trim() === 'Settings');
      if (settingsTab?.getAttribute('aria-selected') !== 'true') {
        settingsTab?.click();
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const toggle = document.querySelector('.long-text-stats [role="switch"]');
      if (!toggle) return { ok: false, reason: 'long_text_toggle_not_found' };
      const expected = mode === 'long' ? 'true' : 'false';
      if (toggle.getAttribute('aria-checked') !== expected) {
        toggle.click();
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const editor = document.querySelector('[data-slate-editor="true"]');
      if (!editor) return { ok: false, reason: 'editor_not_found' };
      const text = mode === 'long'
        ? 'Safe blocked Long Text payload capture. '.repeat(140)
        : 'Safe blocked regular payload capture.';
      const fiberKey = Object.keys(editor).find((key) => key.startsWith('__reactFiber$'));
      let fiber = fiberKey ? editor[fiberKey] : null;
      let slateEditor = null;
      for (let index = 0; index < 25 && fiber; index += 1) {
        if (fiber.memoizedProps?.editor) {
          slateEditor = fiber.memoizedProps.editor;
          break;
        }
        fiber = fiber.return;
      }
      if (!slateEditor) return { ok: false, reason: 'slate_editor_not_found' };
      if (slateEditor.children?.length) {
        const lastParagraph = slateEditor.children[slateEditor.children.length - 1];
        const lastText = lastParagraph.children[lastParagraph.children.length - 1];
        slateEditor.selection = {
          anchor: { path: [0, 0], offset: 0 },
          focus: {
            path: [slateEditor.children.length - 1, lastParagraph.children.length - 1],
            offset: String(lastText.text || '').length
          }
        };
      }
      editor.focus();
      editor.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: text
      }));
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const generate = [...document.querySelectorAll('button')].find((button) => (
        /^generate$/i.test(button.textContent.trim())
          && !button.disabled
          && (button.offsetWidth || button.offsetHeight || button.getClientRects().length)
      ));
      if (!generate) return { ok: false, reason: 'generate_button_not_ready', textLength: text.length };
      generate.click();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (mode === 'long') {
        const proceed = [...document.querySelectorAll('button')].find((button) => (
          /^proceed$/i.test(button.textContent.trim()) && !button.disabled
        ));
        if (proceed) {
          proceed.click();
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
      return {
        ok: true,
        mode,
        textLength: text.length,
        captureCount: state.captures?.length || 0,
        notices: [...document.querySelectorAll('[role="alert"], .ant-message-notice, .ant-modal-content')]
          .filter((element) => element.offsetWidth || element.offsetHeight || element.getClientRects().length)
          .map((element) => element.textContent.trim().slice(0, 500))
      };
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--voice-api-snapshot')) {
    if (!minimaxPage) throw new Error('MiniMax page not found');
    const result = await evaluate(minimaxPage, `(async () => {
      let webpackRequire = null;
      const chunkName = 'minimax-voice-diagnostics-' + Date.now();
      window.webpackChunk_N_E = window.webpackChunk_N_E || [];
      window.webpackChunk_N_E.push([[chunkName], {}, (require) => { webpackRequire = require; }]);
      if (!webpackRequire?.m) return { ok: false, reason: 'webpack_runtime_missing' };

      const moduleId = Object.keys(webpackRequire.m).find((id) => {
        const source = String(webpackRequire.m[id]);
        return source.includes('/v1/api/audio/voice/list')
          && source.includes('/v1/api/audio/voice/equity');
      });
      if (!moduleId) return { ok: false, reason: 'voice_api_module_missing' };

      const api = webpackRequire(moduleId);
      const findApi = (path) => Object.values(api).find((value) => (
        typeof value === 'function' && String(value).includes(path)
      ));
      const listVoices = findApi('/v1/api/audio/voice/list');
      const getEquity = findApi('/v1/api/audio/voice/equity');
      if (!listVoices || !getEquity) return { ok: false, reason: 'voice_api_export_missing' };

      const equity = await getEquity({});
      const voices = [];
      let page = 1;
      let hasMore = true;
      while (hasMore && page <= 20) {
        const payload = await listVoices({
          is_system: false,
          is_collect: false,
          page,
          page_size: 30,
          filter: [],
          user_language: document.documentElement.lang || 'en'
        });
        const items = Array.isArray(payload?.voice_list) ? payload.voice_list : [];
        voices.push(...items.map((item, index) => ({
          position: voices.length + index + 1,
          voiceId: String(item.voice_id || ''),
          voiceName: String(item.voice_name || ''),
          createTime: item.create_time ?? null,
          updateTime: item.update_time ?? null,
          generateChannel: item.generate_channel ?? null,
          voiceStatus: item.voice_status ?? null,
          parentVoiceId: String(item.parent_voice_id || ''),
          collected: item.collected === true,
          keys: Object.keys(item).sort()
        })));
        hasMore = Boolean(payload?.has_more);
        if (items.length === 0) break;
        page += 1;
      }

      const targetNames = ['sp 2 otzv', 'sp 1 otzv', 'sp seleba', 'Man 1 MSI', 'НовостиФранц', 'BG bg ved KZ'];
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const oldestTwenty = voices.slice(-20).reverse();
      const serializeVoice = (voice) => ({
        position: voice.position,
        voiceId: voice.voiceId,
        voiceName: voice.voiceName,
        createTime: voice.createTime,
        generateChannel: voice.generateChannel,
        voiceStatus: voice.voiceStatus
      });
      return {
        ok: true,
        equity: {
          used: equity?.used ?? null,
          total: equity?.total ?? null,
          remaining: Number(equity?.total || 0) - Number(equity?.used || 0)
        },
        pagesFetched: Math.ceil(voices.length / 30),
        hasMore,
        voiceCount: voices.length,
        orderIsNewestFirst: voices.every((voice, index) => (
          index === 0 || Number(voices[index - 1].createTime || 0) >= Number(voice.createTime || 0)
        )),
        generateChannels: Object.fromEntries(Object.entries(voices.reduce((counts, voice) => {
          const key = String(voice.generateChannel ?? 'missing');
          counts[key] = (counts[key] || 0) + 1;
          return counts;
        }, {}))),
        voiceStatuses: Object.fromEntries(Object.entries(voices.reduce((counts, voice) => {
          const key = String(voice.voiceStatus ?? 'missing');
          counts[key] = (counts[key] || 0) + 1;
          return counts;
        }, {}))),
        targetVoices: targetNames.map((name) => ({
          requestedName: name,
          matches: voices.filter((voice) => normalize(voice.voiceName) === normalize(name))
        })),
        firstVoices: voices.slice(0, 10),
        oldestTwenty: oldestTwenty.map(serializeVoice),
        cleanupPreview: {
          requestedCount: 20,
          eligibleCount: oldestTwenty.filter((voice) => (
            voice.generateChannel === 1 && voice.voiceStatus === 2
          )).length,
          voiceIds: oldestTwenty.filter((voice) => (
            voice.generateChannel === 1 && voice.voiceStatus === 2
          )).map((voice) => voice.voiceId)
        },
        lastVoices: voices.slice(-10),
        distinctKeys: [...new Set(voices.flatMap((voice) => voice.keys))].sort()
      };
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--voices-by-tag')) {
    if (!minimaxPage) throw new Error('MiniMax page not found');
    const optionIndex = process.argv.indexOf('--voices-by-tag');
    const tag = String(process.argv[optionIndex + 1] || '').trim().toLowerCase();
    if (!tag) throw new Error('Voice tag is required');
    const result = await evaluate(minimaxPage, `(async () => {
      let webpackRequire = null;
      window.webpackChunk_N_E = window.webpackChunk_N_E || [];
      window.webpackChunk_N_E.push([['minimax-voices-by-tag-' + Date.now()], {}, (require) => {
        webpackRequire = require;
      }]);
      const moduleId = Object.keys(webpackRequire?.m || {}).find((id) => (
        String(webpackRequire.m[id]).includes('/v1/api/audio/voice/list')
      ));
      if (!moduleId) return { ok: false, reason: 'voice_api_module_missing' };
      const api = webpackRequire(moduleId);
      const listVoices = Object.values(api).find((value) => (
        typeof value === 'function' && String(value).includes('/v1/api/audio/voice/list')
      ));
      if (!listVoices) return { ok: false, reason: 'voice_list_export_missing' };
      const voices = [];
      let page = 1;
      let hasMore = true;
      while (hasMore && page <= 20) {
        const payload = await listVoices({
          is_system: false,
          is_collect: false,
          page,
          page_size: 30,
          filter: [],
          user_language: document.documentElement.lang || 'en'
        });
        const items = Array.isArray(payload?.voice_list) ? payload.voice_list : [];
        voices.push(...items);
        hasMore = Boolean(payload?.has_more);
        if (items.length === 0) break;
        page += 1;
      }
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      return {
        ok: true,
        voices: voices
          .filter((voice) => normalize(voice.voice_name).includes(${JSON.stringify(tag)}))
          .map((voice) => ({
            voiceId: String(voice.voice_id || ''),
            voiceName: String(voice.voice_name || ''),
            fileId: String(voice.file_id || ''),
            createTime: voice.create_time ?? null,
            voiceStatus: voice.voice_status ?? null,
            generateChannel: voice.generate_channel ?? null
          }))
      };
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--arm-tts-capture')) {
    if (!minimaxPage) throw new Error('MiniMax page not found');
    const optionIndex = process.argv.indexOf('--arm-tts-capture');
    const mode = String(process.argv[optionIndex + 1] || 'any').toLowerCase();
    if (!['any', 'regular', 'long'].includes(mode)) {
      throw new Error('Usage: --arm-tts-capture [any|regular|long]');
    }
    const result = await evaluate(minimaxPage, `(() => {
      const existing = window.__minimaxBlockedTtsCapture;
      if (existing?.originalSend && WebSocket.prototype.send === existing.captureSend) {
        WebSocket.prototype.send = existing.originalSend;
      }
      const originalSend = WebSocket.prototype.send;
      const state = {
        installed: true,
        mode: ${JSON.stringify(mode)},
        armedAt: Date.now(),
        originalSend,
        captures: []
      };
      const captureSend = function(data) {
        try {
          const isAudioSocket = String(this.url || '').includes('/v1/api/audio/ws');
          if (!isAudioSocket) return originalSend.apply(this, arguments);
          const frame = typeof data === 'string' ? JSON.parse(data) : null;
          if (frame?.method === 'Heartbeat' || frame?.method === 'StopGen') {
            return originalSend.apply(this, arguments);
          }
          const isGeneration = frame
            && typeof frame === 'object'
            && frame.payload
            && typeof frame.payload.text === 'string'
            && frame.payload.voice_setting
            && frame.msg_id;
          const isLongText = frame?.method === 'T2aAsync';
          const isRegular = frame?.method === undefined;
          const matchesMode = state.mode === 'any'
            || (state.mode === 'long' && isLongText)
            || (state.mode === 'regular' && isRegular);
          if (isGeneration && matchesMode) {
            state.captures.push({
              capturedAt: Date.now(),
              mode: isLongText ? 'long' : 'regular',
              socket: (() => {
                const url = new URL(this.url);
                return {
                  origin: url.origin,
                  pathname: url.pathname,
                  queryKeys: [...url.searchParams.keys()].sort()
                };
              })(),
              msgId: {
                type: typeof frame.msg_id,
                length: String(frame.msg_id).length,
                uuidLike: /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(frame.msg_id))
              },
              frame: {
                method: frame.method,
                payload: {
                  ...frame.payload,
                  text: '<redacted:' + frame.payload.text.length + '>'
                },
                msg_id: '<redacted>'
              }
            });
            return;
          }
          state.blockedUnknown = {
            capturedAt: Date.now(),
            dataType: typeof data,
            method: frame?.method || '',
            keys: frame && typeof frame === 'object' ? Object.keys(frame) : []
          };
          return;
        } catch (error) {
          state.lastParseError = error.message;
          state.blockedUnknown = { capturedAt: Date.now(), dataType: typeof data, parseError: error.message };
          return;
        }
      };
      state.captureSend = captureSend;
      WebSocket.prototype.send = captureSend;
      window.__minimaxBlockedTtsCapture = state;
      return { ok: true, mode: state.mode, armedAt: state.armedAt };
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--arm-manager-capture')) {
    if (!minimaxPage) throw new Error('MiniMax page not found');
    const result = await evaluate(minimaxPage, `(() => {
      let webpackRequire = null;
      window.webpackChunk_N_E = window.webpackChunk_N_E || [];
      window.webpackChunk_N_E.push([['minimax-manager-capture-' + Date.now()], {}, (require) => {
        webpackRequire = require;
      }]);
      if (!webpackRequire?.m) return { ok: false, reason: 'webpack_runtime_missing' };
      const moduleId = webpackRequire.m['78544'] ? '78544' : Object.keys(webpackRequire.m).find((id) => (
        String(webpackRequire.m[id]).includes('/v1/api/audio/ws')
      ));
      if (!moduleId) return { ok: false, reason: 'manager_module_missing' };
      const api = webpackRequire(moduleId);
      const manager = Object.values(api).find((value) => (
        value && typeof value.initWebSocket === 'function' && typeof value.close === 'function'
      ));
      if (!manager) return { ok: false, reason: 'manager_export_missing' };
      const existing = window.__minimaxManagerCapture;
      if (existing?.originalInit && manager.initWebSocket === existing.captureInit) {
        manager.initWebSocket = existing.originalInit;
      }
      const originalInit = manager.initWebSocket;
      const state = { installed: true, moduleId, captures: [], originalInit };
      const captureInit = function(...args) {
        const options = args[0];
        state.captures.push({
          capturedAt: Date.now(),
          argumentCount: args.length,
          argumentTypes: args.map((value) => Array.isArray(value) ? 'array' : typeof value),
          optionKeys: options && typeof options === 'object' ? Object.keys(options).sort() : [],
          optionTypes: options && typeof options === 'object'
            ? Object.fromEntries(Object.entries(options).map(([key, value]) => [key, Array.isArray(value) ? 'array' : typeof value]))
            : {},
          url: typeof options?.url === 'string' ? options.url.split('?')[0] : '',
          wsKey: String(options?.wsKey || ''),
          body: options?.body && typeof options.body === 'object' ? {
            keys: Object.keys(options.body).sort(),
            method: options.body.method || '',
            payloadKeys: Object.keys(options.body.payload || {}).sort(),
            msgIdType: typeof options.body.msg_id
          } : null
        });
        return originalInit.apply(this, args);
      };
      state.captureInit = captureInit;
      manager.initWebSocket = captureInit;
      window.__minimaxManagerCapture = state;
      return {
        ok: true,
        moduleId,
        initLength: originalInit.length,
        managerKeys: Object.keys(manager).sort()
      };
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--arm-manager-fixture')) {
    if (!minimaxPage) throw new Error('MiniMax page not found');
    const optionIndex = process.argv.indexOf('--arm-manager-fixture');
    const fixture = String(process.argv[optionIndex + 1] || 'success').toLowerCase();
    if (!['success', 'rejection', 'sensitive', 'close', 'error'].includes(fixture)) {
      throw new Error('Usage: --arm-manager-fixture [success|rejection|sensitive|close|error]');
    }
    const result = await evaluate(minimaxPage, `(() => {
      let webpackRequire = null;
      window.webpackChunk_N_E = window.webpackChunk_N_E || [];
      window.webpackChunk_N_E.push([['minimax-manager-fixture-' + Date.now()], {}, (require) => {
        webpackRequire = require;
      }]);
      const moduleId = webpackRequire?.m?.['78544'] ? '78544' : Object.keys(webpackRequire?.m || {}).find((id) => (
        String(webpackRequire.m[id]).includes('/v1/api/audio/ws')
      ));
      const api = moduleId ? webpackRequire(moduleId) : null;
      const manager = api && Object.values(api).find((value) => (
        value && typeof value.initWebSocket === 'function' && typeof value.close === 'function'
      ));
      if (!manager) return { ok: false, reason: 'manager_export_missing' };
      const existing = window.__minimaxManagerFixture;
      if (existing?.originalInit && manager.initWebSocket === existing.fixtureInit) {
        manager.initWebSocket = existing.originalInit;
      }
      const originalInit = manager.initWebSocket;
      const state = { installed: true, fixture: ${JSON.stringify(fixture)}, moduleId, originalInit, calls: [] };
      const fixtureInit = function(options) {
        state.calls.push({
          wsKey: String(options?.wsKey || ''),
          optionKeys: Object.keys(options || {}).sort(),
          bodyKeys: Object.keys(options?.body || {}).sort()
        });
        queueMicrotask(() => {
          options?.onOpen?.();
          if (state.fixture === 'success') {
            if (options?.body?.method === 'T2aAsync') {
              options?.onMessage?.({ method: 'T2aAsync', statusInfo: { code: 0 } });
            } else {
              options?.onMessage?.({ data: { audio: '49443304000000000000fff310c4' + '00'.repeat(600), status: 1 }, statusInfo: { code: 0 } });
              options?.onMessage?.({ data: { audio: '00'.repeat(600), status: 2 }, statusInfo: { code: 0 } });
            }
          } else if (state.fixture === 'rejection') {
            options?.onMessage?.({ statusInfo: { code: 2600012, message: 'Synthetic limit rejection' } });
          } else if (state.fixture === 'sensitive') {
            options?.onMessage?.({ input_sensitive: true, statusInfo: { code: 0 } });
          } else if (state.fixture === 'close') {
            options?.onClose?.();
          } else {
            options?.onError?.({ message: 'Synthetic socket error' });
          }
        });
        return { send() {}, close() {}, isConnected() { return true; } };
      };
      state.fixtureInit = fixtureInit;
      manager.initWebSocket = fixtureInit;
      window.__minimaxManagerFixture = state;
      return { ok: true, fixture: state.fixture, moduleId };
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--clear-manager-fixture')) {
    if (!minimaxPage) throw new Error('MiniMax page not found');
    const result = await evaluate(minimaxPage, `(() => {
      const state = window.__minimaxManagerFixture;
      if (!state?.installed) return { ok: true, callCount: 0 };
      let webpackRequire = null;
      window.webpackChunk_N_E.push([['minimax-manager-fixture-clear-' + Date.now()], {}, (require) => {
        webpackRequire = require;
      }]);
      const api = webpackRequire?.(state.moduleId);
      const manager = api && Object.values(api).find((value) => (
        value && typeof value.initWebSocket === 'function' && typeof value.close === 'function'
      ));
      if (manager && manager.initWebSocket === state.fixtureInit) manager.initWebSocket = state.originalInit;
      const callCount = state.calls?.length || 0;
      delete window.__minimaxManagerFixture;
      return { ok: true, callCount };
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--read-manager-capture')) {
    if (!minimaxPage) throw new Error('MiniMax page not found');
    const result = await evaluate(minimaxPage, `(() => {
      const state = window.__minimaxManagerCapture;
      if (!state?.installed) return { ok: false, reason: 'manager_capture_not_armed' };
      return { ok: true, moduleId: state.moduleId, captures: state.captures || [] };
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--clear-manager-capture')) {
    if (!minimaxPage) throw new Error('MiniMax page not found');
    const result = await evaluate(minimaxPage, `(() => {
      const state = window.__minimaxManagerCapture;
      if (!state?.installed) return { ok: true, captureCount: 0 };
      let webpackRequire = null;
      window.webpackChunk_N_E.push([['minimax-manager-clear-' + Date.now()], {}, (require) => {
        webpackRequire = require;
      }]);
      const api = webpackRequire?.(state.moduleId);
      const manager = api && Object.values(api).find((value) => (
        value && typeof value.initWebSocket === 'function' && typeof value.close === 'function'
      ));
      if (manager && manager.initWebSocket === state.captureInit) manager.initWebSocket = state.originalInit;
      const captureCount = state.captures?.length || 0;
      delete window.__minimaxManagerCapture;
      return { ok: true, captureCount };
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--read-tts-capture')) {
    if (!minimaxPage) throw new Error('MiniMax page not found');
    const result = await evaluate(minimaxPage, `(() => {
      const state = window.__minimaxBlockedTtsCapture;
      if (!state?.installed) return { ok: false, reason: 'tts_capture_not_armed' };
      return {
        ok: true,
        mode: state.mode,
        armedAt: state.armedAt,
        captures: state.captures || [],
        blockedUnknown: state.blockedUnknown || null,
        lastParseError: state.lastParseError || ''
      };
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--clear-tts-capture')) {
    if (!minimaxPage) throw new Error('MiniMax page not found');
    const result = await evaluate(minimaxPage, `(() => {
      const state = window.__minimaxBlockedTtsCapture;
      if (state?.originalSend && WebSocket.prototype.send === state.captureSend) {
        WebSocket.prototype.send = state.originalSend;
      }
      const captureCount = state?.captures?.length || 0;
      delete window.__minimaxBlockedTtsCapture;
      return { ok: true, captureCount };
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--voice-dom')) {
    if (!minimaxPage) throw new Error('MiniMax page not found');
    const result = await evaluate(minimaxPage, `(() => ({
      headings: [...document.querySelectorAll('h4')].map((element) => ({
        text: element.textContent.trim(),
        html: element.outerHTML.slice(0, 500),
        parent: element.parentElement?.outerHTML?.slice(0, 800) || ''
      })),
      tabs: [...document.querySelectorAll('[role="tab"]')].map((element) => ({
        text: element.textContent.trim(),
        selected: element.getAttribute('aria-selected')
      })),
      dialogs: [...document.querySelectorAll('[role="dialog"], .ant-modal')].map((element) => ({
        text: element.textContent.trim().slice(0, 500),
        visible: !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length)
      }))
    }))()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--all-pages-state')) {
    const pages = targets.filter((target) => target.type === 'page' && target.url.startsWith('https://www.minimax.io/audio/text-to-speech'));
    const result = [];
    for (const page of pages) {
      const state = await evaluate(page, `(() => {
        const visible = (element) => !!element && !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
        const editor = document.querySelector('[data-slate-editor="true"]');
        const voiceHeading = [...document.querySelectorAll('h4')].find((element) => visible(element));
        const language = document.querySelector('.language-select .ant-select-selection-item');
        const toggle = document.querySelector('.long-text-stats [role="switch"]');
        const capture = window.__minimaxAudioCapture?.activeSession;
        return {
          voice: voiceHeading?.textContent.trim() || '',
          language: language?.textContent.trim() || '',
          longText: toggle?.getAttribute('aria-checked') || null,
          editorText: editor?.innerText || editor?.textContent || '',
          capture: capture ? {
            state: capture.state,
            totalBytes: capture.totalBytes,
            chunkCount: capture.chunks?.length || 0,
            firstChunkAt: capture.firstChunkAt,
            lastChunkAt: capture.lastChunkAt,
            endedAt: capture.endedAt,
            finalSignalAt: capture.finalSignalAt,
            finalSignalKind: capture.finalSignalKind,
            blobSize: capture.blob?.size || 0,
            sourceBufferTypes: capture.sourceBufferTypes
          } : null,
          buttons: [...document.querySelectorAll('button')]
            .filter((button) => visible(button) && /generate|download|proceed|cancel/i.test(button.textContent || ''))
            .map((button) => ({ text: button.textContent.trim(), disabled: button.disabled })),
          audio: [...document.querySelectorAll('audio')].map((element) => ({
            src: element.currentSrc || element.src || '',
            sources: [...element.querySelectorAll('source')].map((source) => source.src)
          })),
          audioResources: performance.getEntriesByType('resource')
            .map((entry) => entry.name)
            .filter((url) => /audio|speech|\.mp3|\.wav|blob:/i.test(url))
            .slice(-20),
          notices: [...document.querySelectorAll('[role="alert"], .ant-message-notice, .ant-modal-content')]
            .filter(visible)
            .map((element) => element.textContent.trim().slice(0, 500))
        };
      })()`);
      result.push({ targetId: page.id, ...state });
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--latest-audio-api')) {
    if (!minimaxPage) throw new Error('MiniMax page not found');
    const result = await evaluate(minimaxPage, `(async () => {
      const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
      const historyUrl = [...urls].reverse().find((url) => url.includes('/v1/api/audio/history_list'));
      const detailsUrl = [...urls].reverse().find((url) => url.includes('/v1/api/audio/details'));
      const readJson = async (url) => {
        if (!url) return null;
        const response = await fetch(url, { credentials: 'include' });
        const text = await response.text();
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch (error) { body = text.slice(0, 1000); }
        return { status: response.status, body };
      };
      return {
        history: await readJson(historyUrl),
        details: await readJson(detailsUrl)
      };
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--reload-minimax')) {
    if (!minimaxPage) throw new Error('MiniMax page not found');
    await evaluate(minimaxPage, 'location.reload(); true');
    console.log(JSON.stringify({ reloaded: true }, null, 2));
    return;
  }

  if (process.argv.includes('--storage')) {
    if (!popup) throw new Error('MiniMax popup not found');
    const result = await evaluate(popup, 'chrome.storage.local.get(null)');
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--list-voices')) {
    if (!popup) throw new Error('MiniMax popup not found');
    const optionIndex = process.argv.indexOf('--list-voices');
    const prefix = process.argv[optionIndex + 1] || '';
    const result = await evaluate(popup, `(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://www.minimax.io/audio/text-to-speech*' });
      if (!tab?.id) return { success: false, reason: 'minimax_tab_not_found' };
      return chrome.tabs.sendMessage(tab.id, {
        action: 'listVoicesFromUi',
        prefix: ${JSON.stringify(prefix)}
      });
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--list-api-voices')) {
    if (!popup) throw new Error('MiniMax popup not found');
    const optionIndex = process.argv.indexOf('--list-api-voices');
    const prefix = String(process.argv[optionIndex + 1] || '').trim().toLowerCase();
    const result = await evaluate(popup, `(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://www.minimax.io/audio/text-to-speech*' });
      if (!tab?.id) return { success: false, reason: 'minimax_tab_not_found' };
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'listMyVoices' });
      if (!response?.success) return response;
      const prefix = ${JSON.stringify(prefix)};
      return {
        success: true,
        voices: (response.voices || []).filter((voice) => (
          !prefix || String(voice.voiceName || '').trim().toLowerCase().startsWith(prefix)
        ))
      };
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--inspect-fixture-mapping')) {
    if (!popup) throw new Error('MiniMax popup not found');
    const optionIndex = process.argv.indexOf('--inspect-fixture-mapping');
    const fixturePath = process.argv[optionIndex + 1];
    const fixtureAliases = { 'VSLL-2164': 'VSLL-2163' };
    if (!fixturePath) throw new Error('Fixture directory is required');
    const files = fs.readdirSync(fixturePath)
      .filter((name) => /\.(?:md|txt)$/i.test(name))
      .sort((left, right) => left.localeCompare(right));
    const voicesResponse = await evaluate(popup, `(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://www.minimax.io/audio/text-to-speech*' });
      if (!tab?.id) return { success: false, reason: 'minimax_tab_not_found' };
      return chrome.tabs.sendMessage(tab.id, { action: 'listMyVoices' });
    })()`);
    if (!voicesResponse?.success) throw new Error(voicesResponse?.reason || 'voice_list_failed');
    const mpVoices = (voicesResponse.voices || []).filter((voice) => (
      String(voice.voiceName || '').trim().toLowerCase().startsWith('mp ')
    ));
    const mappings = new Map();
    for (const fileName of files) {
      const entries = parseMarkdown(fs.readFileSync(path.join(fixturePath, fileName), 'utf8'));
      for (const entry of entries) {
        const languageCode = String(entry.languageCode || '').toUpperCase();
        const key = `${languageCode}::${entry.speaker}`;
        if (!mappings.has(key)) {
          const resolved = resolveVoice(entry.speaker, languageCode, mpVoices, 'mp', fixtureAliases);
          mappings.set(key, {
            key,
            speaker: entry.speaker,
            languageCode,
            voiceId: resolved.voice?.voiceId || '',
            voiceName: resolved.voice?.voiceName || '',
            localStatus: resolved.status,
            entryCount: 0,
            files: []
          });
        }
        const mapping = mappings.get(key);
        mapping.entryCount += 1;
        if (!mapping.files.includes(fileName)) mapping.files.push(fileName);
      }
    }
    const plan = { prefix: 'mp', fileCount: files.length, mappings: [...mappings.values()] };
    const result = await evaluate(popup, `(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://www.minimax.io/audio/text-to-speech*' });
      if (!tab?.id) return { success: false, reason: 'minimax_tab_not_found' };
      return chrome.tabs.sendMessage(tab.id, {
        action: 'inspectVoiceMappingPlan',
        plan: ${JSON.stringify(plan)}
      });
    })()`);
    console.log(JSON.stringify({ fixturePath, files: files.length, localPlan: plan, liveInspection: result }, null, 2));
    return;
  }

  if (process.argv.includes('--upload-multi-file')) {
    if (!popup) throw new Error('MiniMax popup not found');
    const optionIndex = process.argv.indexOf('--upload-multi-file');
    const sourcePath = process.argv[optionIndex + 1];
    if (!sourcePath) throw new Error('Source file path is required');
    const fileName = path.basename(sourcePath);
    const content = fs.readFileSync(sourcePath, 'utf8');
    const result = await evaluate(popup, `(async () => {
      const input = document.getElementById('multiScriptFile');
      if (!input) return { success: false, reason: 'multi_file_input_missing' };
      const transfer = new DataTransfer();
      transfer.items.add(new File([${JSON.stringify(content)}], ${JSON.stringify(fileName)}, { type: 'text/markdown' }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const stored = await chrome.storage.local.get(['batchFiles_Multi', 'voiceMappings']);
        const files = stored.batchFiles_Multi || [];
        if (files.length === 1 && (files[0].entries || []).length > 0) {
          return {
            success: true,
            fileName: files[0].name,
            entries: files[0].entries.length,
            mappings: Object.keys(stored.voiceMappings || {}).length,
            status: document.getElementById('multiStatus')?.textContent || ''
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return { success: false, reason: 'multi_file_load_timeout' };
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--upload-multi-directory')) {
    if (!popup) throw new Error('MiniMax popup not found');
    const optionIndex = process.argv.indexOf('--upload-multi-directory');
    const sourceDirectory = process.argv[optionIndex + 1];
    if (!sourceDirectory) throw new Error('Source directory is required');
    const excludeIndex = process.argv.indexOf('--exclude');
    const excludedTokens = excludeIndex >= 0
      ? String(process.argv[excludeIndex + 1] || '').split(',').map((value) => value.trim()).filter(Boolean)
      : [];
    const files = fs.readdirSync(sourceDirectory)
      .filter((name) => /\.(?:md|txt)$/i.test(name))
      .filter((name) => !excludedTokens.some((token) => name.includes(token)))
      .sort((left, right) => left.localeCompare(right))
      .map((name) => ({ name, content: fs.readFileSync(path.join(sourceDirectory, name), 'utf8') }));
    const result = await evaluate(popup, `(async () => {
      const input = document.getElementById('multiScriptFile');
      if (!input) return { success: false, reason: 'multi_file_input_missing' };
      const files = ${JSON.stringify(files)};
      const transfer = new DataTransfer();
      files.forEach((file) => transfer.items.add(new File([file.content], file.name, { type: 'text/markdown' })));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const stored = await chrome.storage.local.get(['batchFiles_Multi', 'voiceMappings']);
        const loaded = stored.batchFiles_Multi || [];
        if (loaded.length === files.length && loaded.every((file) => (file.entries || []).length > 0)) {
          return {
            success: true,
            files: loaded.map((file) => ({ name: file.name, entries: file.entries.length })),
            mappings: Object.keys(stored.voiceMappings || {}).length
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return { success: false, reason: 'multi_directory_load_timeout' };
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--apply-fixture-2164-alias')) {
    if (!popup) throw new Error('MiniMax popup not found');
    const result = await evaluate(popup, `(async () => {
      const assignments = {
        'ДИКТОР(VSLL-2164)': 'mp dic VSLL-2163',
        'ДОКТОР(VSLL-2164)': 'mp doc VSLL-2163'
      };
      const applied = [];
      for (const item of document.querySelectorAll('.voice-mapping-item')) {
        const label = item.querySelector('.voice-mapping-label')?.textContent?.trim() || '';
        const voiceName = assignments[label];
        if (!voiceName) continue;
        const input = item.querySelector('.voice-mapping-input');
        if (!input) return { success: false, reason: 'mapping_input_missing', label };
        input.value = voiceName;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        applied.push({ label, voiceName });
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return { success: applied.length === 2, applied };
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--refresh-and-start-multi')) {
    if (!popup) throw new Error('MiniMax popup not found');
    const parallelEnabled = process.argv.includes('--parallel');
    const result = await evaluate(popup, `(async () => {
      const refresh = document.getElementById('refreshSiteVoicesButton');
      const start = document.getElementById('startMultiAutomationButton');
      const parallel = document.getElementById('parallelModeToggle');
      if (!refresh || !start || !parallel) return { success: false, reason: 'multi_controls_missing' };
      const parallelEnabled = ${JSON.stringify(parallelEnabled)};
      if (parallel.checked !== parallelEnabled) parallel.click();
      refresh.click();
      const refreshDeadline = Date.now() + 60000;
      while (Date.now() < refreshDeadline) {
        const text = document.getElementById('siteVoicesStatus')?.textContent || '';
        if (/Загружено голосов:/i.test(text) && !refresh.disabled) break;
        if (/Не удалось|ничего не найдено/i.test(text) && !refresh.disabled) {
          return { success: false, reason: text };
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (refresh.disabled) return { success: false, reason: 'voice_refresh_timeout' };
      start.click();
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const storage = await chrome.storage.local.get(['batchState', 'longTextState', 'parallelBatchState']);
      return {
        success: true,
        multiStatus: document.getElementById('multiStatus')?.textContent || '',
        mappingStatus: document.getElementById('voiceMappingInspectionStatus')?.textContent || '',
        storage
      };
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--multi-ui-state')) {
    if (!popup) throw new Error('MiniMax popup not found');
    const result = await evaluate(popup, `(async () => {
      const storage = await chrome.storage.local.get([
        'batchFiles_Multi',
        'voiceMappings',
        'batchState',
        'parallelBatchState',
        'longTextState',
        'regularSubmissionLedger'
      ]);
      const start = document.getElementById('startMultiAutomationButton');
      return {
        start: {
          disabled: start?.disabled === true,
          display: start?.style?.display || '',
          text: start?.textContent?.trim() || ''
        },
        status: document.getElementById('multiStatus')?.textContent || '',
        statusClass: document.getElementById('multiStatus')?.className || '',
        mappingStatus: document.getElementById('voiceMappingInspectionStatus')?.textContent || '',
        voiceStatus: document.getElementById('siteVoicesStatus')?.textContent || '',
        files: (storage.batchFiles_Multi || []).map((file) => ({
          name: file.name,
          entries: (file.entries || []).length,
          excluded: (file.excludedIds || []).length
        })),
        mappingCount: Object.keys(storage.voiceMappings || {}).length,
        batchState: storage.batchState || null,
        parallelBatchState: storage.parallelBatchState || null,
        longTextState: storage.longTextState || null,
        regularLedger: storage.regularSubmissionLedger || []
      };
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--run-summary')) {
    if (!popup) throw new Error('MiniMax popup not found');
    const result = await evaluate(popup, `(async () => {
      const storage = await chrome.storage.local.get([
        'batchState',
        'parallelBatchState',
        'longTextState',
        'regularSubmissionLedger',
        'downloadHistory',
        'directTtsLastResult'
      ]);
      const longTasks = storage.longTextState?.tasks || [];
      return {
        batch: storage.batchState ? {
          isRunning: storage.batchState.isRunning === true,
          recoveryRequired: storage.batchState.recoveryRequired === true,
          activeIndex: storage.batchState.activeJob?.currentIndex ?? null,
          activeTotal: storage.batchState.activeJob?.queue?.length ?? null,
          statuses: (storage.batchState.activeJob?.queue || []).reduce((counts, entry) => {
            counts[entry.status || 'unknown'] = (counts[entry.status || 'unknown'] || 0) + 1;
            return counts;
          }, {}),
          error: storage.batchState.error || null
        } : null,
        parallel: storage.parallelBatchState ? {
          isRunning: storage.parallelBatchState.isRunning === true,
          recoveryRequired: storage.parallelBatchState.recoveryRequired === true,
          error: storage.parallelBatchState.error || null
        } : null,
        longText: {
          isSubmitting: storage.longTextState?.isSubmitting === true,
          statuses: longTasks.reduce((counts, task) => {
            counts[task.status || 'unknown'] = (counts[task.status || 'unknown'] || 0) + 1;
            return counts;
          }, {}),
          tasks: longTasks.map((task) => ({
            localId: task.localId,
            status: task.status,
            audioId: task.audioId || null,
            voiceId: task.voiceId || null,
            downloadId: task.downloadId || null,
            targetFilename: task.targetFilename || null,
            error: task.error || null
          }))
        },
        regularLedgerCount: (storage.regularSubmissionLedger || []).length,
        downloadHistoryCount: (storage.downloadHistory || []).length,
        directTtsLastResult: storage.directTtsLastResult || null
      };
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--verify-bg-voice-switches')) {
    if (!popup) throw new Error('MiniMax popup not found');
    const voices = [
      { voiceId: '430110957342959', voiceName: 'mp dic Иво Петров' },
      { voiceId: '430113027665991', voiceName: 'mp doc Иво Петров' },
      { voiceId: '430107636039798', voiceName: 'mp BG_Отзыв_1_женщина' },
      { voiceId: '430108912439489', voiceName: 'mp BG_Отзыв_1_мужчина' },
      { voiceId: '430108346552537', voiceName: 'mp BG_Отзыв_2_женщина' },
      { voiceId: '430109246124226', voiceName: 'mp BG_Отзыв_2_мужчина' }
    ];
    const result = await evaluate(popup, `(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://www.minimax.io/audio/text-to-speech*' });
      if (!tab?.id) return { success: false, reason: 'minimax_tab_not_found' };
      const results = [];
      for (const voice of ${JSON.stringify(voices)}) {
        const response = await chrome.tabs.sendMessage(tab.id, {
          action: 'verifyVoiceSwitch',
          voiceId: voice.voiceId,
          voiceName: voice.voiceName
        });
        results.push({ ...voice, response });
        if (!response?.success) break;
      }
      return { success: results.length === ${voices.length} && results.every((item) => item.response?.success), results };
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--prepare-live')) {
    if (!minimaxPage) throw new Error('MiniMax page not found');
    const result = await evaluate(minimaxPage, `(async () => {
      const closeButton = document.querySelector('.ant-modal-close');
      if (closeButton) {
        closeButton.click();
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const settingsTab = [...document.querySelectorAll('[role="tab"]')]
        .find((element) => element.textContent.trim() === 'Settings');
      if (settingsTab?.getAttribute('aria-selected') !== 'true') {
        settingsTab.click();
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      const toggle = document.querySelector('.long-text-stats [role="switch"]');
      if (!toggle) return { ready: false, reason: 'long_text_toggle_not_found' };
      if (toggle.getAttribute('aria-checked') !== 'true') {
        toggle.click();
      }
      const startedAt = Date.now();
      while (Date.now() - startedAt < 5000) {
        if (toggle.getAttribute('aria-checked') === 'true') {
          return { ready: true, longTextEnabled: true };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { ready: false, reason: 'long_text_enable_timeout' };
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--start-parallel-test')) {
    if (!popup) throw new Error('MiniMax popup not found');
    const result = await evaluate(popup, `(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://www.minimax.io/audio/text-to-speech*' });
      if (!tab?.id) return { success: false, reason: 'minimax_tab_not_found' };
      const jobs = [{
        mode: 'multi',
        scriptName: 'parallel-live-test',
        queue: [
          {
            id: 'parallel-live-v2-woman',
            speaker: 'ДИКТОР ЖЕНЩИНА',
            originalTag: 'ДИКТОР ЖЕНЩИНА',
            text: 'Solo cinco días. Soy el doctor Carlos Jaramillo.',
            voiceId: 'Calm Woman - Sophisticated,Serene,Captivating',
            language: 'Spanish',
            scriptName: 'parallel-live-test',
            downloadIndex: 1,
            speakerIndex: 1,
            downloadLayout: 'package',
            sourceFileName: 'ПринимайтеУтром.md',
            sourceFileBaseName: 'ПринимайтеУтром'
          },
          {
            id: 'parallel-live-v2-man',
            speaker: 'ДИКТОР МУЖЧИНА',
            originalTag: 'ДИКТОР МУЖЧИНА',
            text: 'No contiene químicos ni causa efectos secundarios.',
            voiceId: 'Deep Storyteller - Magnetic,Smooth,Sophisticated',
            language: 'Spanish',
            scriptName: 'parallel-live-test',
            downloadIndex: 2,
            speakerIndex: 1,
            downloadLayout: 'package',
            sourceFileName: 'ПринимайтеУтром.md',
            sourceFileBaseName: 'ПринимайтеУтром'
          }
        ]
      }];
      return chrome.runtime.sendMessage({
        action: 'startParallelBatchProcessing',
        jobs,
        tabId: tab.id
      });
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--start-source-parallel-test')) {
    if (!popup) throw new Error('MiniMax popup not found');
    const result = await evaluate(popup, `(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://www.minimax.io/audio/text-to-speech*' });
      if (!tab?.id) return { success: false, reason: 'minimax_tab_not_found' };
      const sourceFileName = 'VSLD-4440 NL Паразиты РепДок Короткая NL.md';
      const jobs = [{
        mode: 'multi',
        scriptName: 'VSLD-4440 NL Паразиты РепДок Короткая NL',
        queue: [
          {
            id: 'source-nl-dic-2',
            speaker: 'ДИКТОР',
            originalTag: 'ДИКТОР(NL) 2',
            text: 'Wat kunt u vertellen over het overheidsprogramma?',
            voiceId: 'mp dic NL',
            language: 'Dutch',
            languageCode: 'NL',
            scriptName: 'VSLD-4440 NL Паразиты РепДок Короткая NL',
            downloadIndex: 2,
            speakerIndex: 2,
            downloadLayout: 'package',
            sourceFileName,
            sourceFileBaseName: 'VSLD-4440 NL Паразиты РепДок Короткая NL'
          },
          {
            id: 'source-nl-doc-2',
            speaker: 'ДОКТОР',
            originalTag: 'ДОКТОР(NL) 2',
            text: 'Ik start samen met de overheid een programma.',
            voiceId: 'mp doc NL',
            language: 'Dutch',
            languageCode: 'NL',
            scriptName: 'VSLD-4440 NL Паразиты РепДок Короткая NL',
            downloadIndex: 2,
            speakerIndex: 2,
            downloadLayout: 'package',
            sourceFileName,
            sourceFileBaseName: 'VSLD-4440 NL Паразиты РепДок Короткая NL'
          }
        ]
      }];
      return chrome.runtime.sendMessage({
        action: 'startParallelBatchProcessing',
        jobs,
        tabId: tab.id
      });
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--start-three-voice-source-parallel-test')) {
    if (!popup) throw new Error('MiniMax popup not found');
    const result = await evaluate(popup, `(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://www.minimax.io/audio/text-to-speech*' });
      if (!tab?.id) return { success: false, reason: 'minimax_tab_not_found' };
      const sourceFileName = 'VSLD-4440 NL Паразиты РепДок Короткая NL.md';
      const scriptName = 'parallel-three-voice-source-test';
      const jobs = [{
        mode: 'multi',
        scriptName,
        queue: [
          {
            id: 'three-voice-nl-dic', speaker: 'ДИКТОР', originalTag: 'ДИКТОР(NL) test',
            text: 'Wat kunt u vertellen over het overheidsprogramma?', voiceId: 'mp dic NL',
            language: 'Dutch', scriptName, downloadIndex: 1, speakerIndex: 1,
            downloadLayout: 'package', sourceFileName, sourceFileBaseName: scriptName
          },
          {
            id: 'three-voice-nl-doc', speaker: 'ДОКТОР', originalTag: 'ДОКТОР(NL) test',
            text: 'Ik start samen met de overheid een programma.', voiceId: 'mp doc NL',
            language: 'Dutch', scriptName, downloadIndex: 2, speakerIndex: 2,
            downloadLayout: 'package', sourceFileName, sourceFileBaseName: scriptName
          },
          {
            id: 'three-voice-nl-review', speaker: 'ОТЗЫВ ЖЕНЩИНА', originalTag: 'Отзыв 1 женщина(NL) test',
            text: 'Dokter, ik ben u heel dankbaar.', voiceId: 'mp отзыв женщина NL 1',
            language: 'Dutch', scriptName, downloadIndex: 3, speakerIndex: 3,
            downloadLayout: 'package', sourceFileName, sourceFileBaseName: scriptName
          }
        ]
      }];
      return chrome.runtime.sendMessage({ action: 'startParallelBatchProcessing', jobs, tabId: tab.id });
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--start-fallback-source-parallel-test')) {
    if (!popup) throw new Error('MiniMax popup not found');
    const result = await evaluate(popup, `(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://www.minimax.io/audio/text-to-speech*' });
      if (!tab?.id) return { success: false, reason: 'minimax_tab_not_found' };
      const sourceFileName = 'VSLD-4440 NL Паразиты РепДок Короткая NL.md';
      const scriptName = 'parallel-fallback-source-test';
      const jobs = [{
        mode: 'multi',
        scriptName,
        queue: [
          {
            id: 'fallback-nl-dic-1', speaker: 'ДИКТОР', originalTag: 'ДИКТОР(NL) 2',
            text: 'Wat kunt u vertellen over het overheidsprogramma?', voiceId: 'mp dic NL',
            language: 'Dutch', scriptName, downloadIndex: 1, speakerIndex: 1,
            downloadLayout: 'package', sourceFileName, sourceFileBaseName: scriptName
          },
          {
            id: 'fallback-nl-dic-2', speaker: 'ДИКТОР', originalTag: 'ДИКТОР(NL) 3',
            text: 'Is deze oplossing werkelijk uniek?', voiceId: 'mp dic NL',
            language: 'Dutch', scriptName, downloadIndex: 2, speakerIndex: 2,
            downloadLayout: 'package', sourceFileName, sourceFileBaseName: scriptName
          },
          {
            id: 'fallback-nl-doc-1', speaker: 'ДОКТОР', originalTag: 'ДОКТОР(NL) 2',
            text: 'Ik start samen met de overheid een programma.', voiceId: 'mp doc NL',
            language: 'Dutch', scriptName, downloadIndex: 3, speakerIndex: 3,
            downloadLayout: 'package', sourceFileName, sourceFileBaseName: scriptName
          },
          {
            id: 'fallback-nl-doc-2', speaker: 'ДОКТОР', originalTag: 'ДОКТОР(NL) 3',
            text: 'Ja. Ik begrijp dat mensen in Nederland vaak hebben gehoord over wonderpillen tegen parasieten.', voiceId: 'mp doc NL',
            language: 'Dutch', scriptName, downloadIndex: 4, speakerIndex: 4,
            downloadLayout: 'package', sourceFileName, sourceFileBaseName: scriptName
          }
        ]
      }];
      return chrome.runtime.sendMessage({ action: 'startParallelBatchProcessing', jobs, tabId: tab.id });
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--close-secondary-parallel-tab')) {
    if (!popup) throw new Error('MiniMax popup not found');
    const result = await evaluate(popup, `(async () => {
      const { parallelBatchState } = await chrome.storage.local.get('parallelBatchState');
      const tabId = parallelBatchState?.secondaryTabId;
      if (!parallelBatchState?.isRunning || !tabId) {
        return { closed: false, reason: 'secondary_worker_not_running' };
      }
      await chrome.tabs.remove(tabId);
      return { closed: true, tabId, runId: parallelBatchState.runId };
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--probe-secondary-preflight')) {
    if (!popup) throw new Error('MiniMax popup not found');
    const result = await evaluate(popup, `(async () => {
      const [primary] = await chrome.tabs.query({ url: 'https://www.minimax.io/audio/text-to-speech*' });
      if (!primary?.id) return { ok: false, reason: 'minimax_tab_not_found' };
      const secondary = await chrome.tabs.create({ url: 'https://www.minimax.io/audio/text-to-speech', active: false });
      const send = async (tabId, message, timeout = 45000) => {
        const startedAt = Date.now();
        try {
          const response = await Promise.race([
            chrome.tabs.sendMessage(tabId, message),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeout))
          ]);
          return { ok: true, elapsedMs: Date.now() - startedAt, response };
        } catch (error) {
          return { ok: false, elapsedMs: Date.now() - startedAt, error: error.message };
        }
      };
      const waitForHealth = async (tabId) => {
        const deadline = Date.now() + 45000;
        while (Date.now() < deadline) {
          const result = await send(tabId, { action: 'parallelHealthCheck' }, 7000);
          if (result.ok && result.response?.success) return result;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        return { ok: false, error: 'health_timeout' };
      };
      const primaryHealth = await waitForHealth(primary.id);
      const secondaryHealth = await waitForHealth(secondary.id);
      const primaryPrepare = primaryHealth.ok
        ? await send(primary.id, { action: 'prepareParallelWorker', voiceId: 'mp dic NL', language: 'Dutch' })
        : null;
      const secondaryPrepare = secondaryHealth.ok
        ? await send(secondary.id, { action: 'prepareParallelWorker', voiceId: 'mp doc NL', language: 'Dutch' })
        : null;
      await chrome.tabs.remove(secondary.id);
      return { ok: true, primary: { id: primary.id, health: primaryHealth, prepare: primaryPrepare }, secondary: { id: secondary.id, health: secondaryHealth, prepare: secondaryPrepare } };
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--parallel-state')) {
    if (!popup) throw new Error('MiniMax popup not found');
    const result = await evaluate(popup, `(async () => {
      const state = await chrome.storage.local.get([
        'parallelBatchState',
        'batchState',
        'automationState',
        'downloadHistory',
        'skippedEntries'
      ]);
      const tabs = await chrome.tabs.query({ url: 'https://www.minimax.io/audio/text-to-speech*' });
      return { state, tabs: tabs.map((tab) => ({ id: tab.id, status: tab.status, active: tab.active })) };
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--automation-runtime')) {
    if (!popup) throw new Error('MiniMax popup not found');
    const result = await evaluate(popup, `(async () => {
      const tabs = await chrome.tabs.query({ url: 'https://www.minimax.io/audio/text-to-speech*' });
      const runtimes = await Promise.all(tabs.map(async (tab) => {
        try {
          return { tabId: tab.id, response: await chrome.tabs.sendMessage(tab.id, { action: 'getAutomationRuntimeState' }) };
        } catch (error) {
          return { tabId: tab.id, error: error.message };
        }
      }));
      return { runtimes };
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--start-direct-file-canary')) {
    if (!popup) throw new Error('MiniMax popup not found');
    const text = 'Pewien polski lekarz otrzymał prestiżową nagrodę za odkrycie naturalnego, domowego sposobu, który eliminuje prawdziwą przyczynę łuszczycy i chorób skóry w zaledwie siedemnaście godzin bez sterydów, bolesnych zastrzyków i naświetlań.';
    const result = await evaluate(popup, `(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://www.minimax.io/audio/text-to-speech*' });
      if (!tab?.id) return { success: false, reason: 'minimax_tab_not_found' };
      await chrome.storage.local.set({ directTtsEnabled: true });
      return chrome.runtime.sendMessage({
        action: 'startBatchProcessing',
        tabId: tab.id,
        jobs: [{
          mode: 'single',
          scriptName: 'VSLD-4555-direct-canary',
          queue: [{
            id: 'direct-file-canary-1',
            text: ${JSON.stringify(text)},
            speaker: 'dictor',
            originalTag: 'dictor',
            language: 'Polish',
            speakerIndex: 1,
            downloadIndex: 1,
            scriptName: 'VSLD-4555-direct-canary',
            downloadLayout: 'default',
            sourceFileName: 'VSLD-4555 PL Псориаз Dr Krzysztof Gojdź.md',
            sourceFileBaseName: 'VSLD-4555 PL Псориаз Dr Krzysztof Gojdź'
          }]
        }]
      });
    })()`);
    console.log(JSON.stringify({ textLength: text.length, response: result }, null, 2));
    return;
  }

  if (process.argv.includes('--start-direct-long-canary')) {
    if (!popup) throw new Error('MiniMax popup not found');
    const sentence = 'To jest kontrolny test dlugiego tekstu dla bezpiecznej walidacji transportu audio. ';
    const text = sentence.repeat(Math.ceil(5100 / sentence.length)).slice(0, 5100);
    const result = await evaluate(popup, `(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://www.minimax.io/audio/text-to-speech*' });
      if (!tab?.id) return { success: false, reason: 'minimax_tab_not_found' };
      await chrome.storage.local.set({ directTtsEnabled: true });
      return chrome.runtime.sendMessage({
        action: 'startBatchProcessing',
        tabId: tab.id,
        jobs: [{
          mode: 'single',
          scriptName: 'direct-long-canary',
          queue: [{
            id: 'direct-long-canary-1',
            text: ${JSON.stringify(text)},
            speaker: 'dictor',
            originalTag: 'dictor',
            language: 'Polish',
            speakerIndex: 1,
            downloadIndex: 1,
            scriptName: 'direct-long-canary',
            downloadLayout: 'default'
          }]
        }]
      });
    })()`);
    console.log(JSON.stringify({ startedAt: Date.now(), textLength: text.length, response: result }, null, 2));
    return;
  }

  if (process.argv.includes('--start-direct-sequential-canary')) {
    if (!popup) throw new Error('MiniMax popup not found');
    const texts = [
      'To jest pierwszy krotki test sekwencyjnego transportu Direct TTS.',
      'To jest drugi krotki test, uruchomiony dopiero po zakonczeniu pierwszego.'
    ];
    const result = await evaluate(popup, `(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://www.minimax.io/audio/text-to-speech*' });
      if (!tab?.id) return { success: false, reason: 'minimax_tab_not_found' };
      await chrome.storage.local.set({ directTtsEnabled: true });
      return chrome.runtime.sendMessage({
        action: 'startBatchProcessing',
        tabId: tab.id,
        jobs: [{
          mode: 'single',
          scriptName: 'direct-sequential-canary',
          queue: ${JSON.stringify(texts.map((text, index) => ({
            id: `direct-sequential-canary-${index + 1}`,
            text,
            speaker: 'dictor',
            originalTag: 'dictor',
            language: 'Polish',
            speakerIndex: index + 1,
            downloadIndex: index + 1,
            scriptName: 'direct-sequential-canary',
            downloadLayout: 'default'
          })))}
        }]
      });
    })()`);
    console.log(JSON.stringify({ startedAt: Date.now(), textLengths: texts.map((text) => text.length), response: result }, null, 2));
    return;
  }

  if (process.argv.includes('--start-bg-multivoice-direct')) {
    if (!popup) throw new Error('MiniMax popup not found');
    const fs = require('node:fs');
    const { parseMarkdown } = require('./parser');
    const sourceFileName = 'VSLD-4557 BG Псориаз Иво Петров.md';
    const sourcePath = 'D:\\Project files\\!North Union\\11.08\\txt\\translated\\' + sourceFileName;
    const entries = parseMarkdown(fs.readFileSync(sourcePath, 'utf8'));
    const mappings = {
      'dic Иво Петров': { voiceId: '430110957342959', voiceName: 'mp dic Иво Петров' },
      'doc Иво Петров': { voiceId: '430113027665991', voiceName: 'mp doc Иво Петров' },
      'BG Отзыв 1 женщина': { voiceId: '430107636039798', voiceName: 'mp BG_Отзыв_1_женщина' },
      'BG Отзыв 1 мужчина': { voiceId: '430108912439489', voiceName: 'mp BG_Отзыв_1_мужчина' },
      'BG Отзыв 2 женщина': { voiceId: '430108346552537', voiceName: 'mp BG_Отзыв_2_женщина' },
      'BG Отзыв 2 мужчина': { voiceId: '430109246124226', voiceName: 'mp BG_Отзыв_2_мужчина' }
    };
    const annotated = entries.map((entry, index) => ({
      ...entry,
      ...mappings[entry.speaker],
      language: 'Bulgarian',
      languageCode: 'BG',
      scriptName: 'VSLD-4557 BG Псориаз Иво Петров',
      downloadLayout: 'package',
      sourceFileName,
      sourceFileBaseName: 'VSLD-4557 BG Псориаз Иво Петров',
      originalDownloadIndex: index + 1,
      downloadIndex: index + 1,
      speakerIndex: index + 1
    }));
    const grouped = [...new Set(annotated.map((entry) => entry.voiceId))]
      .flatMap((voiceId) => annotated.filter((entry) => entry.voiceId === voiceId));
    const result = await evaluate(popup, `(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://www.minimax.io/audio/text-to-speech*' });
      if (!tab?.id) return { success: false, reason: 'minimax_tab_not_found' };
      await chrome.storage.local.set({ directTtsEnabled: true });
      return chrome.runtime.sendMessage({
        action: 'startBatchProcessing',
        tabId: tab.id,
        jobs: [{
          mode: 'multi',
          scriptName: 'VSLD-4557 BG Псориаз Иво Петров',
          queue: ${JSON.stringify(grouped)}
        }]
      });
    })()`);
    console.log(JSON.stringify({
      startedAt: Date.now(),
      entryCount: grouped.length,
      totalCharacters: grouped.reduce((sum, entry) => sum + entry.text.length, 0),
      voiceGroups: [...new Set(grouped.map((entry) => entry.voiceName))],
      response: result
    }, null, 2));
    return;
  }

  if (process.argv.includes('--match-test-history')) {
    if (!popup) throw new Error('MiniMax popup not found');
    const result = await evaluate(popup, `(async () => {
      const [tab] = await chrome.tabs.query({ url: 'https://www.minimax.io/audio/text-to-speech*' });
      if (!tab?.id) return { success: false, reason: 'minimax_tab_not_found' };
      return chrome.tabs.sendMessage(tab.id, {
        action: 'queryLongTextHistory',
        tasks: [
          {
            localId: 'parallel-live-woman',
            text: 'Solo cinco días. Soy el doctor Carlos Jaramillo y les prometo que ya no tendrán que vivir con miedo. La ciencia conoce sustancias naturales capaces de atacar la raíz de este problema.',
            voiceId: 'Calm Woman - Sophisticated,Serene,Captivating',
            submittedAt: 0,
            excludedAudioIds: []
          },
          {
            localId: 'parallel-live-man',
            text: 'No contiene químicos ni causa efectos secundarios. Este método mejora la circulación y ayuda a recuperar la energía. Un solo vaso por la mañana puede marcar una gran diferencia.',
            voiceId: 'Deep Storyteller - Magnetic,Smooth,Sophisticated',
            submittedAt: 0,
            excludedAudioIds: []
          }
        ]
      });
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--history-snapshot')) {
    if (!minimaxPage) throw new Error('MiniMax page not found');
    const result = await evaluate(minimaxPage, `(() => {
      const list = window.__minimaxLongTextHistoryCapture?.snapshot?.data?.audio_list || [];
      return list.slice(0, 10).map((item) => ({
        audio_id: item.audio_id,
        status: item.status,
        async: item.async,
        audio_url: item.audio_url,
        voice_name: item.voice_name,
        text: item.text,
        update_time: item.update_time,
        keys: Object.keys(item)
      }));
    })()`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (process.argv.includes('--stop')) {
    if (!popup) throw new Error('MiniMax popup not found');
    const result = await evaluate(popup, `chrome.runtime.sendMessage({ action: 'stopAutomation' })`);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error('Unknown command');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
