# Логи и трасса решений turn-lock

Два журнала отвечают на два разных вопроса:

| Журнал | Вопрос | Путь |
|---|---|---|
| человеческий лог | «что плагин сказал» — одна читаемая строка на grant/release/wait | `%TEMP%/opencode/turn-lock.log` |
| трасса решений | «почему слот поехал и можно ли этому верить» — строка JSON на каждое решение | `%TEMP%/opencode/turn-lock-trace/lock-YYYY-MM-DD.jsonl` |

Для разбора надёжности нужна **трасса**: человеческий лог не говорит, дошло ли событие, знал ли инстанс, что держит лиз, и чем именно отпустил.

## Где что лежит

| Что | Путь | Хранение |
|---|---|---|
| трасса | `%TEMP%/opencode/turn-lock-trace/lock-YYYY-MM-DD.jsonl` | сутки (`traceKeepMs`), старые файлы удаляются при первой записи нового дня |
| человеческий лог | `%TEMP%/opencode/turn-lock.log` | обнуляется при размере > 2 МБ |
| лизаренсы | `%TEMP%/opencode/turn-lock/*.lease.json` | до отпускания, устаревания или смерти процесса |
| ожидание | `%TEMP%/opencode/turn-lock/*.wait.json` | до grant/cancel/устаревания |
| приоритет | `%TEMP%/opencode/turn-lock/*.prio.json` | `priorityTtlMs` (сутки) |

Каталоги **общие для всех инстансов**: на каждую локацию (каталог проекта) загружается свой экземпляр плагина, и все пишут в один файл трассы. Поэтому в каждой строке есть `pid` и `owner` — по ним строки раскладываются на инстансы. На типовой машине это ~9 инстансов, то есть каждое событие сервера даёт ~9 строк `event.recv`.

Объём: ~1–2 МБ на 10 минут при вялой активности (≈10 МБ/час, до 200–250 МБ за сутки). Основной вклад — `event.recv`/`event.ignore`; именно они доказывают доставку и невмешательство соседей, поэтому их не убирают.

## Формат строки

```json
{"t":"2026-11-06T23:15:34.751Z","ms":1794006934751,"pid":29156,"owner":"F:\\Development\\opencode-turn-lock","ev":"release","sid":"ses_e4d7f3...","reason":"session.step.ended","held":0,"since":1794006791600.4,"ageMs":143151}
```

- `t` — **UTC** ISO-строка (`Z`). Локальное время = `t` + смещение пояса (здесь +3 ч). Для арифметики брать `ms`.
- `ms` — epoch в миллисекундах, то же мгновение.
- `pid` — процесс сервера; `owner` — каталог локации, к которой относится инстанс.
- `ev` — тип события (таблица ниже), дальше — поля этого события.
- `sid` — id сессии OpenCode (`ses_...`).
- День файла считается по **локальному** календарю.

Поля оболочки (`t`, `ms`, `pid`, `owner`, `ev`) пишутся последними и не могут быть перекрыты полем события — в частности, длительность handoff лежит в `delayMs`, а не в `ms`.

`since` у лизы — не целое: к нему добавлен случайный дробный сдвиг, чтобы две лизы, взятые в одну миллисекунду, имели детерминированный порядок. `ageMs` = `Date.now() - since`, округлённый.

## События трассы

### Жизнь инстанса и потока событий

| `ev` | Поля | Смысл |
|---|---|---|
| `boot` | `scope`, `limit`, `handoffMs`, `leaseTimeoutMs`, `pollMs`, `refreshEveryMs`, `sweepMs`, `timeoutMs`, `onTimeout`, `localProviders`, `dir`, `logFile`, `traceFile`, `pruned`, `prunedSids`, `tickets`, `restored`, `orphans`, `source`, `node` | инстанс поднялся; здесь же эффективный конфиг и уборка на старте |
| `shutdown` | `held`, `waiting`, `handoffs`, `events` | инстанс выгружается: что он считал своим |
| `stream.open` | `types` | подписка на события открылась |
| `stream.closed` | `events`, `livedMs`, `lastEventAgoMs`, `aborted`, `how`, `error` | подписка закрылась. `how: "ended"` — итератор завершился (в том числе по `abort` при выгрузке), `how: "threw"` — исключение. `aborted: false` — поток встал сам |

