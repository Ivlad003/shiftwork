# Every model change is a fresh handoff by default

Phase 1 swapped models inside the live session (`set_model`, optionally after a compaction) when cost, tokens or turns ran out and the new model's window was large enough. Dogfooding showed that the next model then inherits the previous model's context, including its dead ends, and gets no handoff note. That's the failure Shiftwork exists to avoid. Every model change now starts a fresh context with a handoff note. In-place swaps stay available only with `allowInPlace: true`.

## Consequences

- A model change always costs a prompt-cache miss and a cold start. That's accepted: a clean brief is worth more than the cache.
- Backends without in-place support (every CLI harness) need no special handling, because there is only one path.
