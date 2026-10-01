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

Shiftwork сам знаходить pi: npm-пакет, `pi` у PATH, а також інсталяцію офіційним інсталятором (`~/.pi/agent/install/releases/<версія>`, де `pi` у PATH — лише shell-лаунчер). Якщо pi стоїть деінде, вкажи теку його пакета: `"pi": { "root": "/шлях/до/node_modules/@earendil-works/pi-coding-agent" }`.

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
| `thinking` | Рівень міркування: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Задається глобально, для tier, для маршруту або для моделі. Діє на моделі pi і `grok:` (див. нижче). |
| `crossTier` | `"up"`: коли охолоджується весь tier, позичати моделі з tier вище (також можна `"down"` або `"none"`). |
| `paidProviders` | Платні провайдери, наприклад `["openrouter"]`. Моделі `…:free` і `ollama/…` ніколи не вважаються платними. |
| `preferWaitMin` | Якщо безкоштовна модель звільниться протягом стількох хвилин, краще почекати на неї, ніж брати платну. |
| `cooldown` | Скільки провайдер відпочиває після ліміту, якщо сам не сказав, коли ліміт скинеться: `{ "rate": "15m", "usage": "5h", "quota": "24h", "server": "5m" }`. |
| `maxAttempts` | Скільки разів Verify може не пройти, перш ніж тікет стане `needs-info` (за замовчуванням 3). |
| `verifyTimeoutMin` | Скільки хвилин може йти одна команда Verify, перш ніж її зупинять разом з усім, що вона запустила, і Verify вважатиметься непройденим (за замовчуванням 10). Наприклад, `"verifyTimeoutMin": 20` для повільних тестів. |
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

**`thinking` працює для pi і `grok:`.** Моделі без префікса (`provider/model`) отримують рівень як є. Для `grok:` він стає `--reasoning-effort`, підігнаним під рівні, які пропонує модель (у `~/.grok/models_cache.json`): `off`/`minimal` → найнижчий, `max` → найвищий; невідома модель лишається на своєму рівні за замовчуванням. Бекенди `claude:`, `codex:`, `opencode:` і `cursor:` його ігнорують, хоча `--dry-run` і TUI показують `thinking=…` і для них. Рівень міркування CLI-агента налаштовуй його власними засобами: його конфігом або прапорцями в `args` (розділ 6).

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
| `maxTokens` | токени: усі токени кожного ходу, включно з кешованим контекстом, тож 3M ≈ 20 ходів на контексті 140k | `200k tokens` |
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

### Без лімітів

Щоб агенти працювали, доки самі не зупиняться, зніми ліміти для одного запуску:

```bash
npx shiftwork run --no-budget              # усі ліміти: ходи, токени, гроші, час, контекст, застій
npx shiftwork run --no-limit tokens,time   # лише ці: tokens, cost, turns, time, context, stall
```

Знімаються ліміти і змін, і тікетів, разом із рядками `Budget:` у тікетах. Те саме в `.pi/shiftwork.json`: `"unlimited": true` або `"unlimited": ["tokens", "time"]`; `--no-limit` додає до списку з конфігу. `--dry-run` показує, що лишилось (`budget=-`, коли не лишилось нічого), а runner на старті пише, які ліміти зняті. Без `cost` платні моделі витрачатимуть стільки, скільки витратять; без `stall` агент, що застряг, крутитиметься далі; без `context` за переповнення вікна відповідає сам агент. Власний бюджет review-шифта (`review.budget`, розділ 7) ці списки не підіймають — лише сам `review.budget`.

Окремо на tier й окремо на модель `unlimited` приймає ті самі значення й знімає **лише ліміти змін**:

```json
"tiers":  { "local": { "chain": ["ollama/qwen3"], "unlimited": ["turns", "time"] } },
"models": { "ollama/qwen3": { "unlimited": true } }
```

Змін на такому tier або з такою моделлю йде з об'єднанням знятих списків (загального, tier'у і моделі). Бюджет самого тікету далі його обмежує — рядок `**Budget:**` це рішення за конкретний тікет, його знімає лише загальний `unlimited` — а зачеплений лише цей tier чи модель, тож безкоштовний tier може працювати без лімітів ходів і часу, поки платні моделі лишаються обмеженими.

## 6. Налаштування інших агентів

Кожен бекенд, включно з pi, має необов'язковий блок верхнього рівня з тією самою назвою, що й префікс: `pi`, `claude`, `codex`, `opencode`, `grok`, `cursor`.

