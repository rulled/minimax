# MiniMax TTS Automation — инварианты

Chrome MV3 расширение (`manifest.json`, v3.3.2), plain JS без сборщика. Тесты — `node --test tests/<файл>` (npm-скриптов нет).

- **`dist/` и `backups/` не править руками.** `dist/test` — старая копия 3.2.4; релиз собирается `scripts/build-release.ps1` → `dist/minimax-v<версия>.zip`. `backups/*.bak` — снимки перед правкой резолвера. Хук `vsl-pipeline-guard.ts` блокирует правки в этих путях.
- Расширение грузится из корня репозитория (`chrome://extensions` → Load unpacked), не из `dist/`.
- Тесты после правок: `parser.js` → `tests/parser.test.js`; `voice_mapping.js` → `tests/voice_mapping.test.js`; `content_script.js`/`background.js`/`direct_transport.js`/`parallel_batch.js` → `tests/rate_limit.test.js` (тесты поднимают реальный `content_script.js` в VM с заглушками Chrome); `switchVoice`/`selectVoiceRecord` → `tests/voice_switch.test.js`.
- Голос ставится экшеном стора MiniMax (`tts/selectVoice`) через мост `background.js → selectVoiceRecord` (`switchVoice` → `selectVoiceViaStore`), а не кликом по карточке в модалке Voice Selection. Причина: с 29.09.2026 поле поиска в модалке ищет только библиотеку — запрос уходит с `is_system:true` при любом активном табе, поэтому свои голоса (My Voices) карточкой не находятся. UI-ветка `switchVoice` оставлена откатом на случай смены модулей сайта; реальные id модулей сайта (`3833` — срез `tts`, `98719` — `voice`, `66021` — стор) ищутся с fallback'ом по исходникам модулей.
- Ошибка MiniMax `2600018` (rate limit) приходит ДО списания → реплика переотправляется (пауза 10 с, до 20 попыток); фатальна только неоднозначная оплата (`accepted_unknown`).
- Свежий `parse`-путь: блоки режутся по жирным меткам спикеров; ломать этот разрез нельзя.
- Git: `origin` → `github.com/rulled/minimax`. Коммит/PR — через плагин `commit-commands`.
