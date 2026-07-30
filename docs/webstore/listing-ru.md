# Chrome Web Store Listing

## Recommended name
`MiniMax TTS Automation`

If you want a safer non-official positioning for review, use:
`MiniMax TTS Automation Helper`

## Short description
`Неофициальный помощник для пакетной озвучки в MiniMax TTS: очереди, голоса, языки и аккуратная загрузка MP3.`

## Full description
`MiniMax TTS Automation` помогает быстро озвучивать сценарии и диалоги в интерфейсе MiniMax TTS без ручного переключения каждой реплики.

Что умеет расширение:

- Загружает Markdown-сценарии и разбирает реплики по спикерам.
- Поддерживает single и multi-режимы озвучки.
- Автоматически подставляет текст в MiniMax TTS и запускает генерацию.
- Снижает число лишних переключений голоса в multi-режиме.
- Сохраняет исходную нумерацию реплик в именах MP3, чтобы файлы было удобно раскладывать на таймлайн.
- Организует пакетные загрузки по папкам и понятным именам файлов.
- Сохраняет локальные настройки голосов, исключения и историю загрузок.

Типичный сценарий использования:

1. Откройте страницу MiniMax TTS.
2. Нажмите на иконку расширения.
3. Загрузите `.md`-файл или вставьте сценарий.
4. Назначьте голоса и язык.
5. Запустите автоматическую озвучку и дождитесь загрузки MP3.

Важно:

- Расширение работает только на странице `https://www.minimax.io/audio/text-to-speech`.
- Для работы нужен аккаунт MiniMax и доступ к TTS в самом сервисе.
- Расширение является неофициальным помощником и не связано с MiniMax как с издателем.

## Category
`Productivity`

## Language
`Russian`

## Website
Use the repository homepage:

`https://github.com/rulled/minimax`

## Support URL
Recommended:

`https://github.com/rulled/minimax/issues`

## Privacy policy URL
Publish `docs/webstore/privacy-policy.html` at a public URL.

If you enable GitHub Pages from the `/docs` folder, the URL will usually look like:

`https://rulled.github.io/minimax/webstore/privacy-policy.html`

If you publish the repository another way, adjust the path accordingly.

## Single purpose statement for review
This extension automates text-to-speech workflow on the MiniMax TTS page: it fills text, switches voices/languages, waits for generation to finish, and downloads the resulting MP3 files with organized names.

## Permissions justification
- `storage`: saves voice mappings, skipped entries, UI state, batch queue state, and download history locally.
- `downloads`: saves generated MP3 files to the user's Downloads folder with structured names.
- `scripting`: executes a small bridge in the page's main world to interact with Slate/React input and capture generated audio safely.
- Host access only to `https://www.minimax.io/audio/text-to-speech*`: required because the extension works only on the MiniMax TTS page.

## Data disclosure notes
Recommended answers for the Chrome Web Store privacy section:

- Personal data collected by the extension itself: `No`
- Sold to third parties: `No`
- Used for purposes unrelated to core functionality: `No`
- Creditworthiness / lending purposes: `No`

Clarification:

- The extension stores settings locally in Chrome storage.
- The extension downloads MP3 files locally to the user's machine.
- The extension does not run analytics, ads, or external tracking code.
- User-provided text is processed in the already open MiniMax page because the extension automates that workflow.
