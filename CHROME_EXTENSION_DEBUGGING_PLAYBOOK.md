# Chrome Extension Debugging Playbook

Практический журнал и переносимое руководство по отладке Chrome-расширений, особенно Manifest V3 расширений, которые автоматизируют сторонний сайт, используют popup, content script, service worker, `chrome.storage`, `chrome.downloads`, `chrome.alarms` и MAIN-world bridge.

Документ основан на реальной end-to-end отладке MiniMax TTS Automation `3.2.0`. Специфичные имена и селекторы приведены как примеры, но большинство техник применимо к другим расширениям.

## 1. Главные принципы

1. Сначала зафиксировать текущее состояние, затем менять код.
2. Для реального сайта использовать отдельный Chrome-профиль и Chrome DevTools Protocol (CDP).
3. Не считать DOM единственным источником истины: проверять extension storage, API-ответы, History и физические файлы.
4. Manifest V3 service worker может уснуть или перезапуститься в любой момент. Важное состояние должно храниться в `chrome.storage.local`.
5. Любое платное или необратимое действие должно быть идемпотентным либо защищённым baseline, статусами и проверкой History.
6. После перезагрузки расширения обязательно перезагружать целевую вкладку, иначе старый content script продолжит работать или content script вообще не будет подключён.
7. Не повторять `Generate` или `Proceed`, пока не проверены DOM, History и сохранённое состояние. Повторный клик может создать платный дубль.
8. Проверять результат по слоям: UI, storage, API/History, downloads history, файлы на диске.

## 2. Инструменты, которые использовались

### Работа с кодом

- `Glob`: поиск файлов без предположений о структуре проекта.
- `Grep`: поиск обработчиков сообщений, storage keys, селекторов, ошибок и API endpoints.
- `Read`: чтение точных участков файлов с номерами строк.
- `apply_patch`: все ручные изменения исходников и временных диагностических скриптов.
- `node --check`: быстрая синтаксическая проверка JavaScript без запуска расширения.

### Работа с Chrome

- Chrome DevTools Protocol на `127.0.0.1:9222`.
- CDP HTTP endpoints:
  - `GET /json/version`
  - `GET /json`
  - `PUT /json/new?<encoded-url>`
  - `GET /json/activate/<target-id>`
- Встроенный `WebSocket` в Node.js 24 для вызовов CDP без Playwright и дополнительных пакетов.
- CDP domains:
  - `Runtime.evaluate`
  - `DOM.getDocument`
  - `DOM.querySelector`
  - `DOM.setFileInputFiles`

### Работа с процессами и файлами

- PowerShell `Get-Process` и `Get-CimInstance Win32_Process` для проверки процессов и аргументов запуска.
- `Stop-Process -Force` только после попытки штатного закрытия и явного разрешения на перезапуск.
- `Get-ChildItem`, `Measure-Object` для финальной проверки количества и размера MP3.
- `Compress-Archive` для проверенного backup после live-теста.

## 3. Подготовка отдельного debug-профиля Chrome

### Почему нельзя полагаться на обычный профиль

Современный Chrome может игнорировать `--remote-debugging-port` для стандартного пользовательского профиля. Процесс будет запущен с флагом, renderer-процессы даже покажут этот флаг, но `http://127.0.0.1:9222/json/version` останется недоступен.

Надёжный вариант: отдельный `--user-data-dir`. Пользователь может один раз войти в нужный аккаунт, после чего тестовый профиль сохраняет сессию между перезапусками.

### Проверка родительской директории

Перед созданием папки проверить, что родитель существует:

```powershell
$parent = 'C:\Users\<user>\AppData\Local\Temp\opencode'
if (-not (Test-Path -LiteralPath $parent)) {
    throw "Missing parent directory: $parent"
}
```

### Запуск тестового профиля

```powershell
$profile = 'C:\Users\<user>\AppData\Local\Temp\opencode\chrome-debug-profile'
$extension = 'D:\path\to\extension'

if (-not (Test-Path -LiteralPath $profile)) {
    New-Item -ItemType Directory -Path $profile | Out-Null
}

Start-Process `
    -FilePath 'C:\Program Files\Google\Chrome\Application\chrome.exe' `
    -ArgumentList @(
        "--user-data-dir=$profile",
        '--remote-debugging-port=9222',
        '--no-first-run',
        '--no-default-browser-check',
        "--load-extension=$extension",
        'https://example.com/target-page'
    )
```

