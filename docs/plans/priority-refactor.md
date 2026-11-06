# Рефакторинг кода приоритизации сессий

> **For agentic workers:** выполняй план по задачам, отмечая шаги `- [x]`. Метод исполнения задан AGENTS.md: Native, в основной сессии, без субагентов.

**Цель:** вынести приоритизацию очереди из 1830-строчного `src/index.ts` в три узких модуля с одним источником правды для ранга, порядка и меток — без изменения поведения.

**Архитектура:** `priority.ts` — чистый словарь уровней, ранги, цикл переключения, парсер команды и компаратор очереди; `title.ts` — грамматика заголовка (облако, уровень, ожидание) как единственный канал состояния; `priority-store.ts` — файловый сайдкар `<sid>.prio.json` с TTL и наследованием уровня корня. `index.ts` остаётся оркестратором: конфиг, хук, события, fs-стор, вызовы новых модулей и ре-экспорт публичного API.

**Стек:** TypeScript, `node --test` (type stripping), Solid для GUI, vite для бандла.

**Spec:** `docs/plans/priority-low.md` (три уровня), README §«Приоритет (`/prio`)» и §«Разработка».

## Глобальные ограничения

- Поведение не меняется: все 99 существующих тестов обязаны пройти без правок.
- Публичные имена (`parsePriorityArgument`, `PRIORITY_RANK`, `withLevelMark`, `withWaitPrefix`, `PRIORITY_MARK`, …) остаются доступны из `src/index.ts` — тесты и внешние потребители импортируют их оттуда.
- Новые модули не тянут `@opencode/plugin`; `priority.ts` и `title.ts` — без `node:fs` (тестируются type stripping).
- Рабочее дерево уже содержит чужие незакоммиченные правки (cloud-флаг при `session.created`, `holding` в state) — их не откатывать и не смешивать с рефакторингом.
- `npm run check && npm test && npm run build` — финальный гейт.

## Review Focus

- Сессия с флагом `high`, но без `since` в файле: читается как протухшая и не должна блокировать очередь (`read` → undefined).
- Файл без поля `level` (версия 0.1): обязан читаться как `high`, а `level:"normal"` — как отсутствие флага.
- Два ждущих одного уровня с одинаковым `age`: порядок обязан быть детерминированным по `sid`, иначе `holdsBack` и `orderedWaiters` разойдутся.
- `priorityEnabled: false`: `holdBack` в request-режиме остаётся включённым, но уровни инертны (`read` → undefined), FIFO по билету сохраняется.
- Сабагент: уровень берётся у корня, а не из собственного файла; кэш корня должен быть прогрет до `flagOf`.

---

### Задача 1: `src/priority.ts` — уровни, ранг, компаратор

**Файлы:**
- Создать: `src/priority.ts`
- Тест: `tests/priority.test.ts`

**Интерфейсы (производит):**
```ts
export type PriorityLevel = "low" | "normal" | "high"
export const LEVELS: readonly PriorityLevel[]
export const PRIORITY_RANK: Record<PriorityLevel, number>   // low 0, normal 1, high 2
export const LEVEL_RANK: Record<PriorityLevel, number>      // high 0, normal 1, low 2 (инбокс)
export const PRIORITY_MARK: string  // "⚡"
export const LOW_MARK: string       // "▽"
export function markFor(level: PriorityLevel): string
export function isLevel(value: unknown): value is PriorityLevel
export const LEVEL_CYCLE: Record<PriorityLevel, PriorityLevel> // normal→high→low→normal
export function nextLevel(level: PriorityLevel): PriorityLevel
export function toggleLevel(level: PriorityLevel): PriorityLevel // high→normal, иначе high
export function parsePriorityArgument(text: string, command: string): PriorityLevel | "toggle"
export type QueueEntry = { sid: string; rank: number; age: number }
export function levelEntry(sid: string, level: PriorityLevel, age: number): QueueEntry
export function compareQueue(left: QueueEntry, right: QueueEntry): number
export function outranking(entries: readonly QueueEntry[], sid: string, rank: number): QueueEntry[]
export function aheadInLevel(entries: readonly QueueEntry[], self: QueueEntry): QueueEntry[]
```

- [x] Тест: ранг/LEVEL_RANK — обратные друг другу; `nextLevel`/`toggleLevel`; `parsePriorityArgument` (перенос 16 кейсов из plugin.test.ts); `compareQueue` (ранг → возраст → sid); `outranking` исключает себя и равных; `aheadInLevel` — только свой уровень и строго впереди.
- [x] Прогнать тест: падает (`Cannot find module ../src/priority.ts`).
- [x] Реализовать модуль; `parsePriorityArgument` перенести дословно из `index.ts:557-571`, ранги вывести из `LEVELS`, чтобы карты не расходились.
- [x] Прогнать: зелёный.

### Задача 2: `src/title.ts` — грамматика заголовка

**Файлы:**
- Создать: `src/title.ts`
- Изменить: `src/state.ts` (использовать общие префиксы вместо своих копий)
- Тест: существующие `tests/plugin.test.ts` (метки) + `tests/state.test.ts` (фолбэк из заголовка)

