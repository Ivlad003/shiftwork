# pi-shiftwork

[Shiftwork](https://github.com/Ivlad003/shiftwork) for the [pi coding agent](https://pi.dev).

```bash
pi install npm:pi-shiftwork
```

It adds one command, `/shift`:

| Command | What it does |
|---|---|
| `/shift` | Tickets from `.scratch/<feature>/issues/*.md` and the frontier of ready ones |
| `/shift run [--feature <slug>] [--once] […]` | Starts the `shiftwork` runner detached; its output goes to `logs/runner-<timestamp>.log`. Remaining arguments are passed to `shiftwork run` |
| `/shift stop` | Writes the `STOP` file: the runner finishes the current shift, releases its claim and exits |

While a runner works, a widget above the editor shows the current ticket, shift, attempt, model and budget use, read from the runner state in `.pi/shiftwork-run.json`. The widget follows a runner started elsewhere (another pi session, or a terminal) and reports the outcome when the run ends.

The runner is the `shiftwork` CLI, resolved from the `shiftwork` package next to this one, from `./node_modules/shiftwork`, or from `SHIFTWORK_BIN` when set.

Interactive sessions use the same skill tiers as the runner: `before_agent_start` keeps only the current model's tier skill set, and follows `/model`. A model that is not in any tier keeps every skill and is told so once.

In development:
- a virtual model with provider fallback

Status: early development.