### Проверка CDP

```powershell
Invoke-RestMethod `
    -Uri 'http://127.0.0.1:9222/json/version' `
    -TimeoutSec 5 |
    Select-Object Browser, webSocketDebuggerUrl
```

Ожидается `webSocketDebuggerUrl`. Если соединения нет:

1. Проверить, что Chrome действительно завершился перед новым запуском.
2. Проверить командную строку главного процесса.
3. Проверить наличие отдельного `--user-data-dir`.
4. Проверить, не занят ли порт другим процессом.
5. Не запускать второй Chrome поверх уже открытого процесса того же профиля.

### Проверка аргументов процесса

```powershell
Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" |
    Select-Object ProcessId, CommandLine
```

## 4. Безопасный перезапуск Chrome

Сначала штатное закрытие главного окна:

```powershell
$main = Get-Process -Name chrome |
    Where-Object MainWindowHandle -ne 0 |
    Select-Object -First 1

$main.CloseMainWindow()
```

Затем подождать и проверить остаточные процессы:

```powershell
Start-Sleep -Seconds 3
@(Get-Process -Name chrome -ErrorAction SilentlyContinue).Count
```

Если Chrome не завершился и перезапуск явно разрешён:

```powershell
Get-Process -Name chrome -ErrorAction SilentlyContinue | Stop-Process -Force
```

Принудительное завершение может привести к восстановлению вкладок и незавершённых форм. Перед этим нельзя оставлять активную платную генерацию без сохранённого state.

## 5. Инспекция CDP targets

### Получение списка targets

```powershell
(Invoke-WebRequest `
    -UseBasicParsing `
    -Uri 'http://127.0.0.1:9222/json' `
    -TimeoutSec 10).Content
```

Полезные target types:

- `page`: обычная вкладка или открытая extension page.
- `iframe`: отдельный iframe, например authentication iframe.
- `worker`: worker страницы.
- `service_worker`: service worker расширения, если он в данный момент активен.

Отсутствие service worker target не означает, что расширение сломано. Manifest V3 worker может быть выгружен в idle.

### Открытие popup как обычной вкладки

Popup удобнее отлаживать как самостоятельную extension page:

```powershell
$url = 'chrome-extension://<extension-id>/popup.html'
$encoded = [uri]::EscapeDataString($url)

Invoke-WebRequest `
    -UseBasicParsing `
    -Method Put `
    -Uri "http://127.0.0.1:9222/json/new?$encoded"
```

Преимущества:

- popup не закрывается при потере фокуса;
- доступен отдельный `webSocketDebuggerUrl`;
- можно читать DOM и `chrome.storage.local`;
- можно программно нажимать кнопки и назначать file input.

### Важная ловушка активной вкладки

Если popup открыт как отдельная вкладка, он может стать active tab. Тогда код вида:

```js
chrome.tabs.query({ active: true, currentWindow: true })
```

вернёт extension page, а не целевой сайт. Сообщение content script завершится ошибкой:

```text
Could not establish connection. Receiving end does not exist.
```

Перед действиями, которые используют active tab, активировать целевой target:

```powershell
Invoke-WebRequest `
    -UseBasicParsing `
    -Uri 'http://127.0.0.1:9222/json/activate/<target-id>'
```

Более надёжный код расширения должен искать вкладку по URL, а active tab использовать только как быстрый путь:

```js
const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
const activeTarget = activeTabs.find((tab) => tab.url?.startsWith(TARGET_URL));
if (activeTarget?.id) return activeTarget.id;

const tabs = await chrome.tabs.query({ currentWindow: true });
return tabs.find((tab) => tab.url?.startsWith(TARGET_URL))?.id ?? null;
```

## 6. Минимальный Node CDP-клиент без зависимостей

Node.js 22+ предоставляет глобальный `WebSocket`. Этого достаточно для диагностического клиента.

