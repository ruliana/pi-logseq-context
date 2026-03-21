# logseq-context

A [pi](https://github.com/nichochar/pi-coding-agent) extension that saves and loads conversation context as [Logseq](https://logseq.com/) pages. Designed for multi-session workflows where you need to hand off context between AI conversations.

## Commands

### `/save-context [extra goal]`

Extracts structured context from the current conversation using an LLM and writes it as a Logseq page under `~/logseq/pages/`. Also adds a journal entry referencing the context page.

- Runs in the background — you can keep working while it saves
- If a context was previously loaded via `/load-context`, it updates that page in place
- Optional argument overrides the inferred goal

### `/load-context`

Opens a fuzzy-searchable selector of all saved context pages. Selecting one injects its content into the conversation with instructions for the agent to summarize the state before continuing.

## How It Works

1. **Save**: serializes the conversation, sends it to the current model with an extraction prompt, and writes a structured Logseq page with title, goal, current state, key decisions, files, next steps, and references
2. **Load**: parses context pages from `~/logseq/pages/`, presents them in a `SelectList`, and injects the selected page as a follow-up message
3. **Journal integration**: each save upserts a reference in the daily journal file (`~/logseq/journals/`)
4. **Logseq page linking**: the extraction prompt is aware of existing pages in your graph and uses `[[Page Name]]` syntax for cross-references

## Directory Structure

```
~/logseq/
├── pages/
│   └── pi-context___<slug>.md    # saved context pages
└── journals/
    └── 2025_03_21.md             # journal entries with context references
```

## Installation

Copy or symlink the folder into your pi extensions directory:

```bash
ln -s /path/to/logseq-context ~/.pi/agent/extensions/logseq-context
```

Pi auto-discovers extensions via the `pi.extensions` field in `package.json`.

## Requirements

- A Logseq graph at `~/logseq/` with `pages/` and `journals/` directories
- Optional: `logseq-lint.js` at `~/.local/bin/logseq-lint.js` for post-save formatting

## Testing

```bash
npx tsx --test context.test.ts
```

## License

MIT
