# Явный статус «в очереди» в сессии

> **For agentic workers:** метод исполнения задан AGENTS.md: Native, в основной сессии, без субагентов. Шаги отмечать `- [x]`.

**Цель:** сессия, чей запрос ещё не ушёл в локальный движок, показывает «⏳ В очереди · 2/5 · 9 мин» вместо хостового «Работает», а сессия, получившая слот, — «▶ Отправлено в движок».

**Архитектура:** сервер пишет явную фазу в `session.metadata["turn-lock"]` (`phase: "queued" | "sending"`); клиентские половины (`src/status.ts` для desktop GUI, инлайн-патчер в userscript) подменяют текст хостового `[data-component="session-working"]`, пока фаза известна, и возвращают исходный вид, когда её нет.

**Стек:** TypeScript, `node --test` (type stripping), Solid (GUI-плагин), vite.

**Spec:** этот файл (дизайн утверждён в чате 08.11.2026).

## Глобальные ограничения

- Хостовый текст не переводится и не переписывается навсегда: при снятии фазы узел возвращается к исходному состоянию.
- Селекторы — только из проверенной разметки бандла 2.2.5: `[data-component="session-working"]` (таймлайн), `[data-session-title] [role="status"][aria-label]` (точка в шапке).
- Любая ошибка патчера глотается: без метаданных остаётся хостовое «Работает».
- Ноль новых зависимостей. Гейт: `npm run check && npm test && npm run build`.

## Review Focus

- Метаданные без `phase` (сессии от старой версии) → фаза выводится из `position`/`holding`, а не «неизвестно».
- Гонка «grant → holding»: `unmarkWaiting` не должен затирать `sending` нулём фазы.
- Сессия на другом сервере/маршруте: подпись от предыдущей сессии не должна висеть дольше одного тика.
- `lockScope: "turn"` — фаза остаётся `sending` между шагами (слот удерживается).
- Хост перерисовал контейнер: наш span пересоздаётся, старый не остаётся сиротой.

---

### Task 1: Фаза в метаданных

**Files:**
- Modify: `src/state.ts`
- Modify: `src/index.ts`
- Test: `tests/state.test.ts`

**Interfaces:**
- Produces: `type Phase = "queued" | "sending"`; `TurnLockState.phase?: Phase`; `phaseOf(state): Phase | undefined`.

- [x] **Step 1: Тест** — `readState` читает `phase`, мусор игнорирует; `withState` сохраняет и убирает поле; `phaseOf` выводит `queued` из `position`/`since` и `sending` из `holding`, когда поля нет.
- [x] **Step 2:** `npm test` — падает.
- [x] **Step 3:** `Phase`, поле в `TurnLockState`, ветка в `readState`, строка в `compact`, функция `phaseOf`.
- [x] **Step 4:** `src/index.ts`: `phase?: Phase | null` в `StatePatch`; `"phase"` в цикле `applyPatch`; `phase: "queued"` в патч `markWaiting`; третий параметр `unmarkWaiting(sid, reason, phase: Phase | null = null)` и `phase` в его `clear()`; `unmarkWaiting(sid, "grant", "sending")` в обработчике `grant`; `phase: null` в orphan sweep.
- [x] **Step 5:** `npm test` — зелёный.

### Task 2: Патчер подписи

**Files:**
- Create: `src/status.ts`
- Test: `tests/status.test.ts`

**Interfaces:**
- Produces: `workingLabel(state, now?, lang?): { phase, text, spoken, title } | undefined`; `applyWorkingStatus(root, state, now?, lang?): boolean`; `startStatusView(options): () => void`; `STATUS_CLASS`.

- [x] **Step 1: Тест** на фейковом DOM (как `tests/inbox.test.ts`): `queued` даёт `⏳ В очереди · 2/5 · 9 мин` и `data-turn-lock-phase="queued"`; `sending` — `▶ Отправлено в движок`; пустое состояние снимает атрибут и удаляет span; повторный вызов на том же узле возвращает `false`; `aria-label` в шапке меняется и восстанавливается.
- [x] **Step 2:** `npm test` — падает.
- [x] **Step 3:** Реализация: `WORKING`, `HEADER`, `STATUS_CSS`, `workingLabel`, `applyWorkingStatus` (WeakMap на контейнер и на исходный `aria-label`), `startStatusView` (тик 1s, перезагрузка 2s, `watch`).
- [x] **Step 4:** `npm test` — зелёный.

### Task 3: Desktop

**Files:**
- Modify: `src/gui.tsx`

- [x] **Step 1:** Импорт `startStatusView`; опция `showQueueStatus !== false`.
- [x] **Step 2:** `startStatusView` с `load` = `ctx.sessions.current()` → `session.server.client.session.get` → `readState(metadata)`; `watch` кладёт свой `refresh` рядом с инбоксовым; в `listen()` вызывать оба.
- [x] **Step 3:** В cleanup — остановить вид и обнулить `refreshStatus`.
- [x] **Step 4:** `npm run check` — чисто.

### Task 4: Userscript

**Files:**
- Modify: `userscript/turn-lock-prio.user.js`

- [x] **Step 1:** `phase` в локальном `readState` + `phaseOf` (копия правила из `state.ts`).
- [x] **Step 2:** `readSession` возвращает `state`; `refresh()` кладёт его в `state.status`.
- [x] **Step 3:** `applyStatus()` — тот же патч (span `.tl-status`, `data-turn-lock-phase`, скрытие хостовых детей CSS-правилом); вызывать в `refresh()` и в секундном тике.
- [x] **Step 4:** Версия в шапке userscript — `0.8.0`, `@description` дополнено.

### Task 5: Документация

**Files:**
- Modify: `README.md`

- [x] **Step 1:** Раздел о метаданных: поле `phase` и его значения.
- [x] **Step 2:** Абзац о подписи в сессии: что подменяется, до какого момента, чем ограничено (DOM, TUI/телефон без userscript).

## Self-review

- [x] Каждое требование дизайна покрыто задачей.
- [x] Имена: `phase`, `phaseOf`, `workingLabel`, `applyWorkingStatus`, `startStatusView`, `STATUS_CLASS` — совпадают между задачами.
- [x] Review Focus покрыт тестами Task 1 (фаза без поля, turn-scope) и Task 2 (снятие, повторный вызов, aria-label).
