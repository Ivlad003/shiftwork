# Гайд по Shiftwork

Простими словами: як налаштувати Shiftwork і як ним користуватися. Терміни, виділені **жирним**, пояснено в [CONTEXT.md](../CONTEXT.md). [English version](guide.md).

## Як це працює, в одному абзаці

Ти пишеш **тікети**: маленькі Markdown-файли із задачею і командою `Verify`. `shiftwork run` бере наступний готовий тікет, запускає кодового агента у свіжому контексті (це **зміна**, shift), а коли агент зупиняється, запускає `Verify`. Verify пройшов: роботу комітять і зливають. Не пройшов: нова спроба, можливо на іншій моделі. Кожна зміна має **бюджет** (ходи, токени, гроші, час). Коли бюджет вичерпано або провайдер каже «rate limit», тікет передається наступній моделі.

## 1. Встановлення та ініціалізація

```bash
npm i -g @earendil-works/pi-coding-agent   # pi, агент за замовчуванням
pi                                          # далі /login хоча б в одного провайдера
npx shiftwork init --model anthropic/claude-sonnet-4-5
```

`npx shiftwork` працює без встановлення ([пакет у npm](https://www.npmjs.com/package/shiftwork)). npx кешує завантажене, тож пиши `npx shiftwork@latest …`, щоб точно отримати найновішу версію, або встанови один раз через `npm i -g shiftwork` і далі запускай просто `shiftwork …`.

`init` створює:

| Файл | Що це |
|---|---|
| `.pi/shiftwork.json` | Твій конфіг: моделі, tiers, маршрутизація, бюджети. Все, що описано нижче, пишеться сюди. |
| `.pi/shiftwork-worker.md` | Інструкції, які отримує кожен агент. Сюди можна дописати свої правила. |
| `.pi/settings.json` | Налаштування компакції pi. |

Другий конфіг, `~/.pi/agent/shiftwork.json` (або `$PI_CODING_AGENT_DIR/shiftwork.json`), діє для всіх репозиторіїв. Якщо поле є в обох, перемагає проєктний файл.

Подивитися, що станеться, нічого не витрачаючи:

```bash
npx shiftwork run --dry-run
```

## 2. Моделі, tiers і маршрутизація

### Як назвати модель

| Пишеш | Через що працює |
|---|---|
| `anthropic/claude-sonnet-4-5`, `openrouter/qwen/qwen3.8-27b:free`, `ollama/qwen2.5-coder:7b` | pi, з цим провайдером (`pi --list-models` показує всі) |
| `claude:sonnet` | Claude Code CLI |
| `codex:gpt-5.6-terra` | Codex CLI |
| `opencode:opencode-go/kimi-k3` | OpenCode CLI |
| `grok:grok-4.7` | Grok CLI |
| `cursor:auto` | Cursor agent CLI |

CLI-бекенд треба окремо встановити й залогінити. Якщо його немає, Shiftwork пропускає його з попередженням і переходить до наступної моделі. Невдалою спробою це не вважається.

### Tiers: списки моделей, які пробувати

**Tier** — це впорядкований список моделей (`chain`). Shiftwork бере першу, яка не охолоджується.

```json
"tiers": {
  "quick":    { "chain": ["opencode-go/space-bunny-free", "openrouter/qwen/qwen3.8-27b:free"], "thinking": "low" },
  "standard": { "chain": ["opencode-go/glm-5.3", "claude:sonnet", "xai/grok-4.6"] },
  "premium":  { "chain": ["xai/grok-4.7", "openrouter/anthropic/claude-opus-5"], "thinking": "high" }
}
```

В одному списку можна змішувати провайдерів і бекенди. Саме так «підключаються агенти різних провайдерів»: кладеш їх в один tier у тому порядку, який тобі до вподоби.

### Маршрутизація: який tier отримує який тип задач

Кожен тікет має **Type** (`code`, `test`, `docs`, `git`, `refactor` або будь-яке своє слово). `routing` прив'язує тип до tier або до однієї моделі:

```json
"defaultType": "code",
"routing": {
  "git":      { "tier": "quick", "thinking": "low" },
  "docs":     { "tier": "quick" },
  "code":     { "tier": "standard" },
  "refactor": { "tier": "premium" },
  "infra":    { "model": "claude:opus" }
}
```

Щоб додати новий тип задач, придумай назву, додай її в `routing` і напиши в тікеті `**Type:** infra`.

Як Shiftwork вибирає модель для тікета (перший збіг виграє):

1. Рядок `**Model:** provider/model` у самому тікеті.
2. `routing[<Type тікета>]`: модель або перша вільна модель цього tier.
3. `defaultTier`, потім `model` верхнього рівня.

Тікет без `Type` отримує `defaultType`, якщо тільки Jev (маленька модель-класифікатор, поле `jev` у конфігу) не вгадає його тип. Вимкнути Jev: `"jev": { "enabled": false }`.

### Інші налаштування маршрутизації

| Поле | Що означає |
|---|---|
| `thinking` | Рівень міркування: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Задається глобально, для tier, для маршруту або для моделі. Діє лише на моделі pi (див. нижче). |
| `crossTier` | `"up"`: коли охолоджується весь tier, позичати моделі з tier вище (також можна `"down"` або `"none"`). |
| `paidProviders` | Платні провайдери, наприклад `["openrouter"]`. Моделі `…:free` і `ollama/…` ніколи не вважаються платними. |
| `preferWaitMin` | Якщо безкоштовна модель звільниться протягом стількох хвилин, краще почекати на неї, ніж брати платну. |
| `cooldown` | Скільки провайдер відпочиває після ліміту, якщо сам не сказав, коли ліміт скинеться: `{ "rate": "15m", "usage": "5h", "quota": "24h", "server": "5m" }`. |
| `maxAttempts` | Скільки разів Verify може не пройти, перш ніж тікет стане `needs-info` (за замовчуванням 3). |
| `parallel` | Скільки тікетів фронтиру ранер опрацьовує одночасно (за замовчуванням 1). Понад 1 потребує `"worktree": { "enabled": true }`: кожен паралельний тікет отримує свій worktree. |
| `concurrency` | Обмежує кількість одночасних шифтів на провайдера, наприклад `{ "ollama": 1 }` для однієї GPU. Зайнятий провайдер пропускається як той, що охолоджується. Ключі ті самі, що в кулдаунів: `ollama`, `claude`, `opencode:opencode-go`. |

### Профілі моделей

Секція `models` задає налаштування однієї конкретної моделі, хоч би в якому tier вона стояла. Ключ — назва моделі точно так, як вона записана в `chain` або в рядку `Model:`, разом із префіксом бекенда.

```json
"models": {
  "ollama/qwen2.5-coder:7b": { "contextWindow": 32768 },
  "xai/grok-4.6":            { "thinking": "high" },
  "claude:opus":             { "budget": { "maxCostUsd": 4, "maxTurns": 120 } }
}
```

| Поле | Що означає |
|---|---|
| `thinking` | Перекриває `thinking` tier. Порядок: `routing[тип].thinking` → `models[модель].thinking` → `tiers[tier].thinking` → глобальний `thinking`. |
| `contextWindow` | Вікно контексту в токенах. `maxContextPct` рахується від нього, а не від вікна, яке повідомив бекенд. Корисно для локальної моделі, запущеної з меншим вікном. |
| `budget` | Бюджет зміни для цієї моделі (поля з розділу 5). Накладається останнім. |

**`thinking` працює лише для pi.** Shiftwork передає рівень міркування тільки моделям без префікса (`provider/model`). Бекенди `claude:`, `codex:`, `opencode:`, `grok:` і `cursor:` його ігнорують, хоча `--dry-run` і TUI показують `thinking=…` і для них. Рівень міркування CLI-агента налаштовуй його власними засобами: його конфігом або прапорцями в `args` (розділ 6).

## 3. Локальні моделі (Ollama)

1. Встанови [Ollama](https://ollama.com), запусти її (`ollama serve` або десктопний застосунок) і завантаж модель: `ollama pull qwen2.5-coder:7b`.
2. Запусти `npx shiftwork init --ollama`. Команда знайде твої моделі (на `OLLAMA_HOST`, за замовчуванням `http://localhost:11434`), додасть провайдера `ollama` в `~/.pi/agent/models.json` (інші провайдери лишаються) і додасть tier `local` у `.pi/shiftwork.json`.
3. Відправ туди частину задач: `"routing": { "docs": { "tier": "local" } }`. Або додай моделі `ollama/…` у список уже наявного tier.

Після завантаження нових моделей запусти `init --ollama` ще раз. Якщо Ollama не запущена, `init` підкаже, як її запустити, і нічого не змінить.

Варто знати:
- Локальні моделі безкоштовні, тож грошові бюджети на них не діють.
- Якщо Ollama зупиниться посеред роботи, тікет перейде до наступної моделі, а провайдер `ollama` відпочиватиме стільки, скільки задано для `usage` (за замовчуванням 5 год). Щоб після перезапуску Ollama користуватися нею одразу, видали її запис з `.pi/shiftwork-state.json`.
- `escalate` і `downgrade` в `onExceed` знають лише `quick < standard < premium`. Для tier `local` використовуй `next` або `same-tier`.

## 4. Як писати тікети

Тікет — це файл `.scratch/<feature>/issues/NN-short-name.md`:

```markdown
# 03: Email validation in signup

**What to build:** reject invalid emails in POST /signup with a 400 and a message.

**Blocked by:** 01, 02
**Status:** ready-for-agent
**Type:** code
**Model:** claude:sonnet
**Skills:** +design -git
**Budget:** $2 · 50 turns · 30 хв
**Verify:** `npm test -- signup` · `npm run lint`

- [ ] Invalid email → 400
- [ ] Valid email still signs up
```

Назви рядків (`**Status:**`, `**Verify:**` тощо) пишуться англійською: Shiftwork шукає саме їх. Текст задачі можна писати будь-якою мовою.

| Рядок | Обов'язковий | Що означає |
|---|---|---|
| `Status` | так | `ready-for-agent`, щоб тікет взяли в роботу. Shiftwork сам ставить `claimed`, `resolved` або `needs-info`. |
| `Blocked by` | ні | Номери тікетів тієї самої фічі, які мають бути `resolved` раніше. |
| `Verify` | дуже бажано | Shell-команди через `·`. **Тільки вони вирішують, чи задача виконана.** Переконайся, що до початку роботи вони падають. |
| `Type` | ні | Вибирає маршрут (розділ 2). |
| `Model` | ні | Примусово задає одну модель в обхід маршрутизації. |
| `Skills` | ні | Додає (`+група`) або прибирає (`-група`) групи skills для цього тікета. |
| `Budget` | ні | Ліміти для цього тікета (розділ 5). |

Після кожної зміни Shiftwork дописує звіт у `## Comments` тікета: модель, витрати, час, результат Verify і що сталося далі. Агенти лишають там нотатки `### Handoff` для наступної зміни.

Тікети можна писати вручну або доручити агенту через skills mattpocock `/to-spec` і `/to-tickets`. Зміни OpenSpec (`openspec/changes/`) теж підтримуються, див. [README core](../packages/core/README.md#openspec-tracker).

### Skills для кожного tier

Skill — це тека з файлом `SKILL.md`. Вкажи, де вони лежать (повний шлях або шлях відносно репозиторію; `~` не розгортається), згрупуй їх і роздай групи tiers. Слабшим моделям можна дати більше skills, а ті, що в `preload`, вставляються прямо в їхній стартовий контекст:

```json
"skillSources": { "tdd": "/home/me/.agents/skills/tdd", "design": "./skills/design" },
"skillGroups":  { "core": ["tdd"], "design": ["design"] },
"tiers": { "quick": { "chain": ["…"], "skills": ["core", "design"], "preload": ["core"] } }
```

## 5. Ліміти: час, токени, гроші

Так, усе це є, на двох рівнях:

- **Бюджет зміни** обмежує одну сесію агента. Коли він вичерпаний, тікет переходить до іншої моделі: той самий тікет, свіжий контекст і нотатка handoff.
- **Бюджет тікета** — це сума по всіх змінах тікета. Коли він вичерпаний, тікет зупиняється зі статусом `needs-info`.

| Поле | Що обмежує | У рядку `Budget:` |
|---|---|---|
| `maxTurns` | ходи агента | `50 turns`, `50 ходів` |
| `maxTokens` | токени | `200k tokens` |
| `maxCostUsd` | долари | `$2` |
| `maxWallMin` | реальний час у хвилинах | `30 min`, `1h 30min`, `1 год 15 хв` |
| `maxContextPct` | наскільки може заповнитися вікно контексту | `60% context` |
| `stallTurns` | ходи підряд, коли не змінилися ні diff, ні вивід тестів, що падають | `5 stall`, `5 застій` |

Скорочення працюють: `200k tokens`, `1.5M tokens`, `1h`, `1h 30min`, `1h30m`, `1.5h`, а також українські одиниці (`30 хв`, `1 год`, `10 ходів`). Те, чого Shiftwork не розпізнав, мовчки ігнорується, тому перевіряй через `shiftwork run --dry-run`: він показує бюджет кожного тікета.

Де задавати ліміти в `.pi/shiftwork.json`:

```json
"budgets": {
  "default": { "maxTurns": 150, "maxWallMin": 60, "maxContextPct": 80 },
  "tiers":   { "premium": { "maxCostUsd": 3 } },
  "models":  { "openrouter/anthropic/claude-opus-5": { "maxCostUsd": 3 } },
  "ticket":  { "maxTurns": 400, "maxWallMin": 180 }
}
```

- Бюджет зміни складається по черзі з `budgets.default`, бюджету tier, `budgets.models[модель]` і `models[модель].budget` (розділ 2). Кожен наступний перекриває попередній.
- Бюджет tier можна задати в `budgets.tiers.<tier>` або прямо в tier полем `"budget"` (так робить `init`). Якщо задано обидва, перемагає той, що в tier.
- `budgets.ticket` — загальний бюджет тікета за замовчуванням. Рядок `Budget:` у тікеті його перекриває, і жодна зміна не може витратити більше, ніж у тікета лишилося.

Що відбувається біля ліміту і на ньому:

- На `softLimitPct` (за замовчуванням 80 %) будь-якого ліміту зміни агенту кажуть закінчити поточний крок і написати нотатку handoff.
- На 100 % зміна закінчується, і `onExceed` вирішує, куди тікет піде далі:

```json
"onExceed": {
  "maxTurns":      { "to": "next",      "mode": "new-process" },
  "maxWallMin":    { "to": "next",      "mode": "new-process" },
  "maxContextPct": { "to": "same-tier", "mode": "new-process" },
  "verifyFailed":  { "to": "escalate" }
}
```

Варіанти `to`: `next` (наступна модель у списку), `same-tier` (інша модель того самого tier), `escalate` / `downgrade` (tier вище або нижче). `maxHandoffs` (за замовчуванням 3) обмежує кількість передач на один тікет.

## 6. Налаштування інших агентів

Кожен бекенд, включно з pi, має необов'язковий блок верхнього рівня з тією самою назвою, що й префікс: `pi`, `claude`, `codex`, `opencode`, `grok`, `cursor`.

| Поле | Що означає |
|---|---|
| `command` | Яку програму запускати (крім `pi`). За замовчуванням `claude`, `codex`, `opencode`, `grok`, `cursor-agent`. Можна вказати повний шлях. |
| `args` | Додаткові прапорці. Вони йдуть після прапорців Shiftwork і перед промптом. |
| `env` | Додаткові змінні середовища для процесу агента, поверх твого середовища. |
| `timeoutMs` | Аварійний таймаут процесу. Звичайні ліміти задаються бюджетами (розділ 5). |
| `sandbox` | Лише для `codex`, див. нижче. |

```json
"pi":     { "env": { "PI_CODING_AGENT_DIR": "/home/me/.pi/agent-work" } },
"claude": { "args": ["--max-turns", "200"], "timeoutMs": 3600000 },
"codex":  { "sandbox": "bypass" },
"grok":   { "command": "/home/me/.grok/bin/grok" },
"cursor": { "command": "cursor-agent" }
```

`codex.sandbox`: `"approve-for-me"` (за замовчуванням), `"workspace-write"` або `"bypass"`, коли середовище вже ізольоване або bwrap не може створити пісочницю.

Shiftwork не перевіряє `args`, а передає їх як є. Що туди можна писати, дивись у `--help` відповідного CLI. `--dry-run` агентів не запускає, тож нові `args` перевір одним `shiftwork run --once`.

Для Grok і Cursor ніколи не вказуй `command: "agent"`. Обидва інсталятори створюють посилання `agent`, і яка програма відкриється, залежить від порядку в PATH.

### Інструкції проєкту: AGENTS.md і CLAUDE.md

Агенти самі читають файли з інструкціями твого репозиторію. Перевірено наживо 2026-09-30:

| Бекенд | Читає `AGENTS.md` | Читає `CLAUDE.md` |
|---|---|---|
| pi (`provider/model`) | так | лише коли в тій самій теці немає `AGENTS.md` |
| Claude Code (`claude:`) | ні | так |
| Codex (`codex:`) | так | ні |
| OpenCode (`opencode:`) | так | лише коли немає `AGENTS.md` |
| Cursor (`cursor:`) | так | так |
| Grok CLI (`grok:`) | ні, тому Shiftwork вставляє його в промпт | так само: `CLAUDE.md`, якщо немає `AGENTS.md` |

Тож тримай правила в `AGENTS.md`, а `CLAUDE.md` зроби з одного рядка `@AGENTS.md`: тоді всі агенти бачать ті самі правила. Моделі `xai/…` працюють через pi, тож вони їх отримують.

Дві речі, про які варто пам'ятати:
- Агенти працюють у git worktree, а там є лише **закомічені** файли. Незакомічений або доданий у `.gitignore` `AGENTS.md` (чи `CLAUDE.local.md`) туди не потрапить.
- Worktree лежить у `~/.cache/shiftwork/worktrees/`, тому файли з інструкціями з **батьківських тек** твого репозиторію не підхоплюються. Глобальні (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.pi/agent/AGENTS.md`) працюють як завжди.

Крім цього, кожен агент отримує власні інструкції Shiftwork з `.pi/shiftwork-worker.md`.

## 7. Запуск і спостереження

```bash
npx shiftwork status                   # усі тікети; → позначає готові
npx shiftwork run --once               # один тікет
npx shiftwork run --feature signup     # тільки ця фіча, поки є готові тікети
npx shiftwork run --parallel 3         # до трьох тікетів одночасно
npx shiftwork tui                      # живий дашборд
```

Кожен тікет працює у власному git worktree в `~/.cache/shiftwork/worktrees/`. Залежності туди ставляться так: `"worktree": { "setup": ["npm ci --ignore-scripts"] }`. Якщо лендінг тікета конфліктує з тим, що влитий першим, гілка перебазовується на нову ціль і Verify проходить знову; якщо й rebase конфліктує, робота переробляється поверх неї у свіжому worktree, ще одним shiftом (`- Landing conflict with …; redone on top of …` у тікеті). Щоб акуратно зупинитися, створи в корені репозиторію файл `STOP` (або натисни `s` у TUI): поточна зміна напише handoff, і runner завершиться. Логи змін лежать у `logs/<feature>/<NN>/`.

### Що вміє TUI

| Показує | Клавіші |
|---|---|
| Поточний тікет, його модель, tier, витрати й бюджет; готові тікети по фічах; активні охолодження; хвіст логу | `r` запустити · `s` зупинити з handoff · `d` dry-run (маршрут і бюджет кожного готового тікета) · `f` фільтр по фічі · `q` вийти |

TUI лише показує стан, запускає й зупиняє роботу. Моделі, tiers, маршрутизація і бюджети редагуються в `.pi/shiftwork.json`, і наступний тікет уже підхоплює зміни.

### Review після кожного тікета

Можна увімкнути **review shift**: коли тікет злитий, свіжий агент на вибраному tier читає тікет, спеку і diff, запускає Verify і виносить вердикт.

```json
"review": { "enabled": true, "tier": "premium", "features": ["signup"], "types": ["code", "refactor"] }
```

`features` і `types` — необов'язкові фільтри. Вердикт записується в тікет як `### Review`:
- **accept**: готово.
- **reopen**: тікет повертається в `ready-for-agent`, і наступний `run` доробляє його поверх уже злитого коміту.
- **follow-up**: у фічі створюється новий тікет з тим самим Verify.

За замовчуванням review вимкнений. `--dry-run` показує, які тікети пройдуть review.

## 8. Повний приклад конфігу

Один `.pi/shiftwork.json`, де задіяно майже все з цього гайду: п'ять різних агентів, локальна модель, профілі моделей, паралельний запуск і review.

```json
{
  "defaultType": "code",
  "thinking": "medium",
  "maxAttempts": 3,
  "maxHandoffs": 3,
  "softLimitPct": 80,
  "parallel": 2,
  "worktree": { "enabled": true, "setup": ["npm ci --ignore-scripts"] },

  "tiers": {
    "local":    { "chain": ["ollama/qwen2.5-coder:7b"], "thinking": "off" },
    "quick":    { "chain": ["opencode:opencode-go/kimi-k3", "openrouter/qwen/qwen3.8-27b:free", "cursor:auto"],
                  "thinking": "low", "skills": ["core", "design"], "preload": ["core"],
                  "budget": { "maxTurns": 40, "maxContextPct": 60, "stallTurns": 5 } },
    "standard": { "chain": ["claude:sonnet", "codex:gpt-5.6-terra", "xai/grok-4.6"],
                  "skills": ["core"],
                  "budget": { "maxCostUsd": 1.5, "maxTokens": 3000000 } },
    "premium":  { "chain": ["claude:opus", "grok:grok-4.7", "openrouter/anthropic/claude-opus-5"],
                  "thinking": "high",
                  "budget": { "maxCostUsd": 3, "maxContextPct": 70 } }
  },

  "routing": {
    "git":      { "tier": "quick", "thinking": "low" },
    "docs":     { "tier": "local" },
    "test":     { "tier": "standard" },
    "code":     { "tier": "standard" },
    "refactor": { "tier": "premium" },
    "infra":    { "model": "claude:opus" }
  },

  "models": {
    "ollama/qwen2.5-coder:7b":            { "contextWindow": 32768 },
    "xai/grok-4.6":                       { "thinking": "high" },
    "openrouter/anthropic/claude-opus-5": { "budget": { "maxCostUsd": 3 } },
    "claude:opus":                        { "budget": { "maxCostUsd": 4, "maxTurns": 120 } }
  },

  "budgets": {
    "default": { "maxTurns": 60, "maxWallMin": 45, "stallTurns": 8 },
    "ticket":  { "maxCostUsd": 8, "maxWallMin": 120 }
  },

  "onExceed": {
    "maxCostUsd":    { "to": "downgrade", "mode": "new-process" },
    "maxTokens":     { "to": "downgrade", "mode": "new-process" },
    "maxTurns":      { "to": "next",      "mode": "new-process" },
    "maxWallMin":    { "to": "next",      "mode": "new-process" },
    "maxContextPct": { "to": "same-tier", "mode": "new-process" },
    "stallTurns":    { "to": "escalate",  "mode": "new-process" },
    "verifyFailed":  { "to": "escalate",  "mode": "new-process" }
  },

  "crossTier": "up",
  "paidProviders": ["openrouter", "xai"],
  "preferWaitMin": 20,
  "cooldown": { "rate": "15m", "usage": "5h", "quota": "24h", "server": "5m" },
  "concurrency": { "ollama": 1, "claude": 1 },

  "skillSources": { "tdd": "/home/me/.agents/skills/tdd", "design": "./skills/design" },
  "skillGroups":  { "core": ["tdd"], "design": ["design"] },

  "review": { "enabled": true, "tier": "premium", "types": ["code", "refactor"] },
  "jev": { "enabled": true, "model": ["typesafe/jev-latest", "opencode/jev-1.13-free"] },

  "pi":       { "timeoutMs": 10800000 },
  "claude":   { "args": ["--max-turns", "200"], "timeoutMs": 3600000 },
  "codex":    { "sandbox": "workspace-write" },
  "opencode": { "timeoutMs": 3600000 },
  "grok":     { "command": "grok" },
  "cursor":   { "command": "cursor-agent" }
}
```

Що тут відбувається:

- **Чотири tiers на різних агентах.** `local`: тільки Ollama. `quick`: OpenCode → безкоштовна модель OpenRouter через pi → Cursor. `standard`: Claude Code → Codex → Grok через pi. `premium`: Claude Code з Opus → Grok Build → Opus через OpenRouter.
- **Маршрути.** Документацію пише локальна модель, а `infra` завжди йде на `claude:opus`, хоч би що було в tiers.
- **Профілі моделей.** Ollama рахує заповнення контексту від 32k. `xai/grok-4.6` міркує на `high`, хоча tier `standard` має `medium`. `claude:opus` отримує свій бюджет.
- **`thinking` tier `premium` (`high`)** реально дістанеться лише `openrouter/anthropic/claude-opus-5`, бо це єдина модель pi в цьому tier. Для `claude:opus` і `grok:grok-4.7` його не буде (розділ 2).
- **Паралельність.** Два тікети одночасно, кожен у своєму worktree. Але не більше однієї зміни на Ollama (одна GPU) і однієї на Claude Code (одна підписка).
- **Гроші.** `openrouter` і `xai` платні. Якщо безкоштовна модель звільниться протягом 20 хвилин, Shiftwork почекає на неї. Коли весь tier охолоджується, моделі позичаються з tier вище (`crossTier: "up"`).
- **Review** запускається на `premium` лише для тікетів `code` і `refactor`.

Перевір результат перед запуском:

```bash
npx shiftwork run --dry-run
```

```
f/04  type=code  tier=standard  model=claude:sonnet  thinking=medium  budget=$1.5 · 3000000 tok · 60 turns · 45 min · 8 stall  review=premium
f/04  type=docs  tier=local  model=ollama/qwen2.5-coder:7b  thinking=off  budget=$8 · 60 turns · 45 min · 8 stall  review=no
f/05  type=infra  tier=premium  model=claude:opus  thinking=high  budget=$4 · 120 turns · 45 min · 70% ctx · 8 stall  review=no
```

## 9. Чого ще немає

- Редагування конфігу з TUI.
