# node-auto-trader — agent notes

## Architecture graph (read this before exploring the repo)

This project already has a prebuilt architecture/knowledge graph in `graphify-out/`.
Use it instead of blind `grep`/file-walking when you need to know how parts of the
system connect.

- `graphify-out/GRAPH_REPORT.md` — start here. Human-readable: community hubs,
  "god nodes" (core abstractions by edge count), node/edge counts.
- `graphify-out/graph.json` — the graph itself (NetworkX node-link JSON:
  `nodes`, `links`, `hyperedges`, `built_at_commit`).
- `graphify-out/graph.html` — interactive viewer, open in a browser.
- `graphify-out/manifest.json` + `cache/` — incremental-build bookkeeping. Don't edit.

### How to read / query it

The `graphify` skill is installed at user scope (`~/.claude/skills/graphify/SKILL.md`),
so it is available to every local Claude-based agent — no install step needed.

- Ask questions against the graph: `/graphify query <question>`
  (traversal details: `~/.claude/skills/graphify/references/query.md`)
- Trace a dependency chain: `/graphify path <A> <B>`
- Refresh after significant code changes: `/graphify .` (incremental, uses the manifest)

If you are on a runtime without the graphify skill, `graph.json` is plain JSON —
load it directly (`networkx.node_link_graph`) or read `GRAPH_REPORT.md`.

Caveat the report itself flags: the corpus is ~32k words, so for small questions
reading the source directly is still fine. The graph pays off for
"what touches X", "how does X reach Y", and impact-radius questions.
