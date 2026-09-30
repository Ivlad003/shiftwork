# Shiftwork — автономні агенти зі свіжим контекстом для pi.dev і OpenCode

> **Shiftwork** — моделі працюють змінами: кожен тікет отримує свіжу «зміну» (новий контекст), а коли модель вичерпала свій бюджет чи ліміт, вона передає зміну (handoff) наступній моделі, зокрема від іншого провайдера.

Пакети: `shiftwork-core`, `shiftwork` (CLI), `pi-shiftwork`, `opencode-shiftwork`.

Дата: 2026-09-30 · pi `0.99.1` (npm `@earendil-works/pi-coding-agent`) · локально: Node 24.20, Claude Code 2.1.285, codex-cli 0.155.1, opencode 2.0.19

Факти нижче перевірені за документацією і вихідним кодом `earendil-works/pi` (main), якщо не сказано інше.

---

## TL;DR

| Вимога | Чи вміє pi сам | Як закрити |
|---|---|---|
| 1. Новий процес із чистим контекстом на кожну задачу + трекер задач у файлі | Частково: `pi -p --no-session` = одноразовий чистий процес; `ctx.newSession()` в розширеннях. Готового трекера немає | Свій **runner** (Node/SDK або bash) над трекером у форматі **mattpocock-skills** (`.scratch/<feature>/issues/NN-*.md`): бере frontier, на кожен тікет запускає чистий процес, оновлює `Status` |
| 2. Різні моделі на різні задачі (git → дешевша) | Так: `--model provider/id:thinking`, `model:` у frontmatter субагентів, virtual models | Мапа `type → model` у трекері; runner підставляє `--model` |
| 3. JEV | Так: Jev — класифікатор від TypeSafe, вбудований у pi як "classifier model" | Jev автоматично визначає тип і складність задачі, якщо в неї не вказано `type`/`model` |
| 4. auto_compact для кожної моделі окремо | Так: `compaction.modelOverrides` | Поріг задається через `reserveTokens = contextWindow − поріг` |
| 5. Claude Code, Grok, Codex, OpenCode, OpenRouter | Усі є як провайдери pi; Claude Code, Codex і OpenCode також можна запускати через їхні CLI | Абстракція **backend** у runner: `pi` (будь-який провайдер) або `claude` / `codex` / `opencode` CLI |
| 6. Групи скілів під рівень моделі | Так: `-ns` + `--skill`, `systemPromptOptions.skills` у `before_agent_start` | `skillGroups` → `tiers` → `models`, preload для слабких моделей (розділ 3a) |
| 7. Автоперемикання на іншого провайдера при лімітах | Ні: pi повторює запит на тій самій моделі, а при вичерпаному ліміті зупиняється | virtual model з fallback-ланцюжком + `agent_before_settle`; у runner-і спільний cooldown провайдерів (розділ 6a) |
| 8. Власні бюджети моделей: при перевищенні перемкнути модель і зробити handoff | Частково: є `usage`/`cost` у подіях, `getContextUsage()`, RPC `set_model`/`compact`/`steer`/`abort`/`new_session`, приклад `handoff.ts` | Бюджети модель → рівень → тікет, м'який ліміт = агент пише handoff, жорсткий = runner; режим той самий процес / новий процес / auto (розділ 6b) |

**Рекомендація:** зовнішній runner, який на кожну спробу кожної задачі запускає **окремий ОС-процес**. Ізоляція тут справжня: контекст щоразу порожній, збій одного процесу не валить увесь цикл, а бекенд для кожної задачі можна обрати свій. Пам'ять між спробами тримається тільки у файлах: тікет (`## Comments`) і git.

---

## 1. Що таке pi

Pi — мінімальний агентний harness (раніше `badlogic/pi-mono`, тепер `earendil-works/pi`). Філософія розробників — «primitives, not features»: вбудованих субагентів, plan mode і todo немає, усе це робиться через розширення (TypeScript) і пакети (`pi install npm:... | git:...`).

Режими запуску: інтерактивний TUI, `--print` (текстова відповідь і вихід), `--mode json` (NDJSON-події), `--mode rpc` (довгоживучий процес, команди через stdin), SDK (`createAgentSession`).

Конфіги:
- `~/.pi/agent/settings.json` (глобальні) і `<project>/.pi/settings.json` (проєктні)
- `~/.pi/agent/models.json` — кастомні провайдери та моделі
- `~/.pi/agent/auth.json` — ключі та OAuth-токени (не комітити!)
- `AGENTS.md` / `CLAUDE.md`, `SYSTEM.md`, skills, prompt templates

## 2. Вимога 1 — чистий контекст на задачу + трекер

### Що є в pi

- **CLI:** `pi -p --no-session --mode json --model X "Task: ..."` запускає окремий процес без історії, сесія живе лише в пам'яті. Саме так працює офіційний приклад `examples/extensions/subagent` (`args = ["--mode","json","-p","--no-session", ...]` + `spawn`).
- **Розширення:** `ExtensionCommandContext.newSession({ withSession })` плюс `sendUserMessage()` і `waitForIdle()`. Так можна зробити команду `/run-tasks`, яка всередині одного TUI для кожної задачі відкриває нову порожню сесію. Контекст при цьому чистий, але процес той самий.
- **SDK:** `createAgentSession({ sessionManager: SessionManager.inMemory() })` → `session.prompt()`, `session.subscribe()`.
- **Готові пакети Ralph-loop** (сторонні, не перевіряв):
  - `@lnilluv/pi-ralph-loop` — `RALPH.md` з `commands`, `max_iterations`, `completion_promise`, `completion_gate`, `required_outputs`, `guardrails`
  - `@rahulmutt/pi-ralph` — `/ralph`, запускає prompt-файл по колу у свіжих сесіях
  - `@pi-unipi/ralph` — цикл, який переживає перезапуск pi (`ralph_done`)
  - `pi-ralph` — оркестрація через «hats» (ролі)

Це одна задача в циклі, а не черга задач із роутингом моделей. Тобто вимоги 1+2+5 вони не закривають.

### Пропозиція: трекер у форматі mattpocock-skills (`.scratch/`)

Беремо формат локального трекера з `mattpocock-skills` (`setup-matt-pocock-skills/issue-tracker-local.md` + `to-tickets`). Тоді тікети можна генерувати скілами `/to-spec` → `/to-tickets` у Claude Code, а виконувати runner-ом у pi. Формат обидва інструменти розуміють однаково.

```
.scratch/
└── <feature-slug>/
    ├── spec.md                      # специфікація фічі
    └── issues/
        ├── 01-email-validation.md   # один тікет = один файл, номер = порядок залежностей
        ├── 02-signup-error-ui.md
        └── 03-commit-and-pr.md
```

Шаблон тікета: оригінальний шаблон `to-tickets` плюс чотири **опціональні** рядки для runner-а (`Type`, `Model`, `Skills`, `Verify`). Скіли mattpocock їх просто ігнорують.

```markdown
# 01: Валідація email у signup

**What to build:** користувач бачить помилку, якщо ввів некоректний email; бекенд відхиляє такий запит.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

**Type:** code                  <!-- runner: ключ у routing; немає → класифікує Jev -->
**Skills:** +design              <!-- runner: опціонально, додати/прибрати групи скілів -->
**Model:** anthropic/<sonnet-id> <!-- runner: опціонально, перекриває routing -->
**Verify:** `npm test -- signup` · `npm run lint`   <!-- runner: acceptance-гейти -->

- [ ] Невалідний email → 400 з повідомленням
- [ ] Форма показує помилку під полем

## Comments
<!-- runner дописує сюди звіт кожної спроби: що зроблено, лог падіння, гіпотеза -->
```