| Поле | Що означає |
|---|---|
| `command` | Яку програму запускати (крім `pi`). За замовчуванням `claude`, `codex`, `opencode`, `grok`, `cursor-agent`. Можна вказати повний шлях. |
| `args` | Додаткові прапорці. Вони йдуть після прапорців Shiftwork і перед промптом. |
| `env` | Додаткові змінні середовища для процесу агента, поверх твого середовища. |
| `timeoutMs` | Аварійний таймаут процесу. Звичайні ліміти задаються бюджетами (розділ 5). |
| `sandbox` | Лише для `codex`, див. нижче. |
| `root` | Лише для `pi`: тека пакета pi, якщо Shiftwork не знаходить його сам (розділ 1). |

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
| Grok CLI (`grok:`) | ні, тому Shiftwork додає його в системний промпт grok (`--rules`) | так само: `CLAUDE.md`, якщо немає `AGENTS.md` |

Тож тримай правила в `AGENTS.md`, а `CLAUDE.md` зроби з одного рядка `@AGENTS.md`: тоді всі агенти бачать ті самі правила. Моделі `xai/…` працюють через pi, тож вони їх отримують.

Дві речі, про які варто пам'ятати:
- Агенти працюють у git worktree, а там є лише **закомічені** файли. Незакомічений або доданий у `.gitignore` `AGENTS.md` (чи `CLAUDE.local.md`) туди не потрапить.
- Worktree лежить у `~/.cache/shiftwork/worktrees/`, тому файли з інструкціями з **батьківських тек** твого репозиторію не підхоплюються. Глобальні (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.pi/agent/AGENTS.md`) працюють як завжди.

Крім цього, кожен агент отримує власні інструкції Shiftwork з `.pi/shiftwork-worker.md`.

## 7. Запуск і спостереження

```bash
npx shiftwork status                   # усі тікети; → позначає готові
npx shiftwork run                      # пройти всю чергу, тікет за тікетом, поки є готові
npx shiftwork run --dry-run            # які тікети підуть, у якому порядку, на якій моделі — нічого не запускає
npx shiftwork run --once               # один тікет (наступний за порядком нижче)
npx shiftwork run --ticket signup/03   # саме цей тікет, якщо він готовий
npx shiftwork run --feature signup     # тільки ця фіча, поки є готові тікети
npx shiftwork run --parallel 3         # до трьох тікетів одночасно
npx shiftwork tui                      # живий дашборд
npx shiftwork tickets check signup     # planning gate: чи робочі тікети цієї фічі
```

`shiftwork tickets check <feature> [--min N] [--except NN]` — це Verify-гейт планувального тікета: вихід 0, коли щонайменше `N` (за замовчуванням 1) тікетів, крім винятків (за замовчуванням `01` — сам план), мають статус `ready-for-agent` чи пізніший, у кожного є чекбокс приймання та рядок `Verify`, і кожне число з `Blocked by:` існує у фічі. Інакше вихід 1, по одному рядку на проблему (`signup/03: no Verify line`).

Кожен тікет працює у власному git worktree в `~/.cache/shiftwork/worktrees/`. Залежності туди ставляться так: `"worktree": { "setup": ["npm ci --ignore-scripts"] }`. Якщо лендінг тікета конфліктує з тим, що влитий першим, гілка перебазовується на нову ціль і Verify проходить знову; якщо й rebase конфліктує, робота переробляється поверх неї у свіжому worktree, ще одним shiftом (`- Landing conflict with …; redone on top of …` у тікеті). Щоб акуратно зупинитися, створи в корені репозиторію файл `STOP` (або натисни `s` у TUI): поточна зміна напише handoff, і runner завершиться. `Ctrl-C`, `kill` (SIGTERM) і закритий термінал (SIGHUP) роблять те саме; повторний сигнал, або 60 с без завершення, зупиняє агентів і команди Verify одразу, тож жоден процес агента не переживе runner. Логи змін лежать у `logs/<feature>/<NN>/`.

### Як runner вибирає наступний тікет

Оркестратор — це сам runner: звичайний код, а не модель. Окремий агент-оркестратор чи ручний вибір не потрібні: напиши тікети, запусти `shiftwork run`, і він сам пройде їх один за одним.

1. **Лише готові тікети.** Тікет можна брати, коли його статус `ready-for-agent` і кожен тікет з рядка `Blocked by` уже `resolved`. Такі тікети — це **frontier**. `needs-info`, `ready-for-human`, `wontfix` і тікети, які тримає інший runner, пропускаються.
2. **Фіча за фічею.** Runner закриває одну фічу, перш ніж братися за наступну. Він лишається на поточній фічі, поки в ній є готовий тікет, і бере її тікети за номером (`01`, `02`, …). Переходить далі лише тоді, коли у фічі немає нічого готового: усе `resolved`, або решта заблокована чи чекає на тебе.
3. **Яка фіча наступна.** Фіча, яку вже почали (якийсь тікет `resolved` чи `claimed`), іде перед новою; серед рівних — за алфавітом назви. Щоб задати порядок самому, додай до назв фіч номери (`01-auth`, `02-billing`).
4. **Для кожного тікета:** вибрати модель за routing і рівнем (провайдери на cooldown пропускаються), запустити зміну в окремому worktree, запустити `Verify`. Пройшло → злити в основну гілку, запустити рев'ю (якщо ввімкнене), взяти наступний тікет. Не пройшло → ще одна спроба (до `maxAttempts`, потім `needs-info`) або передача наступній моделі, коли скінчився бюджет чи ліміт провайдера.
5. **Запуск завершується**, коли frontier порожній, або на STOP. Коли всі моделі маршруту тікета на cooldown, runner чекає, поки якась повернеться; тікет, для якого немає жодної придатної моделі, стає `needs-info`.

З `--parallel N` слоти заповнюються в тому самому порядку: спершу готові тікети поточної фічі, потім наступної.

Вручну кермувати треба лише тоді, коли хочеш інший порядок: `run --feature <name>` (одна фіча), `run --ticket <feature>/<NN>` (один тікет) або `n` на тікеті в TUI. `run --dry-run` покаже порядок, перш ніж щось витратиш.

### Що вміє TUI

П'ять повноекранних вкладок (`1`–`5`, або `tab` по колу): **Queue**, **Agents**, **Cooldowns**, **Log**, **GitHub**. У шапці — вкладки, останнє повідомлення й, поки живий dark-factory runner, позначка `dark-factory`; у підвалі — клавіші поточної вкладки. Інтерактивний вигляд використовує alternate screen термінала, вміщається в його висоту і перемальовується при зміні розміру. Він кольоровий: рядок курсора підсвічений на всю ширину, статуси тікетів забарвлені (resolved зелений, claimed блакитний, needs-info жовтий, blocked приглушений), маркер `● model` живого worker — блакитний, рядки охолоджень — червоні, активна вкладка — жирна, повідомлення — жовте. Вистав `NO_COLOR`, щоб вимкнути кольори; `tui --once` і текстовий fallback лишаються без кольору. Без pi-tui є текстовий fallback: кадр щосекунди; ті самі клавіші працюють там, де це має сенс.

| Вкладка | Показує | Клавіші |
|---|---|---|
| Queue | Фічі як теки (`▾ parallel 3/4`) з тікетами (номер, назва, статус, блокери, `● model`, якщо агент тримає тікет) | `↑↓`/`j k` рух · `←→` згорнути/розгорнути · `enter` деталі · `n` запустити цей тікет · `esc` назад |
| Agents | Один рядок на поточний shift: тікет, модель, tier, shift/attempt, токени, вартість, ходи, заповнення контексту, бюджет, час | `↑↓`/`j k` рух · `enter` відкриває лог цього агента |
| Cooldowns | Активні охолодження провайдерів і скільки лишилось | `↑↓`/`j k` рух |
| Log | Хвіст логу вибраного агента (інакше першого живого worker) | `↑↓`/`j k` рух |
| GitHub | Іссью, які імпортував `run --dark-factory` (`.pi/shiftwork-github.json`): `#<N> <назва> · <фіча> · <стан>`, де стан — planning, working, needs-info, done, closed — виводиться з тікетів фічі, плюс час останнього синку | `↑↓`/`j k` рух · `enter` відкриває фічу іссью у вкладці Queue |

На кожній вкладці також: `r` запустити detached runner (другий `r`, поки один уже живий, відхиляється) · `s` зупинити з handoff · `d` dry-run · `f` фільтр по фічі · `g` перемкнути dark-factory (запускає `shiftwork run --dark-factory` detached, коли жоден runner не працює, і пише STOP, коли один живий) · `q` вийти. `n` запускає `shiftwork run --ticket <feature>/<NN>` detached, як `r`; відхиляється, якщо курсор не на готовому тікеті frontier або runner уже працює.

TUI лише показує стан, запускає й зупиняє роботу. Моделі, tiers, маршрутизація і бюджети редагуються в `.pi/shiftwork.json`, і наступний тікет уже підхоплює зміни.

### Review після кожного тікета

Review **увімкнені за замовчуванням**: коли тікет злитий, свіжий агент на review-tier читає тікет, спеку і diff, запускає Verify і виносить вердикт. Review-tier — найсильніший зі сконфігурованих: `premium`, якщо він є, інакше `standard`, інакше `quick`, інакше перший tier з `tiers` — тож кожен тікет коштує ще один шифт, зазвичай на найдорожчій моделі. Задайте `tier`, щоб ревʼювити дешевше, або звузьте review необов'язковими фільтрами `features` і `types`:

```json
"review": { "tier": "standard", "features": ["signup"], "types": ["code", "refactor"] }
```

Вердикт записується в тікет як `### Review`:
- **accept**: готово.
- **reopen**: тікет повертається в `ready-for-agent`, і наступний `run` доробляє його поверх уже злитого коміту.
- **follow-up**: у фічі створюється новий тікет з тим самим Verify.

Щоб вимкнути review: `"review": false` (або `{ "enabled": false }`) у конфігу, або `shiftwork run --no-review` на один запуск. Якщо tiers немає взагалі — ревʼювити ніде, тому review залишаються вимкненими, і `run` каже про це на старті. `run` друкує review-tier (або його фільтри) на старті; `--dry-run` показує, які тікети пройдуть review (`review=<tier>` або `review=no`).

Ревʼювер працює **лише локально**: читає код, запускає verify gate і тести репозиторія і ніколи не ходить у мережу — без `gh api`, `curl` та встановлення пакетів; зовнішні виклики оцінюються за кодом і стабами тестів. Review-шифт живе на **власному бюджеті** `review.budget` (за замовчуванням `{ "maxWallMin": 20, "maxTurns": 60 }`, ті самі поля, що й в інших бюджетів): бюджети тікета, tier і моделі його не обмежують, і списки `unlimited` його не підіймають — це може лише сам `review.budget`. На soft limit ревʼюверу кажуть припинити досліджувати і дати вердикт, а не робити handoff.

Review зобовʼязане дати вердикт — **мовчазного accept не існує**. Review, що завершилося без валідного маркера (невідоме слово теж не вердикт), повторюється один раз у свіжому контексті на наступній моделі ланцюга review-tier. Якщо й там вердикта немає, тікет записує `- Verdict: none` і йде в `needs-info` (`review gave no verdict twice; review it by hand`): злитий коміт лишається, і людина переглядає його вручну.

## 8. Повний приклад конфігу

Один `.pi/shiftwork.json`, де задіяно майже все з цього гайду: п'ять різних агентів, локальна модель, профілі моделей, паралельний запуск і review.

```json
{
  "defaultType": "code",
  "thinking": "medium",
  "maxAttempts": 3,
  "maxHandoffs": 3,
  "verifyTimeoutMin": 20,
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

  "review": { "tier": "premium", "types": ["code", "refactor"] },
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
- **`thinking` tier `premium` (`high`)** дістанеться `openrouter/anthropic/claude-opus-5` (pi) і `grok:grok-4.7`. `grok:grok-4.7` отримає `--reasoning-effort high`, а `claude:opus` — ні (розділ 2).
- **Паралельність.** Два тікети одночасно, кожен у своєму worktree. Але не більше однієї зміни на Ollama (одна GPU) і однієї на Claude Code (одна підписка).
- **Гроші.** `openrouter` і `xai` платні. Якщо безкоштовна модель звільниться протягом 20 хвилин, Shiftwork почекає на неї. Коли весь tier охолоджується, моделі позичаються з tier вище (`crossTier: "up"`).
- **Review** (за замовчуванням) запускається на `premium` лише для тікетів `code` і `refactor`.

Перевір результат перед запуском:

```bash
npx shiftwork run --dry-run
```

```
f/04  type=code  tier=standard  model=claude:sonnet  thinking=medium  budget=$1.5 · 3000000 tok · 60 turns · 45 min · 8 stall  review=premium
f/04  type=docs  tier=local  model=ollama/qwen2.5-coder:7b  thinking=off  budget=$8 · 60 turns · 45 min · 8 stall  review=no
f/05  type=infra  tier=premium  model=claude:opus  thinking=high  budget=$4 · 120 turns · 45 min · 70% ctx · 8 stall  review=no
```

## Dark-factory: лейбли

Режим dark-factory бере роботу з GitHub-**іссюїв** замість `.scratch/`: ти передаєш іссью одним лейблом, Shiftwork планує і робить її, а потім звітує в іссью коментарями і власними лейблами. Кожен лейбл має один сенс:

| Лейбл | Значення | Хто ставить |
|---|---|---|
| `shiftwork:in` | Іссью передано Shiftwork: беруться лише іссью з цим лейблом | Ти, або будь-який колаборатор |
| `shiftwork:working` | Тікет цієї іссїї у роботі | Shiftwork |
| `shiftwork:needs-info` | Shiftwork поставив запитання в коментарі, іссью чекає відповіді | Shiftwork |
| `shiftwork:done` | Усі тікети іссїї виконані | Shiftwork |

Перейменуй їх у блоці `github` файлу `.pi/shiftwork.json`. Обов'язковий лише `in` — без нього немає способу передати іссью; решта за замовчуванням мають назви вище:

```json
"github": {
  "repo": "owner/name",
  "labels": {
    "in": "shiftwork:in",
    "working": "shiftwork:working",
    "needsInfo": "shiftwork:needs-info",
    "done": "shiftwork:done"
  }
}
```

`repo` — це `owner/name` (за замовчуванням з remote `origin`). Відсутній лейбл — це помилка, він ніколи не створюється мовчки: dark-factory завершується зі списком відсутніх назв і підказкою виконати команду нижче.

Усю роботу з GitHub Shiftwork робить через GitHub CLI і твій логін — токена в конфігу немає, і Shiftwork його ніколи не читає й не зберігає. Налаштуй один раз:

1. Встанови GitHub CLI: <https://cli.github.com>. Shiftwork запускає твій встановлений `gh` (вкажи його в блоці `github`: `"gh": "/шлях/до/gh"`, якщо його немає в PATH).
2. Увійди: `gh auth login`.
3. Перевір вхід: `gh auth status`.
4. Додай блок `github` (вище) у `.pi/shiftwork.json`.
5. Створи лейбли: `npx shiftwork github labels --create`. Команда друкує `✔ назва exists` / `✖ назва missing` для кожного налаштованого лейбла і створює відсутні з кольором та описом; вона ніколи не редагує й не видаляє лейбл. Без `--create` лише перевіряє і виходить з кодом 1, коли якогось лейбла немає.
6. Передай роботу: колаборатор ставить лейбл `in` на іссью.

## Режим dark-factory

`npx shiftwork run --dark-factory` крутить увесь цикл без нагляду: кожні `github.pollMin` хвилин (за замовчуванням 5) опитує іссью репозиторію, імпортує нові, звітує, відробляє фронтір до кінця, звітує ще раз і чекає наступного опиту. Зупиняється як будь-який ранер: STOP-файл чи сигнал завершують його після поточного шифту. `npx shiftwork run --dark-factory --once` робить один опит плюс один прохід фронтіром і виходить.

TUI тримає це під рукою: вкладка **GitHub** (`5`) показує імпортовані іссью і час останнього синку, а `g` запускає `run --dark-factory` detached, коли жоден ранер не працює (другий `g`, як і `s`, пише STOP); у шапці, поки він працює, стоїть позначка `dark-factory`.

Як він поводиться з іссью:

- **Лише колаборатори.** Імпортується лише іссью, автор якої — колаборатор репозиторію (плюс логіни з `github.authors`) — текст іссью — це недовірений вхід для агента без нагляду, тому іссью інших авторів ігноруються, як і іссью без лейбла `in`. Кожна іссью стає фічею в `.scratch/`: спека (сама іссью) і планувальний тікет, що розбиває її на тікети реалізації.
- **Звіт у іссью, нічого не видаляється.** Коментар, коли робота почалась; коментар на кожен виконаний тікет зі звітом шифту і посиланнями на коміти; питання, коли тікету потрібна інформація — а відповідь колаборатора на це питання повертається в тікет. Лейбли, які він ставить, див. [`Dark-factory: лейбли`](#dark-factory-лейбли).
- **Закриття.** Коли всі тікети іссью виконані, іссью закривається з підсумковим коментарем (`github.autoClose`, за замовчуванням true). На GitHub нічого не видаляється.
- **Push.** Ранер приземляє коміти в локальний `main`; посилання на коміти в коментарях працюють лише тоді, коли коміти вже на GitHub. Постав `"push": true` у блоці `github`, і dark-factory після кожного проходу, що приземлив коміти, виконує `git push origin HEAD` в основному чекауті. Без цього в коментарях лише короткі sha.

На старті, до імпорту будь-чого, dark-factory перевіряє твій `gh` і його лейбли: відсутній GitHub CLI, невхіджений `gh` чи відсутній лейбл — кожен завершує режим із помилкою і підказкою, як це виправити. Усе це налаштовується один раз у розділі [`Dark-factory: лейбли`](#dark-factory-лейбли).

## 9. Чого ще немає

- Редагування конфігу з TUI.