### Доставка событий

| `ev` | Поля | Смысл |
|---|---|---|
| `event.recv` | `type`, `sid`, `finish`, `status`, `held`, `handoff`, `waiting`, `n` | событие получено; `held`/`handoff`/`waiting` — что инстанс про эту сессию думал в этот момент |
| `event.ignore` | `type`, `sid`, `why` | событие сознательно пропущено, причина в `why` |
| `event.drop` | `type`, `why` | событие выброшено до обработки (нет `sid`; `session.status` не `idle`) |
| `event.model` | `type`, `sid`, `providerID`, `local` | определён провайдер сессии (local/cloud) |

Основные `why` у `event.ignore`: `step of a lease this instance does not hold` (соседний инстанс не трогает чужой лиз), `no handoff armed` (инструмент без взведённого handoff), `turn scope`, `releaseOnForm=false`, `releaseOnPermission=false`.

### Гейт (`context`)

| `ev` | Поля | Смысл |
|---|---|---|
| `context.enter` | `sid`, `providerID`, `scope` | запрос дошёл до гейта |
| `context.cloud` | `sid`, `providerID` | облачный провайдер — не гейтится |
| `context.continue` | `sid`, `handoff` | продолжение шага на уже взятом лизе (`refresh`, без release/acquire) |
| `context.reacquire` | `sid`, `why` | шаг держал лиз, но нового события шага не было — лиз отпущен и взят заново |
| `context.covered` | `sid`, `root` | сабагент едет на лизе родителя |
| `context.subagent` | `sid`, `kind`, `root` | `turn`-режим: сабагент покрыт родителем или освобождён |
| `yield` | `sid`, `ahead[]`, `level` | мягкая уступка слота ждущему более высокого уровня |
| `priority` | `sid`, `level`, `waitedMs` | смена уровня `/prio` |

### Очередь

| `ev` | Поля | Смысл |
|---|---|---|
| `acquire.start` | `sid`, `level`, `waiting` | попытка взять слот |
| `acquire.result` | `sid`, `granted`, `waitedMs`, `overLimit`, `reason` | итог попытки |
| `lease.taken` | `sid`, `since`, `level` | лиз взят; `since` — начало удержания |
| `wait` | `sid`, `held`, `limit`, `waitedMs`, `blocked` | тик ожидания; `blocked`: `ahead` (впереди очередь) или `null` (все слоты заняты) |
| `grant` | `sid`, `waited`, `waitedMs`, `overLimit`, `held`, `limit` | слот выдан |
| `timeout` | `sid`, `waitedMs`, `onTimeout` | истёк `acquireTimeoutMs` |
| `cancel` | `sid`, `reason` | ожидание отменено (конец прогона, удаление сессии) |

`rank` в трассе: `low=0`, `normal=1`, `high=2`.

### Граница шага и отпускание

| `ev` | Поля | Смысл |
|---|---|---|
| `step.handoff` | `type`, `sid`, `finish`, `handoffMs` | шаг закончился с `tool-calls`/`length` — лиз держится через границу |
| `handoff.arm` | `sid`, `kind`, `delayMs`, `replaced` | взведён таймер страховки (`kind`: `tool`/`continue`) |
| `handoff.fire` | `sid`, `kind`, `delayMs` | таймер сработал раньше реального события |
| `tool.release` | `sid`, `kind`, `gapMs` | инструмент стартовал и отпустил лиз; `gapMs` — длина зазора |
| `step.release` | `type`, `sid`, `finish` | шаг отпустил лиз сразу (`stop`, `error`, пустой `finish`) |
| `terminal` | `type`, `sid`, `held`, `handoff` | терминальное событие прогона |
| `release` | `sid`, `reason`, `held`, `since`, `ageMs` | лиз отпущен: причина и сколько держали |
| `stale` | `sid`, `ageMs` | лиз выброшен как просроченный (нет `refresh` дольше `leaseTimeoutMs`) |

### Фон

| `ev` | Поля | Смысл |
|---|---|---|
| `heartbeat` | `held[]`, `handoffs[]`, `waiting[]` | тик `refreshEveryMs` |
| `refresh` | `sid`, `source` | обновлён `seen` лизы |
| `sweep` | `leases` | тик уборки |
| `snapshot` | `leases[]`, `queue[]`, `held[]`, `handoffs[]`, `waiting[]`, `events`, `lastEventAgoMs` | раз в `traceEveryMs` — срез состояния |

