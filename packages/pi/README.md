# pi-shiftwork

[Shiftwork](https://github.com/Ivlad003/shiftwork) for the [pi coding agent](https://pi.dev).

```bash
pi install npm:pi-shiftwork
```

Right now it adds one command, `/shift`, which shows tickets from `.scratch/<feature>/issues/*.md` and the frontier of ready ones.

In development:
- a `/shift run` loop with a fresh session per ticket
- skill tiers per model (`before_agent_start`)
- a virtual model with provider fallback
- model budgets with handoff

Status: early development.
