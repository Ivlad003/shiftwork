# 01: Decode kitty keyboard-protocol keys (Esc, Ctrl-C) in the TUI

**What to build:** Extend `decodeKeys` in `packages/cli/src/tui-controls.js` to understand CSI-u key sequences (`ESC[<code>[;<mods>[:<event>]]u`), which pi-tui's `ProcessTerminal` makes the terminal send because it enables the kitty keyboard protocol. Today `"\x1b[27u"` (Esc) decodes to `[]`, so `esc` never closes a ticket's details (GitHub #7), and `"\x1b[99;5u"` (Ctrl-C) decodes to `[]`. Map 27 → `esc`, 13 → `enter`, 9 → `tab`, 127 → `backspace`, 99 with the Ctrl modifier (mods 5) → `"\x03"`, other printable codes without Ctrl/Alt → that character; drop release events (`:3`) and repeat keeps the key. Legacy input keeps decoding as today.

**Blocked by:** None (can start immediately)

**Status:** resolved
**Type:** code
**Verify:** `node --test packages/cli/test/tui-controls.test.js` · `npm test`

- [x] Table tests for `decodeKeys`: `"\x1b[27u"` → `["esc"]`, `"\x1b[27;1:1u"` → `["esc"]`, `"\x1b[27;1:3u"` → `[]` (release), `"\x1b[99;5u"` → `["\x03"]`, `"\x1b[13u"` → `["enter"]`, `"\x1b[110u"` → `["n"]`, a mixed chunk `"\x1b[B\x1b[27u"` → `["down", "esc"]`
- [x] A test that opens details with `enter` and closes them with the kitty Esc through `createTuiControls().handleKey` after decoding
- [x] Today's `decodeKeys` tests (legacy arrows, lone `\x1b`, enter, tab, backspace, printable) still pass

### Notes

Implemented in `packages/cli/src/tui-controls.js`: the CSI branch of `decodeKeys` now looks at the final byte — a `u` sequence is parsed by a new `decodeCsiU` helper (`<code>[;<mods>[:<event>]]`; code 27→esc, 13→enter, 9→tab, 127→backspace, 99 with Ctrl mods → `"\x03"`, other printables without Ctrl/Alt → the character; release events `:3` dropped, repeat kept; Ctrl/Alt-modified printables and control codes consumed). Legacy input is untouched. Two tests added in `packages/cli/test/tui-controls.test.js`: a CSI-u table (plus repeat, Ctrl/Alt-modified consumption, and legacy+kitty mixed chunks) and a controls-level test (`decodeKeys("\x1b[B\x1b[13u")` → enter opens `details`, `decodeKeys("\x1b[27u")` → esc closes them). Both Verify commands pass: `node --test packages/cli/test/tui-controls.test.js` (25 pass) and `npm test` (484 pass, 10 pre-existing skips, 0 fail).

## Comments

### Shift 1 — pi opencode-go/glm-5.3 (medium)
- Ended: stop
- Usage: 21404 in / 5806 out tokens, $0.0902, 10 turns
- Time: 1m 50s
- Verify: passed
- Outcome: resolved
- Landed: merged shiftwork/tui-polish-01 into main