Элемент `snapshot.leases`: `sid`, `since`, `seen`, `ageMs`, `staleMs` (сколько прошло с последнего refresh), `over`, `pid`, `owner`.
Элемент `snapshot.queue`: `sid`, `rank`, `position` (1 — первый), `age` (ключ сортировки: `createdAt` сессии или начало ожидания).

`snapshot` — становой хребет разбора: даже если все событийные строки потерялись, минутный срез показывает, кто держал слот и кто ждал.

## Живое состояние (sidecar-файлы)

Это не история, а текущий момент — полезно, когда смотришь на систему «сейчас».

```jsonc
// <sid>.lease.json
{ "sid": "ses_...", "since": 1794007054528.58, "seen": 1794007211403,
  "pid": 29156, "owner": "F:\\Development\\wt-save-slots", "over": true }

// <sid>.wait.json  — ожидание; набор файлов и есть очередь
{ "sid": "ses_...", "pid": 29156, "owner": "F:\\Development\\dos2-planner",
  "since": 1794006795911, "createdAt": 1794004143028, "markedAt": 1794007156485 }

// <sid>.prio.json  — только у ⚡/▽
{ "sid": "ses_...", "pid": 29156, "owner": "...", "since": 1794006795911, "level": "high" }
```

- `seen` — последний refresh; `leaseTimeoutMs` без обновления → `stale`.
- `markedAt` — последний тик ожидания; три подряд пропущенных тика → файл считается брошенным.
- `createdAt` — абсолютное время создания сессии, ключ сортировки очереди (переживает перезапуск инстанса).

## Как разбирать

### Одной командой

```powershell
python tools\trace-report.py                      # сегодняшний файл
python tools\trace-report.py <файл.jsonl>         # конкретный день
```

Скрипт печатает сводку по разделам: покрытие и инстансы, поток событий, лизы и время удержания, границы шагов, очередь, гейт и список аномалий. Он ничего не меняет и не требует зависимостей.

### Руками (PowerShell, без jq)

```powershell
$f = "$env:TEMP\opencode\turn-lock-trace\lock-$(Get-Date -Format yyyy-MM-dd).jsonl"
$all = Get-Content $f | ForEach-Object { $_ | ConvertFrom-Json }   # ~5 тыс. строк; на суточном файле медленно

# кто держал слот и сколько
$all | Where-Object ev -eq 'release' |
  Select-Object @{n='time';e={([DateTimeOffset]::FromUnixTimeMilliseconds([long]$_.ms)).ToLocalTime().ToString('HH:mm:ss')}}, sid, reason, ageMs

# границы шагов
$all | Where-Object { $_.ev -in @('step.handoff','handoff.arm','handoff.fire','tool.release','step.release') } |
  Select-Object @{n='time';e={([DateTimeOffset]::FromUnixTimeMilliseconds([long]$_.ms)).ToLocalTime().ToString('HH:mm:ss')}}, ev, sid, finish, kind, gapMs

# поток событий жив?
$all | Where-Object { $_.ev -in @('stream.open','stream.closed') } |
  Select-Object pid, owner, ev, events, livedMs, lastEventAgoMs, aborted, error

# минутные срезы
$all | Where-Object ev -eq 'snapshot' | Select-Object -Last 3 |
  ForEach-Object { $_.leases | Select-Object sid, ageMs, staleMs, over, pid }
```

Для суточного файла (~800 тыс. строк) PowerShell-парсинг занимает минуты — берите `trace-report.py` или фильтруйте строки до `ConvertFrom-Json`:

```powershell
Select-String -Path $f -Pattern '"ev":"release"' | ForEach-Object { $_.Line | ConvertFrom-Json }
```

### jq (если установлен)

```bash
jq -r 'select(.ev=="release") | [.t,.sid,.reason,.ageMs] | @tsv' lock-*.jsonl
jq -r 'select(.ev=="step.handoff" or .ev=="tool.release" or .ev=="handoff.fire") | [.t,.sid,.ev,(.finish//.kind)] | @tsv' lock-*.jsonl
jq -c 'select(.ev=="stream.open" or .ev=="stream.closed")' lock-*.jsonl
jq -c 'select(.ev=="snapshot")' lock-*.jsonl | tail -5
```

