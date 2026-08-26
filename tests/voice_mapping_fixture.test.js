const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMarkdown } = require('../parser');
const { resolveVoice } = require('../voice_mapping');

const defaultFixturePath = 'D:\\Project files\\!North Union\\18.08\\txt\\translated_backup';
const fixturePath = process.env.MINIMAX_MAPPING_FIXTURE || defaultFixturePath;
const fixtureAliases = { 'VSLL-2164': 'VSLL-2163' };

const voiceNames = [
  'mp dic VSLD-4763', 'mp doc VSLD-4763',
  'mp dic VSLD-4765', 'mp doc VSLD-4765',
  'mp dic VSLD-4767', 'mp doc VSLD-4767',
  'mp dic VSLL-2163', 'mp doc VSLL-2163',
  'mp dic VSLL-2165', 'mp doc VSLL-2165',
  ...['RU', 'SV', 'TR'].flatMap((language) => [
    ...[1, 2, 3, 4].map((number) => `mp отзыв женщина ${number} ${language}`),
    ...[1, 2].map((number) => `mp отзыв мужчина ${number} ${language}`)
  ]),
  ...[1, 2].map((number) => `mp отзыв женщина ${number} FR`),
  ...[1, 2].map((number) => `mp отзыв мужчина ${number} FR`)
];

test('maps the complete translated_backup fixture uniquely', { skip: !fs.existsSync(fixturePath) }, () => {
  const voices = voiceNames.map((voiceName, index) => ({
    voiceId: `fixture-${index + 1}`,
    voiceName,
    voiceStatus: 2
  }));
  const files = fs.readdirSync(fixturePath)
    .filter((fileName) => /\.(?:md|txt)$/i.test(fileName));
  const results = files.flatMap((fileName) => {
    const content = fs.readFileSync(path.join(fixturePath, fileName), 'utf8');
    return parseMarkdown(content).map((entry) => ({
      fileName,
      entry,
      result: resolveVoice(entry.speaker, entry.languageCode, voices, 'mp', fixtureAliases)
    }));
  });

  assert.equal(files.length, 9);
  assert.equal(results.length, 165);
  assert.deepEqual(
    results.filter(({ result }) => result.status !== 'ok').map(({ fileName, entry, result }) => ({
      fileName,
      speaker: entry.speaker,
      status: result.status
    })),
    []
  );
  assert.equal(new Set(results.map(({ result }) => result.voice.voiceId)).size, 32);

  const longEntries = results.filter(({ entry }) => entry.text.length > 5000);
  assert.deepEqual(longEntries.map(({ entry, result }) => ({
    length: entry.text.length,
    voiceName: result.voice.voiceName
  })), [
    { length: 6121, voiceName: 'mp doc VSLD-4763' },
    { length: 5754, voiceName: 'mp doc VSLD-4765' },
    { length: 5631, voiceName: 'mp doc VSLD-4767' }
  ]);
});
