# MiniMax TTS Automation — инварианты

Chrome MV3 расширение (`manifest.json`, v3.3.2), plain JS без сборщика. Тесты — `node --test tests/<файл>` (npm-скриптов нет).

- **`dist/` и `backups/` не править руками.** `dist/test` — старая копия 3.2.4; релиз собирается `scripts/build-release.ps1` → `dist/minimax-v<версия>.zip`. `backups/*.bak` — снимки перед правкой резолвера. Хук `vsl-pipeline-guard.ts` блокирует правки в этих путях.
- Расширение грузится из корня репозитория (`chrome://extensions` → Load unpacked), не из `dist/`.
- Тесты после правок: `parser.js` → `tests/parser.test.js`; `voice_mapping.js` → `tests/voice_mapping.test.js`; `content_script.js`/`background.js`/`direct_transport.js`/`parallel_batch.js` → `tests/rate_limit.test.js` (тесты поднимают реальный `content_script.js` в VM с заглушками Chrome); `switchVoice`/`selectVoiceRecord` → `tests/voice_switch.test.js`; прямое управление стором (`setStoreText`, `setStoreLanguage`, `setStoreLongTextMode`, `setStoreSettings`) → `tests/direct_state.test.js`.
- Состояние MiniMax (голос, текст, язык, настройки скорости/высоты/громкости, режим Long Text) ставится напрямую через Redux-стор MiniMax (`66021`, экшены модуля `3833`: `tts/selectVoice`, `tts/setText`, `tts/setLanguage`, `tts/updateSettings`, `tts/updateIsAsync`, и `detect/setIsDetecting` из `56289`). UI-ветки оставлены откатом. Это ускоряет подготовку реплики с ~3 с до <20 мс и предотвращает засыпание фоновых вкладок при параллельной озвучке в 2 потока. Для многопоточного режима предусмотрен стартовый сдвиг воркеров (`startDelayMs`), а при ошибке `2600018` — джиттер задержки (10–12.5 с), исключающий синхронные повторы.
- Ошибка MiniMax `2600018` (rate limit) приходит ДО списания → реплика переотправляется (пауза 10 с, до 20 попыток); фатальна только неоднозначная оплата (`accepted_unknown`).
- Свежий `parse`-путь: блоки режутся по жирным меткам спикеров; ломать этот разрез нельзя.
- Git: `origin` → `github.com/rulled/minimax`. Коммит/PR — через плагин `commit-commands`.