## Чек-лист надёжности

Восемь вопросов, которые вместе дают однозначный ответ «механизм держит» / «механизм течёт». Норма — то, что должно быть; аномалия — то, что надо объяснить, прежде чем говорить «работает».

| № | Вопрос | Где смотреть | Норма | Аномалия |
|---|---|---|---|---|
| 1 | Поток событий был жив? | `stream.open`/`stream.closed`, `snapshot.lastEventAgoMs` | на каждый `pid` один `open` и один `closed` с `aborted:true` (перезапуск); `lastEventAgoMs` — секунды | `closed` с `aborted:false`; `open` без `closed` у живого pid; минуты без `event.recv` при активных сессиях |
| 2 | Лиз отпускал владелец? | `event.recv.held`, `event.ignore.why` | на событие ровно один инстанс с `held:true`, остальные — `does not hold` | два инстанса с `held:true` на одну сессию → двойной release |
| 3 | Каждому взятию — свой release? | `lease.taken` vs `release` + `stale` + `shutdown.held` | каждое `lease.taken` закрыто `release`; незакрытых на конец нет | `taken` без `release`/`stale` → слот утёк до `leaseTimeoutMs` |
| 4 | Не держали лишнего? | `release.ageMs`, `snapshot.staleMs` | возраст ≈ длительность запроса/шага; `staleMs` — десятки секунд | `ageMs` ≈ `leaseTimeoutMs`, `staleMs` растёт до минуты и больше |
| 5 | Таймер не подменял событие? | `handoff.fire`, `release.reason` = `no tool started`/`no continuation` | единицы за сутки (шаг без продолжения) | часто → события не доходят, `handoffMs` маскирует потерю |
| 6 | Лимит не превышался? | `acquire.result.overLimit`, `grant.overLimit`, `timeout`, `snapshot.leases` | длина `leases` ≤ `limit`; `overLimit` только после `timeout` | два обычных лиза при `limit:1`, `overLimit` без `timeout` |
| 7 | Порядок очереди соблюдался? | `snapshot.queue` (`position`, `rank`, `age`), `grant.waitedMs`, `wait.blocked` | слот получает `position:1` своего уровня; `waitedMs` растёт монотонно | выдан не первый, хотя первый жив и не `over` |
| 8 | Шаги не терялись? | `context.reacquire` | 0–единицы | регулярно → `step.ended` не доходит, лиз держится до таймера |

Плюс два прямых индикатора утечки, которые видно без вычислений:

- **`release.reason` = `unload`** — лиз отпущен только потому, что инстанс выгружался. Если такое часто и не связано с перезапусками — лизы не закрываются событиями.
- **`release.reason` = `stale`/`stale`-события** — лиз пережил своего владельца: либо инстанс умер, либо перестал обновлять `seen`.

## Особенности текущей версии

- **`session.tool.called` приходит раньше `session.step.ended`** (замер 07.11.2026: +323 мс). Поэтому `tool.release` почти всегда 0, а `handoffMs` фактически закрывает только зазор `step.ended → следующий context`. Лиз при этом держится весь шаг, включая выполнение инструмента, и освобождается на `stop`. Это не ошибка, но при разборе не надо считать `tool.release: 0` поломкой.
- **Каждое событие видно во всех инстансах.** `event.recv` дублируется по числу локаций; `held:true` должен быть ровно у одного. Это главный тест на «сосед не трогает чужой лиз».
- **`snapshot` пишется каждым инстансом**, поэтому в одном срезе `leases` повторяются — это одна и та же картина с разных процессов, а не разные лизы.
- **`t` в UTC.** Не путать с локальным временем в человеческом логе (`turn-lock.log` тоже UTC, `toISOString`).

## Если меняется код

Точки записи живут в `src/index.ts` (`const t = (event, fields) => trace.write(...)`) и `src/core.ts` (события `release` с `since`). Модуль — `src/trace.ts`. При добавлении события обновлять таблицы выше; при изменении полей — пример строки и чек-лист. Тесты формата: `tests/trace.test.ts`, e2e — `tests/plugin.test.ts` (поиск по `traceLines`).