```js
const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const target = targets.find((item) => {
  return item.type === 'page' && item.url.includes('example.com');
});

if (!target) throw new Error('Target not found');

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});

let requestId = 0;
const pending = new Map();

socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  const request = pending.get(message.id);
  if (!request) return;

  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
};

function send(method, params = {}) {
  const id = ++requestId;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

const result = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    title: document.title,
    text: document.body.innerText,
    url: location.href,
  })`,
  awaitPromise: true,
  returnByValue: true,
});

console.log(result.result.value);
socket.close();
```

Для временных диагностических скриптов:

1. Создавать файл через patch, а не генерировать shell-командой.
2. Не добавлять секреты, cookies и API keys.
3. Удалять скрипт после завершения диагностики.
4. Не включать временный скрипт в финальный backup.

## 7. Инспекция страницы и popup

### Текст страницы

```js
JSON.stringify({
  title: document.title,
  text: document.body.innerText.slice(0, 30000),
  url: location.href,
})
```

Это позволяет быстро проверить:

- авторизацию;
- баланс или credits;
- текущий голос;
- выбранный язык;
- состояние Long Text;
- наличие History;
- видимые modal buttons.

Не сохранять полный body text в постоянный лог, если там есть персональные или чувствительные данные.

### Все controls popup

```js
JSON.stringify([
  ...document.querySelectorAll('input, select, button'),
].map((element) => ({
  tag: element.tagName,
  id: element.id,
  type: element.type,
  value: element.value,
  text: element.innerText,
  disabled: element.disabled,
  options: element.options
    ? [...element.options].map((option) => ({
        text: option.text,
        value: option.value,
        selected: option.selected,
      }))
    : undefined,
})))
```

### Только видимые кнопки страницы

```js
JSON.stringify([...document.querySelectorAll('button')]
  .filter((button) => {
    const rect = button.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  })
  .map((button) => ({
    text: button.innerText,
    ariaLabel: button.getAttribute('aria-label'),
    title: button.getAttribute('title'),
    className: button.className,
  })))
```

Эта техника обнаружила видимый `Proceed`, который не был очевиден из общего состояния popup.

## 8. Чтение и изменение chrome.storage.local

В extension page доступен `chrome.storage.local`:

```js
new Promise((resolve) => {
  chrome.storage.local.get(null, (data) => {
    resolve(JSON.stringify(data));
  });
})
```

Не выводить весь storage без необходимости. Очереди могут содержать десятки тысяч символов и превысить лимиты терминала. Лучше строить summary:

```js
new Promise((resolve) => {
  chrome.storage.local.get(
    ['longTextState', 'batchState', 'downloadHistory'],
    (data) => {
      const tasks = data.longTextState?.tasks ?? [];
      resolve(JSON.stringify({
        longText: tasks.map((task) => ({
          status: task.status,
          audioId: task.audioId,
          voiceId: task.voiceId,
          scriptName: task.scriptName,
          length: task.text?.length,
          error: task.error,
        })),
        batchRunning: data.batchState?.isRunning,
        downloads: data.downloadHistory?.length ?? 0,
      }));
    },
  );
})
```

### Полезные статусы Long Text

- `queued`: ожидает отправки.
- `submitting`: content script выполняет UI submit.
- `awaiting_match`: MiniMax принял задачу, но `audio_id` ещё не сопоставлен.
- `pending`: History record найден, сервер ещё генерирует.
- `ready`: URL готов, ожидается скачивание.
- `downloading`: download запущен.
- `completed`: download завершён.
- `error`: отправка или серверный статус завершились ошибкой.

### Что хранить для восстановления

Для каждой платной Long Text задачи желательно сохранять:

- локальный уникальный ID;
- text или стабильный hash текста;
- voice ID;
- language;
- script name;
- output filename;
- `submittedAt` до отправки;
- `audioId`, когда он известен;
- текущий status;
- error;
- baseline History IDs.

## 9. Загрузка реальных файлов в hidden file input

Присваивание `input.value` запрещено браузером. Для настоящего `<input type="file">` использовать CDP:

```js
const documentResult = await send('DOM.getDocument');
const inputResult = await send('DOM.querySelector', {
  nodeId: documentResult.root.nodeId,
  selector: '#multiScriptFile',
});

