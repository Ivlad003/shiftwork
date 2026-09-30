# Технічне завдання: Shiftwork для pi (фаза 1)

Версія 1.0 · 2026-09-30. Словник: `CONTEXT.md`, рішення: `docs/adr/`, обґрунтування: `RESEARCH.md`, детальна специфікація: `.scratch/pi-runner/spec.md`, тікети: `.scratch/pi-runner/issues/`.

## 1. Мета

Зробити робочий Shiftwork для pi, достатній, щоб **Shiftwork далі розробляв сам себе**. Бекенди Claude Code / Codex / OpenCode і плагін OpenCode (фаза 2) пишуться вже тікетами, які виконує runner із фази 1.

## 2. Користувачі

- **Розробник (оператор).** Готує spec і тікети (скіли `/to-spec`, `/to-tickets`), запускає runner і переглядає результат.
- **Агент (backend).** Виконує одну shift над одним тікетом за правилами worker-промпту.

## 3. Обсяг фази 1

**Входить:**
- runner (`shiftwork run`) для backend-а pi;
- трекер у форматі ADR-0001;
- роутинг моделей, групи скілів, бюджети з handoff, перемикання провайдерів при provider limit, класифікація Jev;
- git worktree на тікет;
- пакет `pi-shiftwork`.

**Не входить** (фаза 2+):
- backend-и `claude`, `codex`, `opencode`;
- плагін OpenCode;
- паралельні runner-и (claim для них уже закладено);
- нотифікації (Telegram, desktop);
- UI поза TUI pi;
- денні або місячні бюджети в грошах поза межами тікета.

## 4. Функціональні вимоги

| ID | Вимога |
|---|---|
| FR-1 | Runner читає тікети з `.scratch/<feature>/issues/NN-*.md`, обчислює frontier і бере тікет із найменшим номером |
| FR-2 | Взяти тікет — це claim: ексклюзивний lock-файл, `Status: claimed`. Мертвий claim (процес помер) перехоплюється |
| FR-3 | Кожна shift — окремий процес `pi --mode rpc --no-session` (ADR-0002) з маршрутом: модель, thinking, `-ns --skill …`, worker-промпт + preloaded skills |
| FR-4 | Тікет стає `resolved` тільки після зеленого verify gate (ADR-0003). Без `Verify` тікет після спроби отримує `needs-info` |
| FR-5 | Після кожної shift runner дописує в `## Comments` звіт: маршрут, usage/вартість, результат verify gate, причину завершення |
| FR-6 | Маршрут визначається так: `Model` у тікеті → `routing[Type]` → тип за замовчуванням. Tier задає chain моделей |
| FR-7 | Набір скілів = групи tier-а ± `Skills` із тікета; preloaded skills вбудовуються в стартовий контекст |
| FR-8 | Бюджети (tokens, cost, turns, time, context %) на рівні модель → tier → default + загальний бюджет на тікет. Soft limit: агента просять написати handoff note. Hard limit: shift зупиняється |
| FR-9 | Handoff буває in-place (та сама сесія, `set_model`) або fresh (новий процес). Режим і цільова модель задаються правилами `onExceed`. Handoff note завжди потрапляє в тікет |
| FR-10 | Provider limit розпізнається з помилок, провайдер отримує cooldown у спільному state-файлі, shift перезапускається на наступній моделі chain. Така спроба не рахується |
| FR-11 | Stall (N ходів без змін у diff) і повторні провали verify gate ведуть до ескалації tier-а через fresh handoff |
| FR-12 | Правила зупинки: `maxAttempts`, бюджет тікета, файл `STOP`, усі провайдери в cooldown. Тікет, який зупинився, отримує `needs-info` з причиною |
| FR-13 | Кожен тікет виконується в окремому git worktree на гілці `shiftwork/<feature>-<NN>`. Після resolve гілка зливається в цільову |
| FR-14 | Тікет без `Type` класифікується Jev (TypeSafe). Якщо Jev недоступний — тип за замовчуванням |
| FR-15 | `shiftwork init` створює `.pi/shiftwork.json`, worker-промпт і рекомендовані `compaction.modelOverrides` у `.pi/settings.json` |
| FR-16 | `shiftwork status` показує тікети, frontier, claim-и, cooldown-и |
| FR-17 | `pi-shiftwork`: `/shift` (статус), `/shift run` (запуск runner-а у фоні з віджетом статусу), фільтр скілів за tier-ом для інтерактивних сесій |

## 5. Нефункціональні вимоги

- **Залежності.** `shiftwork-core` не залежить від pi / OpenCode (ADR-0004). CLI залежить від `@earendil-works/pi-coding-agent` лише заради `RpcClient`.
- **Мова.** ESM JavaScript + `.d.ts`, Node ≥ 22, без кроку збірки. Тести — `node --test`.
- **Тести без мережі.** Runner тестується через fake backend. pi-адаптер тестується через справжній процес pi зі скриптованим провайдером, без API-ключів.
- **Надійність.** Атомарний запис тікетів (tmp + rename). Падіння runner-а посеред shift не лишає «вічних» claim-ів.
- **Прозорість.** NDJSON-лог кожної shift у `logs/<feature>/<NN>/`. Жодне рішення runner-а не буває «тихим», кожне видно в Comments або в лозі.

## 6. Критерії приймання фази 1

1. `npm test` зелений.
2. На демо-репозиторії з трьох тікетів (один залежить від іншого) `shiftwork run` із реальною моделлю доводить усі до `resolved`. Кожен тікет при цьому проходить у своєму worktree, а в `## Comments` є звіти.
3. Штучно занижений бюджет викликає handoff (fresh та in-place), а handoff note з'являється в тікеті.
4. Штучна помилка ліміту одного провайдера перемикає shift на наступну модель chain і ставить провайдера в cooldown.
5. Фазу 2 запускають командою `shiftwork run` на тікетах цього ж репозиторію.

## 7. План

- **Тікети 01–03** — tracer і роутинг. Їх реалізує людина або Claude Code вручну.
- **Далі** — dogfooding: `shiftwork run` виконує тікети 04+ цього репозиторію, людина переглядає PR/diff.
