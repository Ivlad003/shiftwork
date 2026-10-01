# 01: Decode kitty keyboard-protocol keys (Esc, Ctrl-C) in the TUI

**What to build:** Extend `decodeKeys` in `packages/cli/src/tui-controls.js` to understand CSI-u key sequences (`ESC[<code>[;<mods>[:<event>]]u`), which pi-tui's `ProcessTerminal` makes the terminal send because it enables the kitty keyboard protocol. Today `"\x1b[27u"` (Esc) decodes to `[]`, so `esc` never closes a ticket's details (GitHub #7), and `"\x1b[99;5u"` (Ctrl-C) decodes to `[]`. Map 27 → `esc`, 13 → `enter`, 9 → `tab`, 127 → `backspace`, 99 with the Ctrl modifier (mods 5) → `"\x03"`, other printable codes without Ctrl/Alt → that character; drop release events (`:3`) and repeat keeps the key. Legacy input keeps decoding as today.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent
**Type:** code
**Verify:** `node --test packages/cli/test/tui-controls.test.js` · `npm test`

- [ ] Table tests for `decodeKeys`: `"\x1b[27u"` → `["esc"]`, `"\x1b[27;1:1u"` → `["esc"]`, `"\x1b[27;1:3u"` → `[]` (release), `"\x1b[99;5u"` → `["\x03"]`, `"\x1b[13u"` → `["enter"]`, `"\x1b[110u"` → `["n"]`, a mixed chunk `"\x1b[B\x1b[27u"` → `["down", "esc"]`
- [ ] A test that opens details with `enter` and closes them with the kitty Esc through `createTuiControls().handleKey` after decoding
- [ ] Today's `decodeKeys` tests (legacy arrows, lone `\x1b`, enter, tab, backspace, printable) still pass