await send('DOM.setFileInputFiles', {
  nodeId: inputResult.nodeId,
  files: [
    'D:\\input\\first.md',
    'D:\\input\\second.md',
  ],
});
```

Chrome обычно сам отправляет ожидаемые input/change события. После загрузки всегда проверить storage и UI:

- имена файлов;
- число parsed entries;
- длины текстов;
- excluded IDs;
- определённый язык;
- voice mappings.

## 10. Автоматизация custom controls

Для React/controlled inputs недостаточно изменить `.value`. Нужно отправить событие:

```js
select.value = 'Spanish';
select.dispatchEvent(new Event('change', { bubbles: true }));
```

Для text input:

```js
input.value = 'voice-name';
input.dispatchEvent(new Event('change', { bubbles: true }));
```

Если React игнорирует прямое присваивание, использовать native setter:

```js
const setter = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  'value',
).set;

setter.call(input, value);
input.dispatchEvent(new Event('input', { bubbles: true }));
input.dispatchEvent(new Event('change', { bubbles: true }));
```

После каждого массового назначения проверять итоговый storage, а не только видимое значение input.

## 11. Content script после загрузки или обновления расширения

`--load-extension` не гарантирует, что content script появится в уже открытой вкладке. Типичный симптом:

```text
Could not establish connection. Receiving end does not exist.
```

Решение:

1. Перезагрузить целевую вкладку.
2. Подождать завершения загрузки SPA.
3. Повторить `chrome.tabs.sendMessage`.
4. Проверить URL против `content_scripts.matches`.

После изменения `content_script.js`:

1. Перезагрузить расширение.
2. Перезагрузить целевую вкладку.
3. Не делать это во время активного UI action без persisted state.

Программная перезагрузка расширения из extension page:

```js
chrome.runtime.reload();
```

Соединение CDP с extension page может закрыться до ответа. Это нормально: сама страница уничтожается вместе с extension context.

## 12. Manifest V3 service worker

### Главная особенность

Service worker не является долгоживущим background page. Он засыпает, а in-memory переменные исчезают.

Плохой вариант:

```js
let queue = [];
let isRunning = false;
```

Если эти значения не сохраняются, после пробуждения worker потеряет задачу.

Надёжный вариант:

```js
async function saveState() {
  await chrome.storage.local.set({ queueState });
}

async function loadState() {
  const data = await chrome.storage.local.get('queueState');
  queueState = data.queueState ?? getDefaultState();
}
```

### Восстановление interrupted states

При старте worker:

- `queued` до фактической отправки можно безопасно пометить ошибкой или вернуть в очередь;
- `submitting` с `submittedAt` нельзя слепо повторять: сначала искать задачу в History;
- `awaiting_match` нужно продолжать reconciliate;
- `pending` нужно polling-ить;
- `ready/downloading` нужно проверить через `chrome.downloads.search` или повторно запустить download только с защитой от дубля.

## 13. MAIN-world bridge

Content script работает в isolated world и не всегда видит внутренние объекты React, monkey-patched XHR или page globals. Для доступа к странице использовался MAIN-world bridge через `chrome.scripting.executeScript({ world: 'MAIN' })` и обмен сообщениями.

MAIN-world bridge полезен для:

- доступа к React Fiber/Slate editor;
- корректной вставки текста через `beforeinput`;
- перехвата page-owned `XMLHttpRequest`;
- чтения History API response;
- очистки controlled editor;
- вызова page-specific APIs без копирования auth cookies.

Правила:

1. Bridge должен иметь небольшой явный API.
2. Не передавать функции через границу worlds.
3. Возвращать JSON-сериализуемые данные.
4. Добавлять timeout для каждого вызова.
5. Проверять `{ ok, reason }`, а не только truthy result.
6. Не логировать токены и полный сетевой payload без необходимости.

## 14. Перехват History API

В реальной сессии History загружался через:

```text
/v1/api/audio/history_list
```

Перехват XHR в MAIN world:

```js
const originalOpen = XMLHttpRequest.prototype.open;
const capture = {
  installed: true,
  snapshot: null,
  capturedAt: 0,
};

