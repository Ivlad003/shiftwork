# Spec: ➜  shiftwork git:(main) ✗ npx shiftwork run --dark-factory sh: shiftwork: command not found

**Status:** resolved

Source: github#18 https://github.com/Ivlad003/shiftwork/issues/18
Author: Ivlad003

## Issue

`npx shiftwork run --dark-factory` from a git clone (no global `shiftwork` on PATH) fails with `sh: shiftwork: command not found`.

The planning ticket's Verify is `shiftwork tickets check <feature>`. The runner runs it via `sh -c`, and agents may run the same command. `npx` starts `bin/shiftwork.js` with node and does not leave a `shiftwork` binary on PATH. After the binary is found, `tickets check` must still read the main checkout's `.scratch` when Verify's cwd is a git worktree.


<!-- shiftwork:tickets:start -->
| NN | title | status | last route |
| -- | ----- | ------ | ---------- |
| 01 | Plan the work for github#18 | resolved | grok-4.6 |
| 02 | Put the running CLI on PATH so `npx shiftwork` can run `shiftwork` verify commands | resolved | grok-4.6 |
| 03 | `tickets check` loads the main checkout's tracker from a git worktree | ready-for-agent |  |
<!-- shiftwork:tickets:end -->
