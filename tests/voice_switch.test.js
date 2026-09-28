// Переключение голоса после смены UI MiniMax (сборка prod-en-0.1.43):
// поле поиска в модалке Voice Selection бьёт только по библиотеке — запрос
// уходит с is_system:true при любом активном табе, поэтому свои голоса
// (My Voices) карточкой не находятся и вся очередь уходила в
// skipped_voice_not_found. Голос ставится экшеном стора (tts/selectVoice,
// тот же, что дёргает кнопка Use); UI-ветка остаётся откатом.
// Запуск: node --test tests/voice_switch.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const noop = () => {};

function loadAutomation() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'content_script.js'), 'utf8')
    + '\n;globalThis.__VoiceoverAutomation = VoiceoverAutomation;';
  const element = () => ({
    style: {}, classList: { add: noop, remove: noop, contains: () => false },
    setAttribute: noop, appendChild: noop, click: noop, remove: noop, focus: noop,
    querySelector: () => null, querySelectorAll: () => [], addEventListener: noop,
    getAttribute: () => null, textContent: '', innerHTML: '', removeEventListener: noop,
  });
  const logs = [];
  const sandbox = {
    // Таймеры срабатывают сразу: UI-ветка ждёт по 500 мс ×10 и тест иначе
    // висел бы секундами.
    console: { log: (...args) => logs.push(String(args[0])), error: noop, warn: noop },
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout: noop,
    setInterval: () => 0,
    clearInterval: noop,
    crypto: { randomUUID: () => 'test-uuid' },
    window: { addEventListener: noop, removeEventListener: noop, location: { href: 'https://www.minimax.io/' } },
    document: {
      addEventListener: noop, removeEventListener: noop,
      querySelector: () => null, querySelectorAll: () => [],
      evaluate: () => ({ singleNodeValue: null }),
      createElement: element, getElementById: () => null, execCommand: noop,
      body: element(), head: element(), documentElement: element(),
    },
    chrome: {
      runtime: { id: 'test', lastError: null, getURL: (url) => url, sendMessage: async () => ({ success: true }), onMessage: { addListener: noop } },
      storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener: noop } },
      downloads: { onDeterminingFilename: { addListener: noop }, download: async () => 1, search: async () => [] },
    },
    DiagLog: { info: noop, warn: noop, error: noop, log: noop, debug: noop },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'content_script.js' });
  return { automation: new sandbox.__VoiceoverAutomation(), logs };
}

test('голос ставится через стор, модалка не открывается', async () => {
  const { automation, logs } = loadAutomation();
  const calls = [];
  automation.callBridgeTimed = async (...args) => {
    calls.push(args);
    return { ok: true, voiceId: '71152525', voiceName: 'mp dic 71152525', source: 'my_voices' };
  };

  await automation.switchVoice('mp dic 71152525', '71152525');

  assert.deepEqual(calls, [[30000, 'selectVoiceRecord', 'mp dic 71152525', '71152525']],
    'в стор уходит имя и voiceId, с запасом по таймауту');
  assert.equal(automation.currentVoiceId, 'mp dic 71152525', 'внутреннее состояние помнит голос');
  assert.equal(logs.filter((line) => line.includes('Clicking voice selector')).length, 0,
    'UI-ветка не запускалась');
  assert.equal(logs.filter((line) => line.includes('set via MiniMax store')).length, 1,
    'успешная установка залогирована');
});

test('если стор недоступен — откат на UI-ветку', async () => {
  const { automation, logs } = loadAutomation();
  automation.callBridgeTimed = async () => ({ ok: false, reason: 'minimax_store_missing' });

  await assert.rejects(
    () => automation.switchVoice('mp dic 71152525', '71152525'),
    /Could not find Voice Selector button/,
    'UI-ветка действительно берёт управление и падает на отсутствии кнопки в заглушке'
  );
  assert.equal(automation.currentVoiceId, null, 'неуспех не запоминается как выбранный голос');
  assert.ok(logs.some((line) => line.includes('minimax_store_missing')), 'причина отката видна в логе');
});

test('совпадение внутреннего состояния и ожидаемого voiceId — без переключения', async () => {
  const { automation } = loadAutomation();
  let calls = 0;
  automation.callBridgeTimed = async () => { calls += 1; return { ok: true, voiceId: '71152525' }; };
  automation.currentVoiceId = 'mp dic 71152525';

  await automation.switchVoice('mp dic 71152525', '71152525');

  assert.equal(calls, 1, 'единственный вызов — проверка getDirectTtsReadyState');
});