Статуси. Базові ролі взяті з `triage-labels.md` mattpocock, до них додано два робочі стани runner-а:

| Status | Хто ставить | Що робить runner |
|---|---|---|
| `needs-triage` | людина / `/triage` | пропускає |
| `ready-for-agent` | `/to-tickets` | **бере в роботу** |
| `claimed` | runner, до старту роботи | це lock: інший runner такий тікет не бере |
| `resolved` | runner, після зеленого Verify | вважає тікет виконаним, відкриває залежні |
| `needs-info` | агент (маркер `<BLOCKED/>`) або runner після N невдач | пропускає, надсилає нотифікацію |
| `ready-for-human` / `wontfix` | людина | пропускає |

Що з цього виходить:
- **Frontier** за правилами mattpocock: відкриті тікети, у яких усі `Blocked by` уже `resolved`. Серед них перемагає найменший номер.
- **Пам'ять між спробами** — секція `## Comments` у самому тікеті, тож окремий `progress/<id>.md` не потрібен.
- **Паралелізм.** Кілька тікетів із frontier можна виконувати одночасно, кожен у своєму worktree і на своїй гілці, як у `implement-spec`. Потім окремий merge-крок зливає гілки в спільну гілку PR.
- **Повний цикл:** `/grilling` → `/to-spec` → `/to-tickets` (людина підтверджує розбивку) → runner виконує frontier до кінця → `/code-review` → PR.
- Файли — звичайний Markdown у git, тож історія змін видна в diff. Для надійності runner має записувати файл атомарно (tmp + rename), а ставити `claimed` — через lock-файл.

### Цикл runner-а («виконувати, поки не завершить»)

```
loop:
  frontier = .scratch/*/issues/*.md де Status==ready-for-agent
             і кожен з Blocked by має Status==resolved
  порожній? → якщо є claimed — чекати; інакше вихід 0 (+ нотифікація «все готово»)
  t = frontier[0]  (найменший NN)
  t.Status = claimed; save()
  route = t.Model ?? routing[t.Type ?? jevClassify(t)]
  for attempt in 1..max_attempts:
      prompt = worker.md + вказівники: spec.md, файл тікета (з ## Comments)
      run СВІЖИЙ процес backend(route) у worktree тікета, з timeout
      агент повернув <BLOCKED/>? → Status=needs-info; break
      run Verify-команди + перевірити, що всі чекбокси [x]
      ok   → Status=resolved, commit, merge; break
      fail → дописати в ## Comments: спроба N, лог, гіпотеза; можлива ескалація моделі
  вичерпано → Status=needs-info, нотифікація
```

Ключова ідея: **агент не вирішує сам, що задача виконана.** Це визначають Verify-команди. Агент лише ставить `[x]` у чекбоксах і пише звіт у `## Comments`. Промпт воркеру передає **вказівники** на `spec.md` і файл тікета, а не копію їхнього змісту: принцип «context pointers» із `implement-spec`.

Мапа `routing` (тип → бекенд/модель) живе окремо, у `.pi/shiftwork.json`:

```json
{
  "maxAttempts": 3,
  "timeoutMin": 30,
  "routing": {
    "git":      { "backend": "pi",     "model": "opencode-go/<cheap-model>", "thinking": "low", "tools": "bash,read" },
    "docs":     { "backend": "pi",     "model": "openrouter/<cheap-model>",  "thinking": "low" },
    "code":     { "backend": "claude", "model": "sonnet" },
    "refactor": { "backend": "codex",  "model": "<codex-model>" },
    "research": { "backend": "pi",     "model": "xai/<grok-model>",          "thinking": "high" },
    "review":   { "backend": "pi",     "model": "anthropic/<opus-model>",    "thinking": "high" }
  },
  "escalation": ["quick", "standard", "premium"]
}
```

Команди запуску для кожного бекенда (прапорці перевірені через `--help` локально):

| backend | команда |
|---|---|
| pi | `pi -p --no-session --mode json --model <provider/id> --thinking <lvl> --append-system-prompt worker.md "<prompt>"` |
| claude | `claude -p --model <m> --output-format stream-json --append-system-prompt "$(cat worker.md)" --dangerously-skip-permissions "<prompt>"` |
| codex | `codex exec -m <m> --json -o last.txt --sandbox workspace-write "<prompt>"` |
| opencode | `opencode run -m <provider/model> --format json "<prompt>"` |

## 3. Вимога 2 — модель під тип задачі

- `--model` приймає `provider/id` і суфікс `:<thinking>` (`off|minimal|low|medium|high|xhigh|max`). Список доступних моделей — `pi --list-models [пошук]`.
- `settings.json → modelThinkingLevels` задає thinking за замовчуванням для кожної моделі.
- Субагенти (`~/.pi/agent/agents/*.md`) мають frontmatter `model:` і `tools:`. Це зручно, коли агент сам делегує, наприклад `git-agent.md` з дешевою моделлю і `tools: bash`.
- **Virtual models** (`pi.registerVirtualModel`): одна модель у виборі, а за нею роутинг на фізичні моделі залежно від фази чи стану.

Для git-задач: дешева модель, `thinking: low`, `--tools bash,read` (без `edit`/`write`), короткий timeout.

## 3a. Групи скілів під рівень моделі

Ідея: сильній моделі достатньо мінімального набору скілів, слабшій потрібно більше. Нижче — що для цього вже вміє pi і як це вбудувати в runner.

### Як pi завантажує скіли

