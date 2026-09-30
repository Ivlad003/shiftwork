# Every pi shift is a separate pi process driven over RPC

The runner starts each shift as its own `pi --mode rpc --no-session` child process through pi's exported `RpcClient`. A fresh handoff is then just a new process, and it gives real isolation: a crash, a memory leak or a poisoned context can't outlive the shift. RPC rather than `--print`/`--mode json` because budgets and in-place handoffs need a live channel: `steer` to ask for a handoff note, `set_model`, `compact`, `abort`, `get_session_stats`.

## Considered Options

- **In-process `ctx.newSession()` inside a pi extension.** Rejected as the main path: it's command-only, reloads the extension module on every session, and puts every ticket in one process. The pi package may still offer it as an interactive convenience.
- **`pi -p --mode json`, one prompt per process.** Simplest, but there's no way to steer, swap the model or read stats mid-shift.