XMLHttpRequest.prototype.open = function(method, url) {
  this.__historyUrl = String(url ?? '');

  if (!this.__historyHooked) {
    this.__historyHooked = true;
    this.addEventListener('load', function() {
      if (!this.__historyUrl.includes('/history_list')) return;

      try {
        capture.snapshot = JSON.parse(this.responseText || '{}');
        capture.capturedAt = Date.now();
      } catch (error) {
        console.warn('History response parse failed', error);
      }
    });
  }

  return originalOpen.apply(this, arguments);
};
```

После установки hook нужно инициировать реальный UI-запрос History. Перехват не увидит запросы, которые произошли до установки.

## 15. Baseline и сопоставление History records

Перед платной отправкой получить текущий список `audio_id` и сохранить его как baseline. Новая задача не должна сопоставляться с baseline record, даже если текст и голос совпадают.

Минимальные критерии сопоставления:

1. Если `audioId` уже известен, искать только его.
2. Иначе сравнить нормализованный текст.
3. Если известен voice ID, сравнить voice name.
4. Исключить baseline IDs и IDs, уже занятые другими локальными задачами.
5. Отсортировать кандидатов по близости `update_time` к `submittedAt`.
6. Не брать record значительно старше `submittedAt`.

### Нельзя сравнивать текст побайтно

Редактор или API может нормализовать:

- `\r\n` в `\n`;
- перенос строки в пробел;
- несколько пробелов в один;
- leading/trailing whitespace.

Нормализация:

```js
function normalizeComparableText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}
```

Сравнение:

```js
normalizeComparableText(item.text) === normalizeComparableText(task.text)
```

Именно strict equality исходных строк стала причиной того, что готовая Long Text задача оставалась `awaiting_match`.

## 16. Slate/contenteditable и переносы строк

Slate editor может принять строку с `\n`, но сохранить её без этих символов или без ожидаемой структуры paragraph nodes.

В реальной реплике было 8801 символов и два переноса строк. После вставки editor возвращал 8799 символов. Это была не потеря речи, а удаление двух `\n`.

Безопасная подготовка TTS-текста:

```js
text = String(text ?? '').replace(/\r\n?|\n/g, ' ');
```

После этого:

- вставляемая строка соответствует представлению editor;
- предложения не склеиваются без пробела;
- History matcher может использовать ту же whitespace normalization.

Проверять нужно нормализованный текст, но error message полезно дополнить raw lengths и первым отличающимся фрагментом.

## 17. Безопасный Long Text submit

Рекомендуемая последовательность:

1. Проверить длину и лимит.
2. Открыть Settings.
3. Установить голос.
4. Установить язык.
5. Включить Long Text.
6. Вставить нормализованный текст.
7. Проверить editor state.
8. Дождаться активного Generate.
9. Сохранить `submittedAt` до потенциально необратимого шага.
10. Нажать Generate.
11. Найти Proceed.
12. Нажать Proceed один раз.
13. Немедленно перевести задачу в `awaiting_match`.
14. Не повторять submit по timeout без проверки History.

### Защита от двойного Proceed

В live-сессии ручной `Proceed` был нажат, пока автоматический submit уже мог пройти. MiniMax создал второй History record.

Чтобы это не повторялось:

- не нажимать Proceed вручную только потому, что storage всё ещё показывает `submitting`;
- сначала проверить History UI/API;
- добавить task-level operation ID и локальный `proceedClickedAt`;
- после клика ждать исчезновения modal или появления History record;
- блокировать повторный клик, пока не истёк разумный reconciliation timeout;
- timeout после Generate трактовать как `awaiting_match`, а не как безопасную ошибку для retry.

Безопасное правило:

```text
Если Generate или Proceed могли быть нажаты, повторная отправка запрещена до History reconciliation.
```

## 18. Polling через chrome.alarms

`setInterval` ненадёжен для Manifest V3. Использовать `chrome.alarms`:

```js
await chrome.alarms.create('historyPoll', {
  delayInMinutes: 1,
  periodInMinutes: 1,
});
```

Handler:

```js
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'historyPoll') return;
  reconcileHistory().catch(console.error);
});
```

Alarm нужно очищать, когда активных задач больше нет.

В UI полезно показывать агрегаты:

- отправляется;
- ожидает;
- скачивается;
- готово;
- ошибок.

## 19. Downloads и точные имена файлов

### Почему CDN-имя может победить

`chrome.downloads.download({ url, filename })` обычно достаточно, но при redirects/CDN или параллельных событиях `onDeterminingFilename` может получить URL, для которого reservation ещё не создана.

Надёжный подход:

1. До `chrome.downloads.download` сохранить reservation `final URL -> expected filename`.
2. В `onDeterminingFilename` найти reservation.
3. Вызвать `suggest({ filename, conflictAction: 'overwrite' })` или выбранную conflict policy.
4. После завершения удалить reservation.
5. Сохранить download history.

### Имена файлов должны быть детерминированными

Для пакетной озвучки полезно включать:

- папку сценария;
- original entry index;
- script name;
- speaker;
- extension.

Пример:

```text
VSLM-1686_.../001__VSLM-1686_...__ДОКТОР(PA).mp3
```

Original index важнее completion order: Long Text может завершиться позже обычных реплик.

## 20. Проверка результата на диске

Нельзя считать задачу завершённой только по `status=completed`.

Проверить:

1. Ожидаемое количество файлов.
2. Все ожидаемые номера.
3. Отсутствие файлов нулевого размера.
4. Папки и имена.
5. При необходимости duration или возможность декодирования аудио.

PowerShell:

```powershell
$folder = 'C:\Users\<user>\Downloads\result-folder'
$files = @(Get-ChildItem -LiteralPath $folder -Filter '*.mp3' -File)

