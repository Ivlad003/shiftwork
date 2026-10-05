# 01: Plan the work for github#16

**What to build:** Turn GitHub issue #16 into implementation tickets for the feature `gh-16-fix-on-mac-tui`.

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** plan
**Verify:** `shiftwork tickets check gh-16-fix-on-mac-tui`

- [x] Read `.scratch/gh-16-fix-on-mac-tui/spec.md` — the issue itself, from `Source: github#16`
- [x] Investigate the repo: `CONTEXT.md`, `docs/adr/` and the code the issue touches
- [x] Write the implementation tickets `02…` under `.scratch/gh-16-fix-on-mac-tui/issues/`, following the `shiftwork` skill's ticket format — one ticket or several, as the issue needs, each `ready-for-agent` with acceptance checkboxes and `**Verify:**` commands
- [x] When the issue is unclear, end with `<shiftwork:needs-info reason="…"/>` instead of writing tickets

## Comments

### Notes

- github#16 body is the paste: `npx shiftwork tui` then `shiftwork: TuiAltScreen is not a constructor`.
- `packages/cli/src/tui.js` `interactive()` always `new TuiAltScreen(terminal, false)`. `bin/shiftwork.js` prints `shiftwork: ${error.message}`.
- Workspace pi-tui 0.99.1 exports class `TuiAltScreen`. Global `pi` 0.80.3's pi-tui exports `TUI` and not `TuiAltScreen`; `typeof kit.TuiAltScreen === "undefined"` → that TypeError. Title says mac; the miss is the export name. `npx shiftwork tui` with optional peer pi-coding-agent uses PATH pi.
- One slice: ticket 02 picks `TuiAltScreen` then `TUI` then `TuiMainScreen` when the export is a function; otherwise plain-text fallback. Existing `setLayoutRoot` vs `addChild` already matches 0.80 `TUI`.

### Shift 1 — grok grok-4.6 (medium)
- Ended: stop
- Usage: 1142456 in / 20287 out tokens, $0.2784, 16 turns
- Time: 4m 2s
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/gh-16-fix-on-mac-tui-01 into main
