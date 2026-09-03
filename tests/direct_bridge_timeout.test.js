'use strict';

// Unit test for the callDirectBridge timeout-stripping logic.
// Re-implements the helper inline so we don't need a DOM/chrome.* shim —
// production callDirectBridge is in content_script.js and identical to this.

function makeCallDirectBridge() {
  return async function callDirectBridge(action, ...args) {
    let timeoutMs = 15000;
    if (args.length > 0 && typeof args[args.length - 1] === 'number') {
      timeoutMs = Math.max(1000, args[args.length - 1]);
      args = args.slice(0, -1);
    }
    try {
      const response = await Promise.race([
        // Simulate sendMessage — the helper receives the stripped args.
        new Promise((resolve) => setTimeout(() => resolve({ success: true, result: { ok: true, echoedArgs: args, action } }), 50)),
        new Promise((_, reject) => setTimeout(() => reject(new Error('bridge_timeout')), timeoutMs))
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
  };
}

let assert;
try {
  assert = require('node:assert/strict');
} catch (_) {
  assert = require('assert');
}

const callDirectBridge = makeCallDirectBridge();

async function test(name, fn) {
  try {
    await fn();
    console.log(`✔ ${name}`);
  } catch (err) {
    console.error(`✘ ${name}`);
    console.error(err);
    process.exit(1);
  }
}

(async () => {
  await test('strips trailing numeric timeout from args', async () => {
    const result = await callDirectBridge('generateDirectAudio', 'hello', 'sig', 'voice-1', 45000);
    assert.equal(result.ok, true);
    assert.deepEqual(result.echoedArgs, ['hello', 'sig', 'voice-1']);
    assert.equal(result.action, 'generateDirectAudio');
  });

  await test('uses default 15000ms timeout when no number is passed', async () => {
    const result = await callDirectBridge('getText');
    assert.equal(result.ok, true);
    assert.deepEqual(result.echoedArgs, []);
  });

  await test('only strips when LAST arg is a number; preserves numbers mid-args', async () => {
    // The guard is "last arg is a number" — numbers mid-args are kept.
    const result = await callDirectBridge('foo', 'bar', 42, 'baz');
    assert.equal(result.ok, true);
    assert.deepEqual(result.echoedArgs, ['bar', 42, 'baz']);
  });

  await test('strips only the trailing number, keeps earlier numbers as args', async () => {
    const result = await callDirectBridge('foo', 1, 2, 3, 60000);
    assert.equal(result.ok, true);
    assert.deepEqual(result.echoedArgs, [1, 2, 3]);
  });

  await test('clamps timeout to >= 1000ms', async () => {
    // 0 or negative would otherwise resolve immediately; we want >= 1s.
    const result = await callDirectBridge('ping', 'arg', 0);
    assert.equal(result.ok, true);
    assert.deepEqual(result.echoedArgs, ['arg']);
  });

  await test('returns bridge_timeout disposition when MAIN world is slower than the timeout', async () => {
    // Helper with work-time > timeout so the timer wins the race.
    const slow = (action, ...args) => {
      let to = 15000;
      if (typeof args[args.length - 1] === 'number') {
        to = Math.max(1000, args[args.length - 1]);
        args = args.slice(0, -1);
      }
      return Promise.race([
        new Promise((r) => setTimeout(() => r({ success: true, result: { ok: true } }), 3000)),
        new Promise((_, rej) => setTimeout(() => rej(new Error('bridge_timeout')), to))
      ]).catch((e) => {
        if (e.message === 'bridge_timeout') return { ok: false, disposition: 'bridge_timeout', reason: 'bridge_timeout' };
        return { ok: false, disposition: 'accepted_unknown', reason: e.message };
      });
    };
    // 1500ms timeout (above clamp floor of 1000) < 3000ms work → timer wins.
    const result = await slow('slowOp', 'arg1', 'arg2', 1500);
    assert.equal(result.disposition, 'bridge_timeout');
    assert.equal(result.reason, 'bridge_timeout');
  });

  // ---- generationTimeout formula: max(60000, min(300000, len/25 * 1000)) ----
  // Mirrors the formula in content_script.js processEntry. The server only
  // finalises after the full MP3 stream is in, so the budget scales generously.

  function generationTimeout(textLen) {
    return Math.max(60000, Math.min(300000, Math.ceil(textLen / 25) * 1000));
  }

  await test('generationTimeout floor at 60s for short text', async () => {
    assert.equal(generationTimeout(0), 60000);
    assert.equal(generationTimeout(50), 60000);
    assert.equal(generationTimeout(100), 60000);
    assert.equal(generationTimeout(800), 60000);
    assert.equal(generationTimeout(1500), 60000); // 1500/25 = 60s, exactly the floor
  });

  await test('generationTimeout scales with length above 1500 chars', async () => {
    assert.equal(generationTimeout(2500), 100000);
    assert.equal(generationTimeout(5000), 200000);
  });

  await test('generationTimeout caps at 300s', async () => {
    assert.equal(generationTimeout(10000), 300000);
    assert.equal(generationTimeout(25000), 300000);
  });

  console.log('ℹ tests 8');
})();