- Pi реалізує [Agent Skills spec](https://agentskills.io/specification): скіл — це тека з `SKILL.md` (`name`, `description`, `disable-model-invocation`).
- Скіли він шукає в `~/.pi/agent/skills`, `.pi/skills`, `~/.agents/skills`, `.agents/skills`, а також у `settings.json → skills` і в пакетах.
- На старті в system prompt потрапляють **лише name + description + шлях** кожного скіла. Повний `SKILL.md` модель читає сама, коли вирішить, що він потрібен.
- Документація pi прямо попереджає: *«A model might fail to load a relevant skill»*. Слабкі моделі частіше за сильні не підтягують скіл, коли він потрібен.

Звідси два висновки:
1. Для сильної моделі зайві скіли переважно шум у виборі, а не великі витрати токенів. Мінімальний набір тут про фокус.
2. Для слабкої моделі мало просто дати більше скілів. Ключові скіли краще **вбудовувати в промпт одразу** (preload), а не чекати, що модель завантажить їх сама.

### Механізми фільтрації (перевірено в коді pi 0.99.1)

| Де | Як |
|---|---|
| **CLI** (runner) | `pi -ns --skill <dir1> --skill <dir2> ...`. `--no-skills` вимикає всі знайдені та налаштовані скіли, *«Explicit `--skill` paths still load»* |
| **Preload** (runner) | `--append-system-prompt <тіло SKILL.md>`: скіл одразу в контексті, завантажувати його модель не мусить |
| **Розширення** (TUI, модель можна міняти посеред сесії) | `pi.on("before_agent_start", (e, ctx) => { e.systemPromptOptions.skills = e.systemPromptOptions.skills?.filter(s => allowed(ctx.model, s.name)) })`: поле `systemPromptOptions.skills` можна змінювати, `ctx.model` — поточна модель |
| **SDK** | `DefaultResourceLoader({ skillsOverride: (cur) => ({ skills: cur.skills.filter(...), diagnostics: cur.diagnostics }) })` |
| `settings.json → skills` | Глоби, `!pattern`, `+path`, `-path`. Діє статично для всіх моделей, тому для роутингу не підходить |

### Конфіг: групи → рівні → моделі (`.pi/shiftwork.json`)

```json
{
  "skillSources": [
    "~/.agents/skills",
    ".agents/skills",
    "~/.claude/plugins/cache/claude-plugins-official/mattpocock-skills/1.2.3/skills"
  ],
  "skillGroups": {
    "core":     ["tdd", "diagnosing-bugs"],
    "git":      ["resolving-merge-conflicts", "git-conventions"],
    "design":   ["codebase-design", "domain-modeling"],
    "guidance": ["writing-for-agents", "project-conventions", "testing-patterns"]
  },
  "tiers": {
    "premium":  { "skills": ["core"] },
    "standard": { "skills": ["core", "git", "design"] },
    "quick":    { "skills": ["core", "git", "design", "guidance"], "preload": ["project-conventions"] }
  },
  "models": {
    "anthropic/<opus-id>":        "premium",
    "openai/<gpt-id>":            "premium",
    "claude:sonnet":              "standard",
    "xai/<grok-id>":              "standard",
    "opencode-go/<cheap-id>":     "quick",
    "openrouter/<cheap-id>":      "quick"
  },
  "routing": {
    "git":  { "backend": "pi", "model": "opencode-go/<cheap-id>", "thinking": "low", "skills": ["git"] },
    "code": { "backend": "claude", "model": "sonnet" }
  }
}
```

Групи задаються по імені скіла, а runner знаходить потрібну теку в `skillSources`.

**Набір скілів для запуску** складається в такому порядку, від найсильнішого джерела до найслабшого:
1. рядок `**Skills:** +design -git` у тікеті (додати або прибрати групу для конкретної задачі);
2. `routing[type].skills` — якщо заданий, **замінює** набір від рівня (для git потрібні git-скіли, а не всі);
3. `tiers[models[model]].skills` — набір за замовчуванням для рівня моделі;
4. модель без рівня отримує `standard`, а runner виводить попередження.

Скіли з `preload` вбудовуються в промпт повністю, решта підключається як звичайно (name + description).

При ескалації моделі (quick → premium) набір скілів перераховується разом із рівнем.

### Як передати набір кожному бекенду

| backend | Як обмежити скіли | Статус |
|---|---|---|
| pi | `-ns` + `--skill <dir>` для кожного скіла; preload через `--append-system-prompt` | ✅ перевірено в документації |
| claude | згенерувати тимчасовий плагін (`<tmp>/plugin/skills/<name>` → symlink) і передати `--plugin-dir <tmp>/plugin`; preload — `--append-system-prompt` | ⚠️ скіли з `~/.claude/skills` і встановлених плагінів, найімовірніше, все одно підтягнуться. Треба перевірити `--setting-sources`. `--bare` не підходить: там тільки API-ключ, без підписки |
| codex / opencode | symlink-и в `.agents/skills/` (або `.opencode/skills/`) усередині **worktree тікета**, лише для обраних скілів | ⚠️ не перевіряв, які теки кожен CLI сканує і чи підтягує він глобальні скіли |

Worktree на кожен тікет тут дуже доречний: runner збирає в ньому свою теку скілів під конкретний запуск, і різні тікети не заважають один одному.

Для ручної роботи в TUI це робить розширення `.pi/extensions/skill-tiers.ts`. Воно читає ту саму `shiftwork.json` і в `before_agent_start` фільтрує `systemPromptOptions.skills` за `ctx.model`. Тому набір скілів змінюється відразу після `/model`.

## 4. Вимога 3 — JEV

**Jev** — класифікаційна модель від **TypeSafe** («System One»). Вона не спілкується в чаті, а відповідає на типізовані запитання про JSON-стан: `choice`, `bool`, `score`, з імовірностями. У pi вона вбудована як *classifier model*:

| Провайдер | Model ID | Auth |
|---|---|---|
| `typesafe` | `jev-latest` | `TYPESAFE_API_KEY` |
| `openrouter` | `typesafe/jev-1.13`, `~typesafe/jev-latest` | `OPENROUTER_API_KEY` / `/login` |
| `opencode` | `jev-1.13`, **`jev-1.13-free`** | `OPENCODE_API_KEY` |
| `vercel-ai-gateway` | `typesafe-ai/jev` | `AI_GATEWAY_API_KEY` |
| `cloudflare-workers-ai` | `typesafe/jev` | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` |

Як використати:
1. **У runner-і** (через SDK або розширення): `ctx.modelRegistry.classify(jev, { state: { task }, questions: { kind: {type:"choice", criteria:{git:..., code:..., docs:...}}, complexity: {...} } })`. Відповідь визначає `routing[kind]` і thinking. Потрібно лише для задач без явного `type`.
2. **Всередині сесії:** офіційний приклад `examples/extensions/jev-router.ts` реєструє `jev/auto`. Планування йде на сильній моделі (Sol/Terra), після першого `edit`/`write` решта задачі переходить на дешеву Luna. Приклад написаний під `openai-codex`, але модель легко замінити.
3. **Готові пакети з pi.dev/packages** (сторонні): `pi-jev-model-router` (тири quick → xpremium, бюджети, OpenRouter), `win4r/pi-jev-router` (класифікує лише на межі задачі, `/route new`, режим `shadow`).

## 5. Вимога 4 — auto_compact для кожної моделі

Компакт спрацьовує, коли `contextTokens > contextWindow − reserveTokens`. Окремого налаштування «поріг N токенів» немає, тому поріг задається через `reserveTokens`:

```
reserveTokens = contextWindow − бажаний_поріг
```

`~/.pi/agent/settings.json`:

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000,
    "modelOverrides": {
      "anthropic/<sonnet-id>":        { "reserveTokens": 80000,  "keepRecentTokens": 30000 },
      "openai/<gpt-id>":              { "reserveTokens": 150000 },
      "xai/<grok-id>":                { "reserveTokens": 100000 },
      "openrouter/<cheap-id>":        { "reserveTokens": 40000,  "keepRecentTokens": 10000 }
    }
  }
}
```

- Ключ — точний `provider/modelId` з урахуванням регістру. Кожне поле береться за ланцюжком override → глобальне значення → default.
- `enabled` задається тільки глобально.
- Для virtual models ліміти рахуються за фізичною моделлю, на яку пішов запит.
- `contextWindow` кожної моделі перевіряйте через `pi --list-models` або в `models.json`. Для кастомних моделей його можна задати там само.
- Кастомна логіка компакту (наприклад, спершу зберегти `progress.md`) робиться хуком `session_before_compact` у розширенні.
- Для CLI-бекендів цей механізм не діє: Claude Code, Codex і OpenCode компактять по-своєму. При підході «одна задача = один процес» компакт рідко потрібен, і це ще один плюс такого підходу.

## 6. Вимога 5 — провайдери

| Потрібно | Провайдер у pi | Auth | Примітка |
|---|---|---|---|
| **Claude** | `anthropic` | `/login anthropic` (Claude Pro/Max OAuth) або `ANTHROPIC_API_KEY` | ⚠️ У коді pi є попередження: *«Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits.»* Тобто підписка в pi = оплата за токени з extra usage |
| **Claude Code** (у межах плану) | — | CLI `claude` | Щоб витрачати ліміти плану, а не extra usage, запускайте задачі через **`claude -p`** як backend |
| **Codex / ChatGPT** | `openai` (OAuth «ChatGPT subscription») або `OPENAI_API_KEY`; `openai-codex` позначений як *legacy* | `/login openai` | Альтернатива — CLI `codex exec` |
| **Grok** | `xai` | `XAI_API_KEY` або `/login xai` (Grok/X subscription OAuth) | |
| **OpenCode** | `opencode` (Zen), `opencode-go` (Go) | `OPENCODE_API_KEY` / `/login opencode` | Альтернатива — CLI `opencode run`; тут також є безкоштовний Jev |
| **OpenRouter** | `openrouter` | `OPENROUTER_API_KEY` або OAuth `/login` | Покриває решту моделей однією підпискою |

Секрети краще не зберігати відкритим текстом: в `auth.json` можна вказати `"key": "!pass show openrouter"`, тоді ключ береться з менеджера паролів.

## 6a. Автоперемикання на іншого провайдера при лімітах

### Як pi поводиться з помилками зараз (перевірено в коді: `packages/ai/src/utils/retry.ts`, `agent-session.ts`)

Pi ділить помилки провайдерів на дві групи, і від цього залежить, яким механізмом можна перемкнутися:

| Тип | Приклади з коду | Що робить pi |
|---|---|---|
| **Тимчасові** (retryable) | `rate.?limit`, `too many requests`, `429`, `overloaded`, `503`, `provider returned error`, мережеві збої | Повторює запит на **тій самій** моделі з експоненційною затримкою: `retry.maxRetries=3`, `baseDelayMs=2000`, до `maxAgentDelayMs=60000` |
| **Вичерпаний ліміт** (non-retryable) | `insufficient_quota`, `quota exceeded`, `billing`, `out of budget`, `subscription_sharing_usage_limit_exceeded` (ChatGPT), `GoUsageLimitError` / `FreeUsageLimitError` / `Monthly usage limit reached` (OpenCode) | **Не повторює**: хід завершується з помилкою |
| Переповнення контексту | — | Не retry, а компакт і повтор |

Сам pi на іншу модель не перемикається ніколи. Тому перемикання робиться у двох шарах.

### Шар 1 — всередині pi (бекенд `pi`, TUI і runner)

**a) Тимчасові ліміти → virtual model з ланцюжком fallback.** Під час retry роутер отримує `request.reason === "retry"` і `request.failed.message.errorMessage`. Документація прямо дозволяє: *«A retry can also switch to another model, for example when … a provider is overloaded»*.

