# logseq-context

A [pi](https://github.com/nichochar/pi-coding-agent) extension that creates and loads task handoffs as [Logseq](https://logseq.com/) pages. A handoff captures the task state, goal, decisions, file groups with reasons, and references needed for another AI agent to take over without the original conversation.

## Commands

### `/create-handoff <handoff goal>`

Extracts a structured handoff from the current conversation using an LLM and writes it as a Logseq page under `~/logseq/pages/`. Also adds a journal entry referencing the handoff page.

- Runs in the background — you can keep working while it saves
- If a handoff was previously loaded via `/load-handoff`, it updates that page in place
- The argument is the handoff goal or intent and scopes what the prompt includes
- Files are grouped by the reason the next agent should read them
- No next steps are generated; the user decides the next action after loading the handoff
- The prompt prefers references over snippets: Logseq pages, docs, local paths, GitHub URLs, artifact paths, symbols, commands, tests, and other durable references

### `/update-handoff [update focus]`

Updates the handoff loaded via `/load-handoff` in the current session. It reads the existing handoff page, uses only the conversation that happened after the handoff was loaded, and writes a complete replacement page back to the same Logseq file.

- Optional argument scopes the update, for example `refresh current state only`
- Rediscovers a loaded handoff from the conversation if the extension was reloaded after `/load-handoff`
- Fails if no handoff is loaded in the current session
- Runs in the background and upserts the journal reference like `/create-handoff`

### `/load-handoff`

Opens a fuzzy-searchable selector of saved handoff pages, including legacy `AI Context` pages. Selecting one injects its content into the conversation with instructions for the agent to summarize the handoff goal and current state before continuing.

### `/load-logseq`

Opens an rg-backed selector for any Logseq markdown page under `~/logseq/pages/` or `~/logseq/journals/`. Results are rebuilt from disk as you type, matched against both file paths and Logseq page names, and sorted by most recent modification time first. Selecting a page injects its content into the conversation.

## How It Works

1. **Create**: serializes the conversation, sends it to the current model with a handoff extraction prompt, and writes a structured Logseq page with title, goal, current state, key decisions, file groups with reasons, and references
2. **Load handoff**: parses handoff pages from `~/logseq/pages/`, including legacy `AI Context___*.md` pages, presents them in a selector, and injects the selected page as a follow-up message
3. **Update handoff**: reads the loaded handoff page and updates it from the conversation entries after the load point, excluding the injected handoff content itself
4. **Load Logseq**: uses `rg --files` against `~/logseq/pages/` and `~/logseq/journals/`, filters matches with `rg` as you type, and injects the selected page as a follow-up message
5. **Journal integration**: each create/update upserts a reference in the daily journal file (`~/logseq/journals/`)
6. **Logseq page linking**: the prompt is aware of existing pages in your graph and uses `[[Page Name]]` syntax for cross-references

## Directory Structure

```
~/logseq/
├── pages/
│   └── AI Handoff___<slug>.md    # saved handoff pages
└── journals/
    └── 2025_03_21.md             # journal entries with handoff references
```

## Installation

Copy or symlink the folder into your pi extensions directory:

```bash
ln -s /path/to/logseq-context ~/.pi/agent/extensions/logseq-context
```

Pi auto-discovers extensions via the `pi.extensions` field in `package.json`.

## Configuration

Set `LOGSEQ_DIR` to override the default graph location (`~/logseq`):

```bash
# Global default
export LOGSEQ_DIR=~/my-logseq-graph

# Per-session: prefix the pi command to use a specific graph
LOGSEQ_DIR=~/work-graph pi
LOGSEQ_DIR=~/personal-graph pi
```

## Requirements

- A Logseq graph with `pages/` and `journals/` directories (defaults to `~/logseq/`)
- Optional: `logseq-lint.js` at `~/.local/bin/logseq-lint.js` for post-save formatting

## Testing

```bash
pnpm test
```

## License

MIT
