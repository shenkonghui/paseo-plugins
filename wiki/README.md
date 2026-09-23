# Wiki example

Install this directory with `paseo plugin install /absolute/path/to/plugin-examples/wiki`.

Open **Settings → Plugins → wiki → Sources** (or run **Configure wiki sources** in Command
Center), pick a project, and enable one or more directories under the project root. The
scanner lists directories that contain Markdown files (`.md`/`.mdx`), skipping hidden
directories, `node_modules`, and build output.

The **Wiki** sidebar item opens a surface with a collapsible directory tree of the
Markdown files found in the selected directories of each configured project. Tap a
file to read it — headings, bold, italic, inline code, fenced code blocks, bullets,
quotes, and links render with the host theme. `mermaid`/`flowchart` fenced blocks
render as flowcharts (the `graph`/`flowchart` subset: nodes, arrows, `[rect]`,
`(round)`, `{diamond}`, `TD` and `LR`); anything outside the subset falls back to a
plain code block. Selected directories persist per project on the host.