```ts
// .pi/extensions/fallback.ts (ескіз)
const CHAIN = ["anthropic/<sonnet-id>", "xai/<grok-id>", "opencode-go/<id>", "openrouter/<id>"];
const LIMIT = /rate.?limit|too many requests|429|overloaded|quota|usage.?limit/i;

pi.registerVirtualModel<{ i: number; cooldown: Record<string, number> }>({
  provider: "fallback", id: "standard", name: "Standard (fallback)",
  thinkingLevels: ["low", "medium", "high"],
  route(req, ctx) {
    const st = req.state ?? { i: 0, cooldown: {} };
    if (req.reason === "retry" && LIMIT.test(req.failed?.message.errorMessage ?? "")) {
      st.cooldown[CHAIN[st.i].split("/")[0]] = Date.now() + 15 * 60_000;  // провайдер у cooldown
    }
    const now = Date.now();
    st.i = CHAIN.findIndex((m) => (st.cooldown[m.split("/")[0]] ?? 0) < now);   // перший вільний
    if (st.i < 0) st.i = CHAIN.length - 1;                                  // усі в cooldown → останній
    const [prov, id] = CHAIN[st.i].split("/");
    return { model: ctx.modelRegistry.find(prov, id)!, thinkingLevel: req.thinkingLevel, state: { ...st } };
  },
});
```

Щоб перемикання відбувалося одразу, а не після трьох очікувань, у `settings.json` варто поставити `"retry": { "maxRetries": 2, "baseDelayMs": 500 }` і тримати `retry.provider.maxRetries: 0`. Pi сам радить не вмикати провайдерні retry, бо вони *«can delay Pi from handling quota and usage-limit errors itself»*.

Ціна перемикання: зміна моделі посеред сесії скидає prompt cache. Для задачі, яку треба довести до кінця, це прийнятно.

**b) Вичерпані ліміти → хук `agent_before_settle`.** Для цих помилок pi не робить retry, тож роутер не отримає виклику з `reason: "retry"`. Хук `agent_before_settle` (так само `turn_end`) може *«return `continue: true` for one next model request»*. План такий:
1. хук бачить, що останнє повідомлення асистента має `stopReason: "error"` і текст, схожий на ліміт;
2. записує провайдера в cooldown (спільна мапа модуля або файл, див. нижче);
3. повертає `continue: true`;
4. наступний `route()` уже не вибере провайдера в cooldown.

Обов'язково потрібен запобіжник від зациклення: не більше `CHAIN.length` продовжень підряд. ⚠️ Чи коректно працює `continue` після error-повідомлення, треба перевірити на практиці.

