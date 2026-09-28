#!/usr/bin/env node
/* Сверка скачанного аудио с переведёнными текстами: что сгенерировано, что потеряно,
   какие файлы Long Text лежат в корне и в каком порядке их склеивать.

   Usage:
     node scripts/check-audio.js [--texts <dir>] [--audio <dir>] [--all]

   --texts  каталог с .md (по умолчанию — свежий «!North Union\<дата>\txt\translated»)
   --audio  каталог audio (по умолчанию — <проект>\audio)
   --all    печатать полную таблицу блоков, а не только проблемы и Long Text

   Раскладка package-режима расширения: <база>__<метка>, номер блока = pad3.
   Корневые файлы «<голос> -<первые слова>» — ручные выгрузки Long Text (>5000 знаков).

   Exit 1, если у какого-то блока нет ни файла в папке, ни корневого Long Text. */
const fs = require("fs");
const path = require("path");
const parser = require(path.join(__dirname, "..", "parser.js"));
const resolver = require(path.join(__dirname, "..", "voice_mapping.js"));

const args = process.argv.slice(2);
function arg(name, fallback = "") {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}
const showAll = args.includes("--all");

function latestTextsDir() {
  const root = "E:\\Project files\\!North Union";
  if (!fs.existsSync(root)) return "";
  const dirs = fs
    .readdirSync(root)
    .map((name) => path.join(root, name, "txt", "translated"))
    .filter((dir) => fs.existsSync(dir))
    .map((dir) => ({ dir, mtime: fs.statSync(dir).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return dirs.length ? dirs[0].dir : "";
}

const textsDir = arg("--texts") || latestTextsDir();
const audioDir = arg("--audio") || path.join(path.dirname(path.dirname(textsDir)), "audio");
if (!textsDir || !fs.existsSync(textsDir)) {
  console.error("не найден каталог с текстами — передай --texts <dir>");
  process.exit(2);
}
if (!fs.existsSync(audioDir)) {
  console.error(`не найден каталог audio: ${audioDir}`);
  process.exit(2);
}

/* Копия sanitizeFilename из background.js — иначе имена не сойдутся. */
function sanitizeFilename(filename) {
  return String(filename)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\.{2,}/g, "_")
    .replace(/^\.+/, "")
    .replace(/\.+$/, "")
    .replace(/\s+/g, "_")
    .slice(0, 100);
}

/* Для сравнения «первых слов» из имени корневого файла с телом блока:
   выкидываем всё, кроме букв и цифр, и приводим к нижнему регистру. */
function loose(value) {
  return String(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/* --- что лежит в audio --- */
const folderFiles = new Map(); // папка -> [{num, prefix, speaker, file}]
const rootFiles = []; // [{voice, snippet, file}]
for (const item of fs.readdirSync(audioDir, { withFileTypes: true })) {
  const full = path.join(audioDir, item.name);
  if (item.isDirectory()) {
    const list = [];
    for (const name of fs.readdirSync(full).filter((n) => n.toLowerCase().endsWith(".mp3"))) {
      const parsed = name.match(/^(\d+)_+(.+?)\.mp3$/i);
      if (!parsed) continue;
      const parts = parsed[2].split("__");
      list.push({
        num: Number(parsed[1]),
        prefix: parsed[2],
        speaker: parts.length > 1 ? parts.slice(1).join("__") : parsed[2],
        base: parts.length > 1 ? parts[0] : "",
        file: `${item.name}/${name}`,
        size: fs.statSync(path.join(full, name)).size,
      });
    }
    folderFiles.set(item.name, list);
  } else if (item.name.toLowerCase().endsWith(".mp3")) {
    const parsed = item.name.match(/^(.+?)\s+-\s*(.+)\.mp3$/i);
    if (parsed) rootFiles.push({ voice: parsed[1].trim(), snippet: parsed[2].trim(), file: item.name });
  }
}

/* --- сверка по текстам --- */
const texts = fs.readdirSync(textsDir).filter((n) => n.endsWith(".md")).sort();
const problems = [];
const rootUsage = new Map(); // файл -> [{text, index, offset}]
const allBlocks = []; // все блоки проекта — чтобы отличать дубль от «ничей»
let totalBlocks = 0;
let totalOk = 0;

for (const name of texts) {
  const base = sanitizeFilename(name.replace(/\.[^.]+$/, ""));
  const entries = parser.parseMarkdown(fs.readFileSync(path.join(textsDir, name), "utf8"));
  const files = folderFiles.get(base) || [];
  /* Номер файла = номер блока (`forceIndex`) — привязка по нему, а не по метке:
     у одной роли десятки одинаковых меток, и жадный матч по метке называет
     пропущенным не тот блок (кейс 25.09: у Украины «нет 25» вместо «нет 2»). */
  const byNumber = new Map(files.map((f) => [f.num, f]));
  const duplicateNumbers = files.length - byNumber.size;
  const rows = [];
  let missing = 0;
  let longText = 0;

  entries.forEach((entry, i) => {
    totalBlocks += 1;
    allBlocks.push({ text: name, index: i + 1, body: loose(entry.text) });
    const want = sanitizeFilename(entry.speaker);
    const file = byNumber.get(i + 1);
    if (file) {
      byNumber.delete(i + 1);
      totalOk += 1;
      const warn = file.speaker === want ? "" : `  ⚠ в файле метка ${file.speaker}`;
      rows.push({ n: i + 1, label: entry.speaker, chars: entry.text.length, state: "папка", file: file.file + warn });
      return;
    }
    /* нет файла в папке — ищем корневые Long Text по первым словам тела */
    const body = loose(entry.text);
    const chunks = rootFiles
      .map((rf) => ({ rf, offset: body.indexOf(loose(rf.snippet)) }))
      .filter((c) => c.offset >= 0)
      .sort((a, b) => a.offset - b.offset);
    if (chunks.length) {
      longText += 1;
      totalOk += 1;
      for (const c of chunks) {
        if (!rootUsage.has(c.rf.file)) rootUsage.set(c.rf.file, []);
        rootUsage.get(c.rf.file).push({ text: name, index: i + 1, offset: c.offset });
      }
      rows.push({
        n: i + 1,
        label: entry.speaker,
        chars: entry.text.length,
        state: `Long Text x${chunks.length}`,
        file: chunks.map((c) => c.rf.file).join(" | "),
      });
      return;
    }
    missing += 1;
    rows.push({ n: i + 1, label: entry.speaker, chars: entry.text.length, state: "НЕТ", file: "" });
    problems.push(
      `${name.slice(0, 8)} блок ${String(i + 1).padStart(2)} ${entry.speaker} (${entry.text.length} знаков) — нет ни файла в папке, ни Long Text в корне`,
    );
  });

  const orphans = [...byNumber.values()].sort((a, b) => a.num - b.num);
  const inFolder = entries.length - missing - longText;
  console.log(
    `${name.slice(0, 8)}  блоков ${String(entries.length).padStart(3)} | в папке ${String(inFolder).padStart(3)} | Long Text ${String(longText).padStart(2)} | НЕТ ${missing}${orphans.length ? ` | лишних файлов ${orphans.length}` : ""}  ${name.slice(8, 46)}`,
  );
  if (showAll || missing || orphans.length) {
    for (const row of rows) {
      if (showAll || row.state === "НЕТ" || row.state.startsWith("Long Text")) {
        console.log(`    ${String(row.n).padStart(2)}. ${row.label.padEnd(34)} ${String(row.chars).padStart(6)} зн. ${row.state.padEnd(12)} ${row.file}`);
      }
    }
    for (const orphan of orphans) {
      console.log(`    -- лишний файл без блока: ${String(orphan.num).padStart(3)} ${orphan.speaker} (${orphan.file})`);
    }
    if (duplicateNumbers > 0) console.log(`    -- дублей номеров: ${duplicateNumbers} (уникализация имён « (1)» — перепроверь папку)`);
  }
}

/* --- корневые Long Text: сколько частей и в каком порядке --- */
const unused = rootFiles.filter((f) => !rootUsage.has(f.file));
console.log(`\nтексты: ${textsDir}\naudio:  ${audioDir}`);
console.log(`блоков: ${totalBlocks} | закрыто: ${totalOk} | проблем: ${problems.length} | корневых Long Text файлов: ${rootFiles.length}`);
for (const [file, uses] of [...rootUsage].sort()) {
  const where = uses.map((u) => `${u.text.slice(0, 8)} блок ${u.index} (позиция ${u.offset})`).join("; ");
  console.log(`  Long Text ${file}  ->  ${where}`);
}
if (unused.length) {
  console.log("  корневые файлы вне работы:");
  for (const f of unused) {
    const needle = loose(f.snippet);
    const hits = allBlocks.filter((b) => needle && b.body.includes(needle)).map((b) => `${b.text.slice(0, 8)} блок ${b.index}`);
    console.log(hits.length ? `    дубль (блок уже озвучен): ${f.file}  ->  ${hits.join("; ")}` : `    НИЧЕЙ: ${f.file}`);
  }
}
for (const problem of problems) console.log("  НЕТ:", problem);

process.exit(problems.length ? 1 : 0);