[pscustomobject]@{
    Count = $files.Count
    TotalBytes = ($files | Measure-Object -Property Length -Sum).Sum
    EmptyFiles = @($files | Where-Object Length -eq 0).Count
}
```

Для двух реальных VSL-файлов было проверено:

- 8 MP3 в первой папке;
- 8 MP3 во второй папке;
- 0 пустых файлов;
- около 71.9 MB суммарно.

## 21. Voice mapping

Автоподбор по подстрокам удобен, но опасен для production batch.

Проблемы:

- Unicode `\b` в JavaScript не всегда работает как ожидается с кириллицей;
- номер отзыва в сценарии может не совпадать с номером голоса;
- сортировка сайта может быть обратной;
- `doc`, `doc(PA)` и `doc (MX)` частично совпадают;
- fallback на первый gender match может выбрать неверный голос.

Перед запуском реальных файлов строить явную таблицу:

| Speaker | Voice |
| --- | --- |
| `ДОКТОР(PA)` | `mp doc(PA)` |
| `ДОКТОР(MX)` | `mp doc (MX)` |
| `ОТЗЫВ 1, ЖЕНЩИНА` | `mp отзыв женщина 1` |
| `ОТЗЫВ 2, МУЖЧИНА` | `mp отзыв мужчина 1` |
| `ОТЗЫВ 3, МУЖЧИНА` | `mp отзыв мужчина 2` |
| `ОТЗЫВ 4, МУЖЧИНА` | `mp отзыв мужчина 3` |

После назначения убедиться, что ни одна entry не excluded из-за missing voice.

## 22. Подготовка и проверка batch до запуска

До платной генерации получить summary:

- file name;
- language;
- entry ID;
- speaker;
- character length;
- voice ID;
- excluded status;
- regular или Long Text;
- expected output index.

Пример критериев готовности:

```text
files = 2
entries = 16
included = 16
longText = 6
regular = 10
language = Spanish for every entry
missing voices = 0
```

Только после этого нажимать Start.

## 23. Изолированный retry одной entry

Если одна entry не отправилась:

1. Дождаться завершения остальных задач.
2. Убедиться, что ошибка произошла до необратимого шага. Если неизвестно, сначала History.
3. Исключить все entries кроме проблемной.
4. Не очищать file counters и mappings.
5. Проверить expected output index.
6. Перезапустить только одну entry.
7. Снова проверить History и downloads.

Для persisted batch можно временно преобразовать `excludedIds`:

```js
files.forEach((file, fileIndex) => {
  const retryId = fileIndex === 0 ? 'target-entry-id' : null;
  file.excludedIds = file.entries
    .filter((entry) => entry.id !== retryId)
    .map((entry) => entry.id);
});
```

После retry восстановить или очистить batch UI, чтобы следующий запуск случайно не использовал старую retry-конфигурацию.

## 24. Типовые ошибки и диагностика

### CDP недоступен

Симптом:

```text
Unable to connect to the remote server
```

Проверить:

- отдельный `--user-data-dir`;
- Chrome полностью завершён перед запуском;
- порт `9222`;
- аргументы главного процесса;
- firewall или security software.

### Receiving end does not exist

Причины:

- content script не был внедрён;
- вкладка открыта до загрузки расширения;
- URL не совпадает с manifest matches;
- active tab является extension popup;
- content script упал при инициализации.

Решение:

- активировать target tab;
- перезагрузить страницу;
- проверить manifest;
- повторить message;
- посмотреть console errors target page.

### Storage output слишком большой

Не печатать полные тексты. Возвращать lengths, statuses, IDs и names.

### UI показывает одно, storage другое

Проверить:

- был ли dispatch `input/change`;
- успел ли async storage write завершиться;
- не перерисовал ли React control старым state;
- не работает ли открытый popup со старым in-memory state.

### Task завис в submitting

Проверить по порядку:

1. Видимые buttons, особенно `Proceed`.
2. History UI/API на предмет уже созданной задачи.
3. Content script logs.
4. Service worker state.
5. Timeout message call.

Не нажимать Proceed повторно до проверки History.

### Task завис в awaiting_match

Проверить:

- History hook установлен до открытия History;
- API response captured;
- baseline IDs;
- text normalization;
- voice name normalization;
- `submittedAt` и единицы времени;
- History pagination;
- одинаковые тексты и claimed IDs.

### Download остаётся downloading

Проверить:

- `chrome.downloads.search({ id })`;
- конфликт имени;
- reservation URL;
- redirect URL;
- разрешение downloads;
- наличие файла на диске.

## 25. Логи и наблюдаемость

Полезный log context:

- run ID;
- worker ID;
- local task ID;
- script name;
- entry ID;
- speaker;
- voice ID;
- language;
- state transition;
- elapsed time;
- `audio_id`;
- download ID;
- error reason.

Логировать переходы:

```text
queued -> submitting -> awaiting_match -> pending -> ready -> downloading -> completed
```

Не логировать:

- auth cookies;
- bearer tokens;
- полный Local State Chrome;
- Firebase/API keys как секреты пользователя;
- полный чувствительный текст без необходимости.

## 26. Проверки после изменения кода

Минимум:

```powershell
node --check background.js
node --check content_script.js
node --check popup.js
node --check parser.js
```

Затем:

1. Reload extension.
2. Reload target page.
3. Проверить content script message.
4. Проверить popup storage.
5. Выполнить бесплатный или минимальный smoke test.
6. Выполнить один реальный test entry.
7. Проверить History и точное имя файла.
8. Только затем запускать batch.

## 27. Backup strategy

Рекомендуемые checkpoints:

1. До реализации.
2. Перед первым live-тестом.
3. После успешного live-теста и финальных fixes.

Перед архивом:

- удалить временные debug scripts;
- не включать Chrome profile;
- не включать cookies, credentials и downloads;
- выполнить syntax checks;
- убедиться, что архив создаётся вне project folder.

```powershell
$destination = 'D:\backups\extension-live-verified.zip'
Compress-Archive `
    -Path '.\*' `
    -DestinationPath $destination `
    -CompressionLevel Optimal
```

