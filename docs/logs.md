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

Каталоги **общие для всех инстансов**: на каждую локацию (каталог проекта) загружается свой экземпляр плагина, и все пишут в один файл трассы. Поэтому в каждой строке есть `pid` и `owner` — по ним строки раскладываются на инстансы. На типовой машине это около десяти инстансов, то есть каждое событие сервера даёт столько же строк `event.recv`.

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

Поля оболочки (`t`, `ms`, `pid`, `owner`, `ev`) пишутся последними и не могут быть перекрыты полем события — поэтому длительности в событиях лежат в собственных полях (`delayMs`, `gapMs`, `ageMs`), а не в `ms`.

`since` у лизы — не целое: к нему добавлен случайный дробный сдвиг, чтобы две лизы, взятые в одну миллисекунду, имели детерминированный порядок. `ageMs` = `Date.now() - since`, округлённый.

## События трассы

### Жизнь инстанса и потока событий

| `ev` | Поля | Смысл |
|---|---|---|
| `boot` | `scope`, `limit`, `returnTicketTtlMs`, `warmHandoffMs`, `leaseTimeoutMs`, `pollMs`, `refreshEveryMs`, `sweepMs`, `timeoutMs`, `onTimeout`, `localProviders`, `dir`, `logFile`, `traceFile`, `pruned`, `prunedSids`, `tickets`, `restored`, `orphans`, `source`, `node` | инстанс поднялся; здесь же эффективный конфиг и уборка на старте |
| `shutdown` | `held`, `waiting`, `events` | инстанс выгружается: что он считал своим |
| `stream.open` | `types` | подписка на события открылась |
| `stream.closed` | `events`, `livedMs`, `lastEventAgoMs`, `aborted`, `how`, `error` | подписка закрылась. `how: "ended"` — итератор завершился (в том числе по `abort` при выгрузке), `how: "threw"` — исключение. `aborted: false` — поток встал сам |

### Доставка событий

| `ev` | Поля | Смысл |
|---|---|---|
| `event.recv` | `type`, `sid`, `finish`, `status`, `held`, `waiting`, `n` | событие получено; `held`/`waiting` — что инстанс про эту сессию думал в этот момент |
| `event.ignore` | `type`, `sid`, `why` | событие сознательно пропущено, причина в `why` |
| `event.drop` | `type`, `why` | событие выброшено до обработки (нет `sid`; `session.status` не `idle`) |
| `event.model` | `type`, `sid`, `providerID`, `local` | определён провайдер сессии (local/cloud) |

Основные `why` у `event.ignore`: `step of a lease this instance does not hold` (соседний инстанс не трогает чужой лиз), `turn scope`, `releaseOnForm=false`, `releaseOnPermission=false`.

### Гейт (`context`)

| `ev` | Поля | Смысл |
|---|---|---|
| `context.enter` | `sid`, `providerID`, `scope` | запрос дошёл до гейта |
| `context.cloud` | `sid`, `providerID` | облачный провайдер — не гейтится |
| `context.reacquire` | `sid`, `why` | шаг держал лиз, но нового события шага не было — лиз отпущен, тикет возврата записан, слот берётся заново |
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

### Тёплое окно, отпускание и возврат

| `ev` | Поля | Смысл |
|---|---|---|
| `step.warm-hold` | `sid`, `ms`, `tool` | первый инструмент шага открыл тёплое окно: лиз не отпущен, движок держит промпт |
| `step.warm-keep` | `type`, `sid`, `finish` | `step.ended` с `tool-calls`/`length` пришёл внутри окна — лиз и окно сохранены |
| `step.warm-resume` | `sid`, `heldMs`, `level` | продолжение пришло в окно: лиз остался за сессией, запрос ушёл без очереди |
| `step.release` | `type`, `sid`, `finish`, `returning` | шаг отпустил лиз; `returning: true` у `tool-calls`/`length` — прогон продолжится, сессии положен тикет возврата |
| `ticket.write` | `sid`, `why` | записан тикет возврата (`why`: `step-boundary`, `warm handoff expired` или тип паузы `form.*`/`permission.*`) |
| `terminal` | `type`, `sid`, `held` | терминальное событие прогона |
| `release` | `sid`, `reason`, `held`, `since`, `ageMs` | лиз отпущен: причина и сколько держали. `reason`: `tool started` (окно выключено), `warm handoff expired` (окно истекло), `step-boundary` (конец запроса) |
| `stale` | `sid`, `ageMs` | лиз выброшен как просроченный (нет `refresh` дольше `leaseTimeoutMs`) |

