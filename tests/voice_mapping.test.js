const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getProjectId,
  resolveVoice,
  inspectPlan
} = require('../voice_mapping');

const voices = [
  { voiceId: 'dic-2163', voiceName: 'mp dic VSLL-2163', voiceStatus: 2 },
  { voiceId: 'doc-2163', voiceName: 'mp doc VSLL-2163', voiceStatus: 2 },
  { voiceId: 'ru-f1', voiceName: 'mp отзыв женщина 1 RU', voiceStatus: 2 },
  { voiceId: 'ru-f2', voiceName: 'mp отзыв женщина 2 RU', voiceStatus: 2 },
  { voiceId: 'ru-m1', voiceName: 'mp отзыв мужчина 1 RU', voiceStatus: 2 }
];

test('applies project aliases only when explicitly supplied', () => {
  const aliases = { 'VSLL-2164': 'VSLL-2163' };
  assert.equal(getProjectId('ДОКТОР(VSLL-2164)'), 'VSLL-2164');
  assert.equal(getProjectId('ДОКТОР(VSLL-2164)', aliases), 'VSLL-2163');
  assert.equal(
    resolveVoice('ДОКТОР(VSLL-2164)', 'RU', voices, 'mp', aliases).voice.voiceId,
    'doc-2163'
  );
});

test('requires testimonial gender and number together', () => {
  assert.equal(resolveVoice('Отзыв 1 женщина(RU)', 'RU', voices).voice.voiceId, 'ru-f1');
  assert.equal(resolveVoice('Отзыв 4 женщина(RU)', 'RU', voices).status, 'missing');
  assert.equal(resolveVoice('Отзыв 2 мужчина(RU)', 'RU', voices).status, 'missing');
});

test('does not map an unscoped primary voice by role alone', () => {
  assert.equal(resolveVoice('ДИКТОР', '', voices).status, 'missing');
});

test('reports ambiguous candidates instead of choosing API order', () => {
  const duplicateVoices = [
    ...voices,
    { voiceId: 'ru-f1-copy', voiceName: 'mp отзыв женщина 1 RU copy', voiceStatus: 2 }
  ];
  const result = resolveVoice('Отзыв 1 женщина(RU)', 'RU', duplicateVoices);
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.candidates.length, 2);
});

test('does not resolve an unavailable heuristic candidate', () => {
  const result = resolveVoice('Отзыв 1 женщина(RU)', 'RU', [
    { voiceId: 'disabled', voiceName: 'mp отзыв женщина 1 RU', voiceStatus: 1 }
  ]);
  assert.equal(result.status, 'missing');
});

test('validates an ID-bound plan without rejecting duplicate names', () => {
  const duplicateNames = [
    { voiceId: 'a', voiceName: 'same voice', voiceStatus: 2 },
    { voiceId: 'b', voiceName: 'same voice', voiceStatus: 2 }
  ];
  const result = inspectPlan({
    fileCount: 1,
    mappings: [{ key: 'RU::speaker', speaker: 'speaker', languageCode: 'RU', voiceId: 'a', voiceName: 'same voice', entryCount: 2, files: ['a.md'] }]
  }, duplicateNames);
  assert.equal(result.valid, true);
  assert.equal(result.totals.ok, 1);
});

test('reports missing, stale, unavailable and ambiguous mappings', () => {
  const live = [
    { voiceId: 'disabled', voiceName: 'disabled voice', voiceStatus: 1 },
    { voiceId: 'same-1', voiceName: 'same', voiceStatus: 2 },
    { voiceId: 'same-2', voiceName: 'same', voiceStatus: 2 }
  ];
  const result = inspectPlan({
    fileCount: 1,
    mappings: [
      { key: 'missing', entryCount: 1 },
      { key: 'stale', voiceId: 'gone', entryCount: 1 },
      { key: 'disabled', voiceId: 'disabled', entryCount: 1 },
      { key: 'ambiguous', voiceName: 'same', entryCount: 1 }
    ]
  }, live);
  assert.equal(result.valid, false);
  assert.deepEqual(
    {
      missing: result.totals.missing,
      stale: result.totals.stale,
      unavailable: result.totals.unavailable,
      ambiguous: result.totals.ambiguous
    },
    { missing: 1, stale: 1, unavailable: 1, ambiguous: 1 }
  );
});

test('does not replace an explicitly configured unknown name', () => {
  const result = inspectPlan({
    prefix: 'mp',
    fileCount: 1,
    mappings: [{
      key: 'RU::Отзыв 1 женщина(RU)',
      speaker: 'Отзыв 1 женщина(RU)',
      languageCode: 'RU',
      voiceName: 'deleted custom voice',
      entryCount: 1
    }]
  }, voices);
  assert.equal(result.valid, false);
  assert.equal(result.totals.notFound, 1);
});