**c) Готові пакети** (сторонні, не перевіряв). Спершу варто подивитися їх: може, вистачить конфігу без свого коду.
- [`pi-provider-fallback`](https://pi.dev/packages/pi-provider-fallback) — між провайдерами, реагує на transient, quota і model-unavailable помилки, має TUI-конфіг;
- [`pi-model-fallback`](https://pi.dev/packages/pi-model-fallback) — правила і cooldown: 72 год для 429, 10 хв для 5xx;
- [`pi-auto-models`](https://pi.dev/packages/pi-auto-models) — основна і запасна модель, повертається на основну, коли квота відновлюється;
- [`pi-failover`](https://github.com/gooyoung/pi-failover) — перемикання API-ключів і провайдерів.

### Шар 2 — у runner-і (усі бекенди: pi, claude, codex, opencode)

Всередині процесу `claude -p` чи `codex exec` pi нічим керувати не може. Тому runner виконує ту саму логіку на рівні запусків:

1. **Розпізнати ліміт** у виводі процесу:
   - pi `--mode json`: події `auto_retry_end` / помилка асистента з `errorMessage`;
   - claude `stream-json`: фінальний `result` з `is_error` і текстом про rate limit або usage limit;
   - codex `--json` і opencode `--format json`: error-події.

   Регулярні вирази варто взяти з pi (`retry.ts`) і доповнити тим, що з'явиться в реальних логах.
2. **Поставити провайдера в cooldown** у спільному файлі `.pi/shiftwork-state.json`. Його бачать усі паралельні воркери й наступні тікети, тож один вичерпаний ліміт не зачепить десять тікетів поспіль:
   ```json
   { "cooldown": { "claude": "2026-09-30T14:00:00Z", "openai": "2026-09-30T09:15:00Z" } }
   ```
   Час беремо з `Retry-After` чи з тексту на кшталт «resets at …», якщо він є. Інакше використовуємо значення за типом: `rateLimit` 15 хв, `usageLimit` 5 год, `quota` 24 год.
3. **Перезапустити ту саму спробу** на наступній моделі ланцюжка, у **тому самому worktree**. Така спроба **не** рахується невдалою, бо ліміт — не провал задачі. Нова модель продовжує з того, що вже є на диску, і з `## Comments` тікета. Runner дописує туди: «спроба перервана лімітом провайдера X, продовжує Y».
4. **Перерахувати скіли** (розділ 3a) під рівень нової моделі.
5. **Якщо весь ланцюжок у cooldown:** за `crossTier` перейти на сусідній рівень (`up` — дорожчий, `down` — дешевший) або чекати найближчого скидання. Тікет при цьому лишається `claimed`. Коли чекати довелося, runner надсилає нотифікацію.

Конфіг (`.pi/shiftwork.json`): у `routing` замість однієї моделі вказується ланцюжок.

```json
{
  "fallback": {
    "chains": {
      "premium":  ["claude:opus",   "openai/<gpt-id>",   "xai/<grok-id>",      "openrouter/<opus-id>"],
      "standard": ["claude:sonnet", "xai/<grok-id>",     "opencode-go/<id>",   "openrouter/<sonnet-id>"],
      "quick":    ["opencode-go/<cheap-id>", "openrouter/<cheap-id>", "xai/<fast-id>"]
    },
    "cooldown":  { "rateLimit": "15m", "usageLimit": "5h", "quota": "24h", "server": "5m" },
    "crossTier": "up",
    "payPerTokenLast": true
  },
  "routing": {
    "code": { "chain": "standard" },
    "git":  { "chain": "quick", "thinking": "low", "skills": ["git"] }
  }
}
```

Нотатки:
- `claude:sonnet` (CLI Claude Code, ліміти плану) і `anthropic/...` у pi (extra usage або API) — **різні пули лімітів**. У ланцюжку це різні провайдери, тож після вичерпання плану можна свідомо перейти на оплату за токени.
- `payPerTokenLast`: провайдери з оплатою за токени (OpenRouter, API-ключі) ставляться в кінець ланцюжка. Для них потрібен денний бюджет (розділ 7, п. 6), щоб fallback не спалив гроші вночі.
- Ланцюжки варто будувати з **різних провайдерів**: ліміт одного провайдера зазвичай діє на всі його моделі.

## 6b. Бюджети моделей: коли модель перевищила ліміт, перемкнути її і зробити handoff

Розділ 6a про ліміти **провайдера**: помилки 429 і вичерпану квоту. Тут ідеться про ліміти, які **задаємо ми самі** для моделі або тікета: токени, гроші, ходи, час, заповнення контексту, застій. Коли ліміт перевищено, runner перемикається на іншу модель і передає їй контекст (handoff) одним із двох способів:
- **у тому самому процесі:** та сама сесія, тільки модель інша;
- **у новому процесі:** свіжий контекст плюс handoff-нотатка.

### Що можна вимірювати (перевірено в pi 0.99.1)

| Метрика | Звідки береться |
|---|---|
| Токени і гроші | `usage` у кожному assistant-`message_end` (`input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, `cost.*`); у RPC — `get_session_stats` |
| Заповнення контексту | `ctx.getContextUsage()` → `{ tokens, contextWindow, percent }` |
| Ходи | події `turn_end` |
| Час | годинник runner-а |
| Застій | N ходів поспіль без змін у `git diff --stat` або з тими самими помилками |
| Невдалі Verify | лічильник runner-а |

### Як перемкнутися

| Режим | pi — у runner-і (`--mode rpc`) | pi — розширення в TUI | OpenCode V2 плагін |
|---|---|---|---|
| **Той самий процес і сесія** | RPC `set_model` → (опційно `compact` з handoff-інструкціями) → `follow_up` «continue» | `turn_end`: `await pi.setModel(next)` → (опційно `ctx.compact({customInstructions})`) → `return { continue: true }` | `ctx.session.switchModel()` → `prompt("continue")` |
| **Новий контекст** | RPC `steer` «запиши handoff» → `abort` → **новий процес** `pi --mode rpc --no-session` з handoff | тільки з команди: цикл `/run-tickets` отримує сигнал від хука → `ctx.abort()` → `ctx.newSession({ parentSession, withSession: r => r.sendUserMessage(handoff) })`. ⚠️ `newSession` доступний лише в `ExtensionCommandContext`, не в event-хуках | `ctx.session.create({ model })` + `prompt(handoff)`. Працює з будь-якого місця плагіна |
| **Інший бекенд** (pi → claude/codex) | тільки новий процес | — | — |

RPC-режим pi відкриває обидва варіанти для одного й того самого runner-а. Команди `set_model`, `compact`, `steer`, `abort`, `new_session` і `get_session_stats` є в протоколі (див. `docs/rpc-commands.md`). Так вже робить `@lnilluv/pi-ralph-loop`: він чекає ack на `set_model`, перш ніж надіслати `prompt`.

### Який режим обрати (`mode: "auto"`)

- **Той самий процес**, якщо виконано всі умови:
  - причина — **гроші, токени або ходи** (сама модель працює нормально, просто задорога чи задовга);
  - історія цінна (наприклад, посеред налагодження);
  - контекстне вікно нової моделі не менше за поточне заповнення. Якщо менше — спершу `compact` (підхід `pi-provider-fallback`).
- **Новий процес**, якщо виконано хоча б одну умову:
  - причина — **заповнений контекст, застій або повторні провали Verify** (історія «отруєна», свіжий погляд корисніший);
  - новий бекенд інший (pi → `claude -p`);
  - бекенд старої моделі — CLI без RPC.

### Handoff: хто його пише

1. **М'який ліміт** (`softLimitPct`, наприклад 80%). Runner надсилає `steer`: *«Бюджет майже вичерпано. Заверши поточний крок і допиши в тікет `### Handoff`: що зроблено, що лишилось, гіпотези, які файли зачеплено. Потім зупинись.»* Агент отримує 1–2 ходи. Так виходить найякісніший handoff, бо пише модель, яка сама все бачила.
2. **Жорсткий ліміт** (100%) або агент не встиг. Runner робить `abort` і генерує handoff сам, дешевою моделлю, так само як `examples/extensions/handoff.ts` (`serializeConversation` + `ctx.modelRegistry.complete`). На вхід іде NDJSON-лог спроби, `git diff --stat` і останні помилки Verify.
3. **Формат** узято зі скіла `handoff` (mattpocock). Handoff лише посилається на тікет, spec, коміти і diff, а не переписує їх. Секрети з нього прибираються. Він дописується в `## Comments` тікета:
   ```markdown
   ### Handoff — спроба 2, anthropic/<opus> → openai/<gpt>, причина: budget.maxCostUsd ($3.02 / $3)
   - Зроблено: валідація на бекенді (коміт a1b2c3), тести зелені
   - Лишилось: помилка під полем у формі (чекбокс 2)
   - Гіпотеза: форма не отримує `errors.email` з API — див. `useSignup`
   - Файли: див. `git diff main...ticket/01`
   ```
   Новий процес отримує в промпті лише вказівник на тікет, бо handoff уже лежить у файлі.

### Конфіг (`.pi/shiftwork.json`)

```json
{
  "budgets": {
    "default": { "maxTurns": 60, "maxWallMin": 45, "stallTurns": 8 },
    "tiers": {
      "premium":  { "maxCostUsd": 3,  "maxContextPct": 70 },
      "standard": { "maxCostUsd": 1.5, "maxTokens": 3000000 },
      "quick":    { "maxTurns": 40,  "maxContextPct": 60, "stallTurns": 5 }
    },
    "models": { "anthropic/<opus-id>": { "maxCostUsd": 5 } },
    "ticket": { "maxCostUsd": 8, "maxWallMin": 120 }
  },
  "softLimitPct": 80,
  "onExceed": {
    "maxCostUsd":    { "to": "downgrade", "mode": "same-process" },
    "maxTokens":     { "to": "downgrade", "mode": "same-process" },
    "maxTurns":      { "to": "next",      "mode": "auto" },
    "maxContextPct": { "to": "same-tier", "mode": "new-process" },
    "stallTurns":    { "to": "escalate",  "mode": "new-process" },
    "verifyFailed":  { "to": "escalate",  "mode": "new-process" },
    "maxWallMin":    { "to": "next",      "mode": "new-process" }
  }
}
```

- **Пріоритет ліміту:** модель → рівень → `default`. `ticket` — **сумарна** стеля на тікет для всіх моделей. Коли вона вичерпана, тікет отримує `needs-info` і нотифікацію, а не нову модель.
- **Значення `to`:**
  - `next` — наступна модель у fallback-ланцюжку (6a);
  - `downgrade` / `escalate` — сусідній рівень;
  - `same-tier` — інша модель того самого рівня.

  Провайдери, які зараз у cooldown (6a), пропускаються. Набір скілів перераховується під новий рівень (3a).
- **Перевизначення для тікета:** рядок `**Budget:** $2 · 50 turns` у самому тікеті.
- **Зв'язок із компактом (розділ 5):** якщо `maxContextPct` нижчий за поріг компакту, при заповненні контексту спершу спрацює handoff у новий процес, а не компакт. Handoff передає лише потрібне, а компакт ущільнює всю історію. Тому для складних тікетів вигідніше, щоб першим спрацьовував handoff.
- **Захист від пінг-понгу:** не більше N перемикань на тікет. Не повертатися на модель, з якої щойно пішли через `stallTurns` або `verifyFailed`.

## 7. Пропонована архітектура

```
shiftwork/
├── .scratch/<feature>/spec.md            # трекер у форматі mattpocock-skills
├── .scratch/<feature>/issues/NN-*.md     # один тікет = один файл; Status / Blocked by / Type / Verify
├── runner/
│   ├── run.ts                 # цикл: frontier → claim → route → spawn → verify → resolve
│   ├── tickets.ts             # парсер/запис тікетів (Status, Blocked by, чекбокси, ## Comments)
│   ├── backends.ts            # pi | claude | codex | opencode + розпізнавання лімітів у виводі
│   ├── fallback.ts            # ланцюжки, cooldown, crossTier
│   ├── budget.ts              # облік usage/cost/turns/context, м'який/жорсткий ліміт, вибір режиму
│   ├── handoff.ts             # steer «напиши handoff» або генерація дешевою моделлю → ## Comments
│   ├── jev.ts                 # класифікація тікетів без Type
│   └── worker.md              # системний промпт воркера (правила, маркери <BLOCKED/>)
├── .pi/
│   ├── shiftwork.json            # routing, maxAttempts, escalation, skillGroups/tiers/models
│   ├── extensions/skill-tiers.ts  # фільтр скілів за ctx.model у TUI
│   ├── extensions/fallback.ts     # virtual model з ланцюжком + agent_before_settle для вичерпаних лімітів
│   ├── shiftwork-state.json          # спільний cooldown провайдерів (усі воркери)
│   ├── settings.json          # compaction.modelOverrides, modelThinkingLevels
│   ├── agents/git.md          # субагент із дешевою моделлю (для ручної роботи в TUI)
│   └── extensions/tasks.ts    # опціонально: /tasks (frontier), /run-tasks, статус у футері
└── logs/<NN>/<attempt>.jsonl  # NDJSON-події кожного запуску
```

**Що ще варто додати для автономності:**
1. **git worktree на задачу.** Агенти не заважають один одному, невдалу спробу можна просто викинути, а паралельний запуск (N воркерів) стає безпечним.
2. **Acceptance-гейти.** Тести, лінт, `tsc` визначають `done`. Без них автономний цикл «завершує» задачі, які насправді не виконані.
3. **Reviewer-прохід іншою моделлю** (наприклад, Opus/Grok після Sonnet) перед `done`. Робиться як окремий `type: review` у routing.
4. **`## Comments` у тікеті замість довгої історії.** Кожна спроба на старті читає ці коментарі, а в кінці дописує свій звіт.
5. **Ескалація моделі.** Після N невдач задача йде на сильнішу модель (`quick → standard → premium`). Jev-оцінка складності задає стартовий тир.
6. **Ліміти.** `max_attempts`, timeout на процес, денний бюджет (usage/cost є в JSON-подіях pi), kill switch-файл `STOP`.
7. **Статус `needs-info`.** Агент може чесно сказати, що йому бракує інформації. Такий тікет runner пропускає, а не крутить у циклі без кінця.
8. **Нотифікації** (`notify-send`, Telegram), коли черга порожня або задача впала.
9. **Запуск у tmux або systemd user unit**, щоб runner переживав закриття терміналу.
10. **Guardrails.** Приклади `permission-gate.ts` і `protected-paths.ts` з pi. Для CLI-бекендів — sandbox-режим (`codex --sandbox workspace-write`) або контейнер (`docs/containerization.md`).

### Чому не просто розширення всередині pi?

`ctx.newSession()` справді дає чистий контекст, але:
- усе працює в одному процесі, тож витік пам'яті чи збій валить увесь цикл;
- немає бекендів `claude` / `codex` / `opencode`;
- паралелізм складніший.

Розширення все одно корисне як **UI** до трекера: `/tasks`, `/run-tasks`, статус у футері. Саму роботу воно має передавати runner-у.

## 8. Пакет для pi і плагін для OpenCode: чи можна і що копіювати

Коротко: **так, обидва варіанти реальні.** Найкраще працює **спільне ядро (TS-бібліотека) + три тонкі адаптери**: пакет pi, плагін OpenCode V2 і CLI-runner. Готового пакета, який робить усе це разом, немає ні для pi, ні для OpenCode.

Дані для цього розділу зібрали два субагенти: вони читали вихідний код pi 0.99.1, OpenCode v2.0.19 (тег `v2.0.19`) і сторонніх репозиторіїв. Повні звіти: [`research/pi-extensions-report.md`](research/pi-extensions-report.md), [`research/opencode-plugins-report.md`](research/opencode-plugins-report.md). Ліцензії й шляхи до файлів нижче взяті з їхніх звітів. Що саме не перевірено, позначено ⚠️.

### 8.1 Архітектура

```
shiftwork/                           # monorepo
├── packages/core/                   # shiftwork-core — БЕЗ залежностей від pi/opencode
│   ├── tickets/  parse · frontier · lock (O_EXCL) · write-status · comments
│   ├── routing/  types-table · tiers · skill-groups · classify(Jev) · errors(патерни лімітів)
│   ├── fallback/ chains · cooldown-store (.pi/shiftwork-state.json)
│   └── loop/     decideNext(state) · verify
├── packages/cli/                    # shiftwork — CLI `shiftwork run`: spawn pi | claude | codex | opencode
├── packages/pi/                     # pi-shiftwork — pi-package (keywords: ["pi-package"])
│   ├── extensions/ shiftwork.ts · model-router.ts · skill-tiers.ts · limit-fallback.ts
│   ├── skills/ticket-worker/SKILL.md
│   └── agents/ implementer.md · verifier.md
└── packages/opencode/               # opencode-shiftwork — плагін OpenCode V2 (@opencode/plugin)
    └── src/ index.ts (Plugin.define) · loop.ts · fallback.ts · skills.ts
```

Логіка в ядрі спільна для всіх адаптерів: тікети, залежності, роутинг, групи скілів, cooldown і правила зупинки. Адаптери відповідають лише за дві речі: як відкрити свіжу сесію і як перемкнути модель.

### 8.2 pi: як оформити пакет

- **`package.json`:** `"keywords": ["pi-package"]`, ресурси в `"pi": { "extensions": [...], "skills": [...], "prompts": [...] }`.
  - Хостові пакети (`@earendil-works/pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui`, `typebox`) — **тільки** в `peerDependencies: "*"`, ніколи в `dependencies`.
  - Встановлення: `pi install git:…|npm:…|./local` (`-l` — для проєкту), разова проба: `pi -e`.
- **Основний шлях (runner, свіжий процес):**
  ```
  pi --mode json -p --no-session --model <m> -ns --skill <s>… --append-system-prompt <file> "<ticket>"
  ```
  Кінець роботи позначає подія `agent_settled`. `stopReason:"error"` рахуємо провалом навіть тоді, коли exit code 0.
- **Інтерактивний шлях у TUI (`/run-tickets`):**
  ```ts
  ctx.newSession({ withSession: async (r) => { await r.sendUserMessage(p); await r.waitForIdle(); } })
  ```
  Тут є дві пастки:
  - При кожному `newSession` модуль розширення перезавантажується, тож стан треба тримати в `globalThis[Symbol.for(...)]`.
  - `waitForIdle` не означає, що тікет виконано: після компакту агент може просто зупинитися. Поки Verify не зелений, runner досилає «continue», до N разів.

**Що скопіювати (усе MIT або Apache-2.0):**

| Звідки | Що саме |
|---|---|
| pi `examples/extensions/subagent/index.ts` | `getPiInvocation` (шлях до бінарника pi), NDJSON-парсер із буфером неповного рядка, `mapWithConcurrencyLimit`, SIGTERM → через 5 с SIGKILL. ⚠️ Подію `tool_result_end`, яку він слухає, pi не надсилає: результати приходять як `message_end` |
| pi `jev-router.ts` | `registerVirtualModel` + `ctx.modelRegistry.classify`. Спершу треба перевірити, що Jev реально працює: жоден пакет його не використовує |
| pi `preset.ts` | таблиця `Type → model/thinking/tools/instructions`, злиття `~/.pi/agent/*.json` з `.pi/*.json`, прапорець `--preset` |
| pi `trigger-compact.ts`, `custom-compaction.ts` | компакт за порогом власноруч; дешевий підсумок через `ctx.modelRegistry.complete` |
| pi `git-checkpoint.ts` | `git stash create` на кожному ході, щоб відкотити тікет, який провалив Verify |
| pi `file-trigger.ts` | `fs.watch` на файл `STOP` + `sendMessage(..., {triggerTurn:true})` |
| pi `permission-gate.ts`, `protected-paths.ts` | `tool_call → {block:true}`; якщо UI немає (`!ctx.hasUI`), автоматично відмовляти. Важливо для роботи без нагляду |
| `@lnilluv/pi-ralph-loop` (MIT) | свіжий `pi --mode rpc --no-session` на кожну ітерацію з очікуванням ack для `set_model`; файли-сигнали stop/cancel; `iterations.jsonl` |
| `nicobailon/pi-subagents` (MIT) | `pi-spawn.ts` (`getPiSpawnCommand`), `worktree.ts` (**git worktree на задачу**), `acceptance.ts`. Висновок у їхньому CHANGELOG: вони прибрали fallback усередині запуску на користь **нового запуску на іншій моделі**. Це збігається з нашим шаром 2 |
| `@tintinweb/pi-tasks` (MIT) | `task-store.ts`: O_EXCL lock-файл із pid+uuid і перехопленням «мертвого» lock. Готова модель для `claimed`; залежні задачі відкриваються, коли всі `blockedBy` виконано |
| `samfoy/pi-ralph` (MIT, deprecated) | чиста функція `determineNextAction` (`lib.ts`): max iterations, max runtime, виявлення застою і циклів. Прямо просить стати нашим `decideNext` |
| `eiei114/pi-model-fallback` (MIT) | cooldown, що переживає перезапуск, з `retry-after` / `x-ratelimit-reset*`; скидання при ручному `model_select`; захист від зациклення |
| `37/pi-provider-fallback` (MIT) | компакт **перед** перемиканням на модель з меншим контекстним вікном |
| `gooyoung/pi-failover` | найкраще продовження після помилки: у `message_end` переписати помилку на `stopReason:"stop"` і надіслати приховане `followUp`. ⚠️ Його виклик приватного `runtime.setRuntimeApiKey` не копіювати |
| `dev-willbird1936/pi-fallback-models` (MIT) | додаткові патерни лімітів: `usage limit`, `credit balance`, `plan limit`; виключення context overflow |

**Тільки ідеї, код не копіювати:**
- `@mjasnikovs/pi-task` (**AGPL-3.0**) — окремий verify-агент (read + bash), який повертає PASS / FAIL / UNOBSERVED. Звідти ж спостереження: дочірній процес із помилкою провайдера може завершитися з кодом 0 і порожнім текстом.
- `pi-model-auto-router` — ліцензії немає.

### 8.3 OpenCode: плагін V2

⚠️ **Головне: у тебе встановлено OpenCode V2 (2.0.19), а плагіни V1 у ньому не працюють.** Гайд міграції каже прямо: *«V1 plugin implementations do not run in V2»*. Більшість екосистеми — oh-my-opencode, fallback-плагіни, beads — написані під V1. Документація на `opencode.ai/docs/plugins` теж описує V1; актуальна для V2 лежить на `opencode.ai/v2/docs/...`.

**API V2 (`@opencode/plugin`):**
- **Структура:** `export default Plugin.define({ id, async setup(ctx) { …; return cleanup } })`.
- **Де лежать плагіни:** `.opencode/plugins/`, `~/.config/opencode/plugins/` або ключ `plugins` в `opencode.json`.
- **Свіжий контекст:** `ctx.session.create({ agent, model: {providerID, id}, permissions })`, далі `ctx.session.prompt({ sessionID, text, skills })`, `ctx.session.wait()` або події `session.execution.succeeded|failed|interrupted`.
- **Модель задається на рівні сесії, не промпту:** у `create` або через `ctx.session.switchModel()`.
- **Скіли під рівень моделі — нативно.** Правила `{ "action": "skill", "resource": "<glob>", "effect": "deny" }` у `permissions` агента **або конкретної сесії**; preload — через `prompt({ skills: [...] })`. Тут це простіше, ніж у pi.
- **Команди:** `ctx.command.transform(e => e.add({ name, execute }))` або `.opencode/commands/*.md`, де у frontmatter можна вказати `model` і `subagent: true`.
- **Стан:** `ctx.storage` (JSON get/set/scan) — щоб цикл продовжився після перезапуску.
- **Ліміти.** Помилки мають тип: `provider.rate-limit`, `provider.quota` та інші. Вбудований retry повторює запит до 10 разів із `retry-after` до 15 хв, але `quota` не повторює, а між провайдерами не перемикається взагалі. Хук `retry` може лише скасувати повтор або змінити затримку, модель він не змінює. Тому fallback будується так:
  1. отримати `session.execution.failed` із `provider.rate-limit|quota`;
  2. викликати `switchModel`;
  3. надіслати `prompt("continue", {resume:true})`.

  ⚠️ Цю послідовність ніхто не тестував наскрізь.
- **Компакт:** `compaction.auto`, `compaction.keep.tokens`, `compaction.buffer` (10% від ліміту). **Окремого порогу для кожної моделі немає.** Обхідні шляхи:
  - занизити `limit.context` моделі в `providers.<id>.models.<id>` або через `ctx.model.transform`;
  - рахувати токени з подій `session.step.*` і викликати компакт через HTTP `POST /api/session/{id}/compact`. ⚠️ У плагінному `ctx.session` методу `compact` немає.

**Що скопіювати:**

| Звідки | Версія | Що саме |
|---|---|---|
| [PatelUtkarsh/opencode-ralph-loop-v2](https://github.com/PatelUtkarsh/opencode-ralph-loop-v2) | **V2** | Основний шаблон. `src/index.ts`: `Plugin.define`, `/ralph-loop`, `/cancel-ralph`, `/ralph-status`, прибирання через AbortController. `src/loop.ts`: `ctx.event.subscribe` з фільтром за `location.directory`. `src/resume.ts`: продовження після рестарту через `ctx.storage.scan` |
| [renjfk/opencode-model-fallback](https://github.com/renjfk/opencode-model-fallback) | V1 → портувати | `lib/router.js`: переходи підписка → оплата за токени з cooldown; abort → повтор останнього повідомлення або «continue» на запасній моделі |
| [azumag/opencode-rate-limit-fallback](https://github.com/azumag/opencode-rate-limit-fallback) | V1 → портувати | режими cycle / stop / retry-last, експоненційний cooldown, метрики |
| [code-yeongyu/oh-my-opencode](https://github.com/code-yeongyu/oh-my-opencode) | V1, тільки як довідник | `hooks/runtime-fallback/` (error-classifier), `hooks/ralph-loop/` (completion-promise-detector, continuation-prompt-injector), `features/background-agent/manager.ts` (concurrency, circuit breaker), `hooks/compaction-todo-preserver` |
| [joshuadavidthomas/opencode-beads](https://github.com/joshuadavidthomas/opencode-beads) | V1 | трекер-як-файли в контексті + повторна ін'єкція після `session.compacted`. Та сама ідея, що в нас |
| [Th0rgal/open-ralph-wiggum](https://github.com/Th0rgal/open-ralph-wiggum) | CLI | найпростіший варіант: окремий `opencode run --model …` на кожну ітерацію |

Більше плагінів: [awesome-opencode](https://github.com/awesome-opencode/awesome-opencode).

### 8.4 Порівняння і рекомендація

| | pi-package | OpenCode V2 плагін | CLI-runner |
|---|---|---|---|
| Свіжий контекст | `newSession` (TUI) або spawn | `session.create` | новий процес, найнадійніше |
| Модель на тікет | `--model` / `setModel` / virtual model | модель сесії / `switchModel` | прапорець бекенда |
| Скіли за рівнем | `-ns --skill`, `systemPromptOptions.skills` | **нативні правила `skill` у `permissions`** | залежить від бекенда |
| Компакт для кожної моделі | **нативно** `compaction.modelOverrides` | тільки обхідні шляхи | залежить від бекенда |
| Fallback | virtual model (`retry`) + `message_end` / `agent_before_settle` | `execution.failed` → `switchModel` → `prompt` | cooldown-файл + перезапуск на наступній моделі |
| Бекенди claude / codex | ні | ні | **так** |
| Стабільність API | стабільне, багато прикладів | V2 новий, екосистема ще на V1 | не залежить від API |

**Порядок робіт:**
1. **core + CLI-runner** — головний двигун: він працює з усіма бекендами, зокрема з лімітами плану Claude Code.
2. **pi-package** — UI в TUI (`/tickets`, `/run-tickets`, статус) + `skill-tiers` + `model-router` + `limit-fallback`. Ці розширення корисні й тоді, коли runner запускає pi як бекенд.
3. **OpenCode V2 плагін** — за шаблоном `opencode-ralph-loop-v2`, на тому ж core. Його краще робити останнім, бо API V2 ще швидко змінюється.

Перед реалізацією треба коротко перевірити на практиці:
- `ctx.modelRegistry.classify` (Jev);
- `agent_before_settle {continue:true}` після помилки;
- `sendUserMessage` у `withSession`: чи завершується він разом із виконанням;
- `session.wait` / `prompt({resume:true})` в OpenCode V2.

## Наступні кроки

1. Встановити pi: `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`
2. `/login` для anthropic, openai, xai, opencode, openrouter; `TYPESAFE_API_KEY` або безкоштовний `opencode/jev-1.13-free`
3. `pi --list-models`: зафіксувати реальні model id і context window, заповнити `routing` і `modelOverrides`
4. Згенерувати тікети через `/to-spec` → `/to-tickets` (Local Markdown, налаштувати через `/setup-matt-pocock-skills`)
5. Написати MVP runner-а: послідовне виконання frontier, backend `pi` + `claude`, Verify, `## Comments`
6. Додати worktree, Jev-класифікацію, ескалацію моделей, паралелізм

## Джерела

- [pi.dev](https://pi.dev) · [docs](https://pi.dev/docs/latest) · [репозиторій earendil-works/pi](https://github.com/earendil-works/pi)
- [compaction.md](https://pi.dev/docs/latest/compaction) · [settings.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/settings.md) · [models.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/models.md) · [providers.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/providers.md) · [cli.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/cli.md) · [virtual-models.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/virtual-models.md) · [sdk.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md)
- [subagent extension](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions/subagent) · [PR #10035 Virtual models](https://github.com/earendil-works/pi/pull/10035)
- [pi-jev-model-router](https://pi.dev/packages/pi-jev-model-router) · [win4r/pi-jev-router](https://github.com/win4r/pi-jev-router)
- [@lnilluv/pi-ralph-loop](https://github.com/lnilluv/pi-ralph-loop) · [rahulmutt/pi-ralph](https://github.com/rahulmutt/pi-ralph) · [@pi-unipi/ralph](https://pi.dev/packages/@pi-unipi/ralph)
- mattpocock-skills 1.2.3: `setup-matt-pocock-skills/issue-tracker-local.md`, `triage-labels.md`, `to-tickets`, `implement-spec` (локально в `~/.claude/plugins/cache/claude-plugins-official/mattpocock-skills/`)