### Фон

| `ev` | Поля | Смысл |
|---|---|---|
| `heartbeat` | `held[]`, `waiting[]` | тик `refreshEveryMs` |
| `refresh` | `sid`, `source` | обновлён `seen` лизы |
| `sweep` | `leases` | тик уборки |
| `snapshot` | `leases[]`, `queue[]`, `held[]`, `warm[]`, `waiting[]`, `events`, `lastEventAgoMs` | раз в `traceEveryMs` — срез состояния; `warm` — сессии в тёплом окне |

Элемент `snapshot.leases`: `sid`, `since`, `seen`, `ageMs`, `staleMs` (сколько прошло с последнего refresh), `over`, `pid`, `owner`.
Элемент `snapshot.queue`: `sid`, `rank`, `position` (1 — первый **в порядке обслуживания**, а не по времени ожидания), `age` (ключ сортировки: `createdAt` сессии или начало ожидания), `boost` (время отпускания, если тикет возврата уже «поднят» передачей слота; иначе `null`), `defer` (`true` — сессия ждёт, пока её тикет не поднимут).

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

// <sid>.turn.json — тикет возврата; у сабагента лежит под именем родителя
{ "sid": "ses_...", "pid": 29156, "owner": "...", "releasedAt": 1794006795911,
  "expiresAt": 1794007095911, "releasedGrants": 42 }

// slot-free.json — когда слот освободился и сколько выдач уже было
{ "at": 1794006795900, "grants": 43 }
```

- `seen` — последний refresh; `leaseTimeoutMs` без обновления → `stale`.
- `markedAt` — последний тик ожидания; три подряд пропущенных тика → файл считается брошенным.
- `createdAt` — абсолютное время создания сессии, ключ сортировки очереди (переживает перезапуск инстанса).
- `expiresAt` — тикет возврата живёт `returnTicketTtlMs` (5 мин по умолчанию); `releasedGrants` — значение общего счётчика `grants` в момент отпускания. Пока `grants` не вырос, вернувшаяся сессия `defer` (не отбирает слот у очереди); как только вырос — `boost` (первая в своём уровне). `defer` держится только за тем, кто действительно может взять слот раньше; ждущие худшего уровня не считаются — они и так уступают по уровню, а не по тикету.

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

# границы шагов и возвраты
$all | Where-Object { $_.ev -in @('step.release','ticket.write','release') } |
  Select-Object @{n='time';e={([DateTimeOffset]::FromUnixTimeMilliseconds([long]$_.ms)).ToLocalTime().ToString('HH:mm:ss')}}, ev, sid, finish, returning, why, reason, ageMs

# поток событий жив?
$all | Where-Object { $_.ev -in @('stream.open','stream.closed') } |
  Select-Object pid, owner, ev, events, livedMs, lastEventAgoMs, aborted, error

# минутные срезы
$all | Where-Object ev -eq 'snapshot' | Select-Object -Last 3 |
  ForEach-Object { $_.leases | Select-Object sid, ageMs, staleMs, over, pid }
```

Для суточного файла (~800 тыс. строк) PowerShell-парсинг может занимать минуты — берите `trace-report.py` или фильтруйте строки до `ConvertFrom-Json`:

```powershell
Select-String -Path $f -Pattern '"ev":"release"' | ForEach-Object { $_.Line | ConvertFrom-Json }
```

### jq (если установлен)