## 28. Реальная последовательность действий этой сессии

1. Проверили проект и версию расширения.
2. Подтвердили структуру двух реальных VSL Markdown файлов.
3. Посчитали entries и длины текстов.
4. Определили 6 Long Text и 10 regular entries.
5. Попытались штатно закрыть Chrome.
6. Проверили, что процессы не завершились.
7. После разрешения принудительно завершили только Chrome.
8. Запустили Chrome с `--remote-debugging-port=9222`.
9. Обнаружили, что стандартный профиль не публикует CDP endpoint.
10. Создали отдельный test profile через `--user-data-dir`.
11. Загрузили unpacked extension через `--load-extension`.
12. Пользователь вошёл в MiniMax в test profile.
13. Проверили CDP version и targets.
14. Подтвердили авторизацию по доступному TTS UI и credits.
15. Открыли extension popup как отдельную вкладку.
16. Инспектировали controls popup через `Runtime.evaluate`.
17. Активировали MiniMax target перед `chrome.tabs.query({ active: true })`.
18. Получили ошибку content script connection.
19. Перезагрузили MiniMax вкладку для инъекции content script.
20. Прочитали My Voices через extension message.
21. Получили 7 голосов с префиксом `mp`.
22. Загрузили два Markdown файла через `DOM.setFileInputFiles`.
23. Проверили parsed entries, lengths и exclusions в storage.
24. Обнаружили неверный автоматический voice mapping.
25. Назначили явные voices для PA, MX и четырёх отзывов.
26. Назначили `Spanish` обоим файлам.
27. Проверили `16/16 included` и `missing voices = 0`.
28. Запустили один поток без experimental parallel mode.
29. Long Text был отправлен перед regular queue.
30. Обычная очередь скачала 10 файлов.
31. Пять Long Text задач завершились и скачались.
32. Одна PA entry завершилась локальной ошибкой `8801 vs 8799`.
33. Выяснили, что разница равна двум переносам строк.
34. Исправили подготовку текста перед Slate insert.
35. Выполнили syntax checks.
36. Дождались полного завершения текущей очереди.
37. Подготовили isolated retry только первой PA entry.
38. Перезагрузили extension и target page.
39. Повторили одну entry.
40. Обнаружили видимый Proceed через список visible buttons.
41. Ручной Proceed привёл к дополнительному History record, потому что автоматическое действие уже могло пройти.
42. Остановили дальнейшие повторы и перешли к History reconciliation.
43. Обнаружили, что History matcher использовал strict text equality.
44. Исправили matcher на whitespace-normalized comparison.
45. Перезагрузили extension и target page.
46. Получили History record с `audio_id` и готовым `audio_url`.
47. Alarm перевёл задачу в `downloading`, затем `completed`.
48. Проверили 8 MP3 в первой папке и 8 MP3 во второй.
49. Проверили отсутствие нулевых файлов.
50. Удалили временный CDP script.
51. Повторно выполнили syntax checks.
52. Создали live-verified backup.

