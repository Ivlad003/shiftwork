# Tickets are Markdown files in the mattpocock-skills local tracker format

Tickets live as one Markdown file per ticket in `.scratch/<feature>/issues/NN-slug.md`, using the mattpocock-skills local tracker conventions (`Status:`, `Blocked by:`, checkboxes, `## Comments`). Shiftwork adds optional lines (`Type`, `Model`, `Skills`, `Budget`, `Verify`) that those skills ignore. The point is that `/to-spec` and `/to-tickets` can write tickets which Shiftwork then executes without conversion. It also means the tracker is plain files in git, readable and editable by any backend.

## Considered Options

- **A single `tasks.yaml`/JSON file.** Easier to write by machine, but one file for all tickets conflicts under parallel runners, and the mattpocock skills can't produce it.
- **GitHub Issues.** Needs network and auth in every shift, and doesn't work offline or in a fresh clone without credentials.