```bash
jq -r 'select(.ev=="release") | [.t,.sid,.reason,.ageMs] | @tsv' lock-*.jsonl
jq -r 'select(.ev=="step.release" or .ev=="ticket.write") | [.t,.sid,.ev,(.finish//.why),.returning] | @tsv' lock-*.jsonl
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
| 4 | Не держали лишнего? | `release.ageMs`, `snapshot.staleMs`, `snapshot.warm` | `ageMs` ≈ длительность одного запроса к модели (секунды–десятки секунд) плюс окно `warmHandoffMs`; `staleMs` — десятки секунд | `ageMs` в десятки минут → лиз держится через инструменты, `release.reason` не `tool started`/`warm handoff expired`/`step-boundary` |
| 5 | Возврат не превратился в вечное удержание? | `ticket.write`, `step.release.returning`, `snapshot.queue.boost/defer` | `ticket.write` на каждый `tool-calls`/`length`; `defer` снимается первой же выдачей слота или сразу, если впереди только сессии более низкого уровня | тикетов больше, чем `step.release`, или `defer` держится минутами при живой очереди |
| 6 | Лимит не превышался? | `acquire.result.overLimit`, `grant.overLimit`, `timeout`, `snapshot.leases` | длина `leases` ≤ `limit`; `overLimit` только после `timeout` | два обычных лиза при `limit:1`, `overLimit` без `timeout` |
| 7 | Порядок очереди соблюдался? | `snapshot.queue` (`position`, `rank`, `age`), `grant.waitedMs`, `wait.blocked` | слот получает `position:1` своего уровня; `waitedMs` растёт монотонно | выдан не первый, хотя первый жив и не `over` |
| 8 | Шаги не терялись? | `context.reacquire`, `step.warm-resume`, `event.ignore.why` | `context.reacquire` — 0–единицы; `step.warm-resume` на каждое окно, в которое продолжение успело | регулярно → `step.ended` не доходит, лиз держится до таймера; `step ended after its continuation had already started` чаще единиц — порядок событий изменился |

Плюс два прямых индикатора утечки, которые видно без вычислений:

- **`release.reason` = `unload`** — лиз отпущен только потому, что инстанс выгружался. Если такое часто и не связано с перезапусками — лизы не закрываются событиями.
- **`release.reason` = `stale`/`stale`-события** — лиз пережил своего владельца: либо инстанс умер, либо перестал обновлять `seen`.

## Особенности текущей версии

- **Слот отпускается на первом `session.tool.called`, но только через `warmHandoffMs` (12 с).** `tool.called` приходит раньше `step.ended` (замер 07.11.2026: медиана −0.32 с, 90% пар) и совпадает с моментом, когда ответ модели уже отдан, — движок свободен, пока идёт инструмент. Немедленное отпускание выбивало прогретый промпт: продолжение возвращалось через 41 с ожидания и читало 150–210k токенов заново (09.11.2026: 185 таких префиллов, 2,4 ч). Поэтому лиз держится окно `warmHandoffMs`: `step.warm-hold` на старте, `step.warm-keep` на продолжающемся `step.ended`, `step.warm-resume` при возврате в окно; истекло — `release.reason` = `warm handoff expired` и тикет возврата. `warmHandoffMs: 0` возвращает прежнее поведение (`release.reason` = `tool started`). `handoffMs` читается как старое имя ключа.
- **Возврат держится на тикете, а не на времени создания.** `tool-calls`/`length` пишут `<sid>.turn.json`; пока общий счётчик `grants` не вырос, сессия `defer` и не отбирает слот у очереди, после первой выдачи — `boost` и первая в своём уровне. `defer` считается только за тем, кто может взять слот раньше (`compareQueue`): ждущие худшего уровня голову не задерживают, иначе высокий возврат и хвост обычных стояли бы до истечения тикета при свободном слоте (дедлок 08.11.2026, ~5 мин на цикл). Тикет живёт `returnTicketTtlMs` (5 мин) и удаляется при взятии слота. У сабагента тикет лежит под именем родителя (`rootOf`), поэтому родитель и ребёнок не встают друг за другом.
- **`snapshot.queue.position` — реальный порядок обслуживания** (`compareQueue`), а не порядок по времени ожидания; `boost`/`defer` в срезе показывают, как сработал тикет.
- **Каждое событие видно во всех инстансах.** `event.recv` дублируется по числу локаций; `held:true` должен быть ровно у одного. Это главный тест на «сосед не трогает чужой лиз».
- **`snapshot` пишется каждым инстансом**, поэтому в одном срезе `leases` повторяются — это одна и та же картина с разных процессов, а не разные лизы.
- **`t` в UTC.** Не путать с локальным временем в человеческом логе (`turn-lock.log` тоже UTC, `toISOString`).

## Если меняется код

Точки записи живут в `src/index.ts` (`const t = (event, fields) => trace.write(...)`) и `src/core.ts` (события `release` с `since`). Модуль — `src/trace.ts`. При добавлении события обновлять таблицы выше; при изменении полей — пример строки и чек-лист. Тесты формата: `tests/trace.test.ts`, e2e — `tests/plugin.test.ts` (поиск по `traceLines`).