## 29. Улучшения, которые стоит добавить в похожие расширения

1. Единая `normalizeComparableText()` для editor validation и History matching.
2. Сохранение `generateClickedAt` и `proceedClickedAt`.
3. Статус `confirmation_unknown`, который запрещает retry до History check.
4. Hash нормализованного текста для компактного storage и логов.
5. Явный preflight экран перед batch Start.
6. Проверка duplicate History records по text, voice и временному окну.
7. Кнопка `Retry failed only`, которая не требует ручной правки exclusions.
8. Кнопка `Reconcile now` для немедленного History polling.
9. Диагностический export без текстов и секретов.
10. Автоматическая проверка файлов после download completion.
11. UI warning, если popup открыт как tab и active target не MiniMax.
12. Unicode-safe role matching вместо `\b` для кириллицы.
13. Отдельные selectors adapters для каждой версии сайта.
14. Operation lock на уровне tab и task.
15. AbortController/timeouts для всех async UI операций.

## 30. Краткий аварийный чек-лист

Если автоматизация остановилась:

1. Не нажимать Generate или Proceed повторно.
2. Проверить `/json` и target page.
3. Проверить visible buttons и History.
4. Прочитать summary `longTextState`, `batchState`, `downloadHistory`.
5. Проверить content script connection.
6. Проверить API History capture.
7. Сопоставить normalized text, voice, time и baseline IDs.
8. Проверить downloads на диске.
9. Только после этого решать: wait, reconcile, retry или fix code.

## 31. Definition of Done для live batch

Batch считается завершённым, только если:

- все ожидаемые entries учтены;
- нет активных `queued/submitting/awaiting_match/pending/ready/downloading`;
- нет необъяснённых errors;
- количество downloads соответствует количеству entries;
- имена и индексы файлов корректны;
- файлы существуют и не пустые;
- syntax checks проходят;
- временные debug artifacts удалены;
- создан проверенный backup;
- известные дубли History задокументированы и не скачаны как ожидаемый output.
