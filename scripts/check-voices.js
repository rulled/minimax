#!/usr/bin/env node
/* Сверка списка голосов MiniMax с метками переведённых текстов:
   какие роли не разрешаются автоматически (missing / ambiguous).

   Usage:
     node scripts/check-voices.js --voices voices.txt [--texts <dir>] [--all]

   --voices  файл со списком имён голосов (по одному в строке, как копируется
             из аккаунта; префиксы «-», «•», нумерация вида «1. » срезаются).
             Без --voices список читается со stdin.
   --texts   каталог с .md (по умолчанию — самый свежий
             «E:\Project files\!North Union\<DD.MM>\txt\translated»).
   --all     печатать всю таблицу решений, а не только нерешённые роли.

   Exit code 1, если есть нерешённые роли (удобно для проверок перед сдачей). */
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
const voicesFile = arg("--voices");

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
if (!textsDir || !fs.existsSync(textsDir)) {
  console.error("не найден каталог с текстами — передай --texts <dir>");
  process.exit(2);
}

let raw = voicesFile ? fs.readFileSync(voicesFile, "utf8") : fs.readFileSync(0, "utf8");
const names = raw
  .split(/\r?\n/)
  .map((line) => line.replace(/^\s*(?:[-–—•*]|\d+[.)])\s*/, "").trim())
  .filter(Boolean);
if (!names.length) {
  console.error("пустой список голосов — передай --voices <file> или stdin");
  process.exit(2);
}
const voices = names.map((name, index) => ({ voiceId: String(index), voiceName: name, voiceStatus: 2 }));

const files = fs.readdirSync(textsDir).filter((name) => name.endsWith(".md")).sort();
if (!files.length) {
  console.error(`в ${textsDir} нет .md`);
  process.exit(2);
}

const problems = [];
for (const file of files) {
  const entries = parser.parseMarkdown(fs.readFileSync(path.join(textsDir, file), "utf8"));
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.speaker)) continue;
    seen.add(entry.speaker);
    const res = resolver.resolveVoice(entry.speaker, entry.languageCode, voices);
    const verdict = res.status === "ok" ? `-> ${res.voice.voiceName}` : `${res.status} (${res.candidates.length})`;
    if (showAll) console.log(file.slice(0, 8), entry.speaker.padEnd(36), verdict);
    if (res.status !== "ok") problems.push(`${file.slice(0, 8)}  ${entry.speaker}  ${verdict}`);
  }
}

console.log(`\nтексты: ${textsDir}`);
console.log(`голосов: ${voices.length} | файлов: ${files.length} | не решается ролей: ${problems.length}`);
for (const problem of problems) console.log("  ", problem);
process.exit(problems.length ? 1 : 0);