**Интерфейсы (производит):** `CLOUD_MARK`, `hasCloudMark`, `withoutCloudMark`, `withCloudMark`, `levelOfTitle`, `withoutLevelMark`, `withLevelMark`, `withPriorityMark`, `withoutPriorityMark`, `hasPriorityMark`, `withLowMark`, `withoutLowMark`, `hasLowMark`, `WAITING_MARK`, `WAIT_PREFIX` (с группами `position`/`total`), `QueuePlace`, `formatWait`, `stripWaitPrefix`, `withWaitPrefix`.

- [x] Перенести из `index.ts:382-547` без изменения тел.
- [x] В `state.ts` заменить локальные `CLOUD_PREFIX`/`PRIORITY_PREFIX`/`LOW_PREFIX`/`WAIT_PREFIX` на импорт из `title.ts`; `stateFromTitle` сохраняет прежний результат.
- [x] Прогнать `tests/state.test.ts` и `tests/plugin.test.ts`: зелёные (поведение то же).

### Задача 3: `src/priority-store.ts` — сайдкар флага

**Файлы:**
- Создать: `src/priority-store.ts`
- Тест: `tests/priority-store.test.ts`

**Интерфейсы (производит):**
```ts
export type PriorityFlag = { level: "high" | "low"; since: number }
export type PriorityFlagsOptions = {
  dir: string; ttlMs: number; enabled: boolean; owner: string
  now?: () => number; pid?: number; rootOf?: (sid: string) => string | undefined
}
export type PriorityFlags = {
  path(sid: string): string
  read(sid: string): PriorityFlag | undefined
  write(sid: string, level: PriorityLevel): void
  drop(sid: string): void
  flagOf(sid: string): PriorityFlag | undefined
  levelOf(sid: string): PriorityLevel
  rankOf(sid: string): number
}
export function createPriorityFlags(options: PriorityFlagsOptions): PriorityFlags
```

- [x] Тесты: round-trip `write`/`read`; `normal` удаляет файл; файл без `level` → `high`; `level:"normal"` → нет флага и файл удалён; `since` старше TTL → нет флага и файл удалён; `enabled:false` → нет флага; `rootOf` подставляет корень, собственный флаг сабагента игнорируется; `rankOf` = `PRIORITY_RANK`.
- [x] Прогнать: падает (модуля нет).
- [x] Реализовать; путь — `join(dir, `${sid.replace(/[^A-Za-z0-9_.-]/g, "_")}.prio.json`)`; запись `{sid, pid, owner, since, level}`; все ошибки fs глотаются (best-effort).
- [x] Прогнать: зелёный.

### Задача 4: `src/index.ts` — один `entryOf`, один компаратор

**Файлы:**
- Изменить: `src/index.ts` (удалить перенесённое, подключить модули, ре-экспорт)

- [x] `export * from "./priority.ts"` и `export * from "./title.ts"` вместо локальных объявлений.
- [x] `createPriorityFlags({ dir, ttlMs: config.priorityTtlMs, enabled: config.priorityEnabled, owner, rootOf: (sid) => roots.get(sid) })`; `readPriority`/`writePriority`/`dropPriority`/`flagOf`/`levelOf`/`rankOf` — делегировать.
- [x] Ввести `entryOf(sid, waited)`: единственное место правила «флаг → `since`, иначе билет → время ожидания». Через него построить `rankedWaiters`, `waitingAbove`, `holdsBack` (ранг и возраст), `orderedWaiters` (сортировка `compareQueue`).
- [x] `applyLevel`, команда `/prio` — через `toggleLevel`/`parsePriorityArgument`.
- [x] Прогнать `tests/plugin.test.ts`: 100% зелёные, включая yield, места, request scope.

### Задача 5: клиентские модули

**Файлы:**
- Изменить: `src/gui.tsx`, `src/inbox.ts`, `src/state.ts`

- [x] `gui.tsx`: локальные `CYCLE`/`MARKS`/`Level` → `LEVEL_CYCLE`/`PriorityLevel` из `priority.ts`; мёртвый `MARKS` удалить.
- [x] `inbox.ts`: `InboxLevel` = `PriorityLevel`; `inboxLevel` через `levelOfTitle`.
- [x] `state.ts`: `LEVELS`/`LEVEL_RANK` из `priority.ts`; тип `PriorityLevel` больше не импортируется из `index.ts`.
- [x] Прогнать `tests/inbox.test.ts`, `tests/state.test.ts`, `npm run check`.

### Задача 6: документация и финальный гейт

- [x] README §«Разработка»: добавить `priority.ts`, `title.ts`, `priority-store.ts`, `tests/priority.test.ts`, `tests/priority-store.test.ts`; обновить число тестов.
- [x] `npm run check && npm test && npm run build`; `git diff --stat` как доказательство.

## Критерий готовности

- `npm run check` без ошибок, `npm test` — все тесты (99 старых + новые) зелёные, `npm run build` собирает бандл.
- В `src/index.ts` не остаётся ни одной копии правила «ранг уровня / возраст ожидания»: только `entryOf` и вызовы `priority.ts`.
- `src/state.ts` больше не импортирует тип из `src/index.ts` (цикл «состояние → плагин» разорван).
- Публичный API `src/index.ts` сохранён ре-экспортом.
