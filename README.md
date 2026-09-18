# minimax

Chrome extension for automating MiniMax text-to-speech workflows and organizing generated downloads.

## What it does

- Works on the MiniMax text-to-speech page
- Parses script files and helps assign speakers and voices
- Automates batch generation and download handling
- Renames and groups downloaded audio files into structured folders

## Script format

A script file is split into voicing blocks by bold markdown headers: one block =
one header + all text up to the next header, paragraphs joined with a newline.
The header is the only mandatory separator; the colon and the index are optional.

```
**Диктор**              базовый вариант
**Диктор:**             двоеточие внутри жирного
**Диктор**:             двоеточие после жирного
**Диктор 1**            с индексом
**ДИКТОР(70739835) 1:** индекс + идентификатор пака
**Диктор**: текст       inline: текст в той же строке (двоеточие обязательно)
```

- The index never reaches the voice mapping: `**Диктор**`, `**Диктор 1**` and
  `**Диктор 7**` are the same speaker.
- Block order always follows the file, so scripts without numbering keep the
  original sequence (it becomes the `download_index` used for slicing).
- Optional metadata comments: `<!-- language_code: ES -->`,
  `<!-- minimax_language: Spanish -->`, `<!-- script_name: ... -->`,
  `<!-- download_index: 7 -->`.

## Tests

```bash
node --test "tests/**/*.test.js"
```

## Install locally

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click `Load unpacked`
4. Select this repository folder

## Release

Build a clean release archive with:

```powershell
.\scripts\build-release.ps1
```

The resulting zip is created in `dist/` and can be attached to a GitHub release.
