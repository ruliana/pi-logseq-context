# logseq-context

A [pi](https://github.com/nichochar/pi-coding-agent) extension that creates and loads task handoffs as pages in a Tessela notes bundle (a folder of Markdown pages with YAML frontmatter). A handoff captures the task state, goal, decisions, file groups with reasons, and references needed for another AI agent to take over without the original conversation.

The name is historical: the extension started on a Logseq graph and now writes to Tessela. The old `/load-logseq` command still works.

## Commands

### `/create-handoff [handoff goal]`

Extracts a structured handoff from the current conversation using an LLM and writes it as `ai-handoff/<slug>.md` in the bundle (default `~/tessela`). Also adds a line to today's journal (`journals/YYYY-MM-DD.md`, in the America/Toronto time zone) that links to the page as `[AI Handoff/<Title>](/ai-handoff/<slug>.md)`. A missing journal file is created with frontmatter.

- Runs in the background — you can keep working while it saves
- If a handoff was previously loaded via `/load-handoff`, it updates that page in place
- The argument is optional. When provided, it is the handoff goal or intent and scopes what the prompt includes; when omitted, the intent defaults to producing a handoff to continue the session later
- Files are grouped by the reason the next agent should read them
- No next steps are generated; the user decides the next action after loading the handoff
- The prompt prefers references over snippets: note pages, docs, local paths, GitHub URLs, artifact paths, symbols, commands, tests, and other durable references
- After saving, it runs `tessela lint` on the page and the journal and reports the result. It never rewrites them

### `/update-handoff [update focus]`

Updates the handoff loaded via `/load-handoff` in the current session. It reads the existing handoff page, uses only the conversation that happened after the handoff was loaded, and writes a complete replacement page back to the same file.

- Optional argument scopes the update, for example `refresh current state only`
- Rediscovers a loaded handoff from the conversation if the extension was reloaded after `/load-handoff`
- Fails if no handoff is loaded in the current session
- Runs in the background and bumps the journal line like `/create-handoff` (`Updated AI handoff: ... (2)`)

### `/load-handoff`

Opens a fuzzy-searchable selector of saved handoff pages (`ai-handoff/*.md`, shown by their frontmatter title). Selecting one injects its content into the conversation with instructions for the agent to summarize the handoff goal and current state before continuing.

### `/load-notes` (alias `/load-logseq`)

Opens an rg-backed selector for any Markdown page in the bundle, except `assets/` and hidden folders. Results are rebuilt from disk as you type, matched against the page path, and sorted by most recent modification time first. Selecting a page injects its content into the conversation.

## How It Works

1. **Create**: serializes the conversation, sends it to the current model with a handoff extraction prompt, and writes a Tessela page: frontmatter (`type: concept`, `title: "AI Handoff/<Title>"`, `tags`, `created`), then bold section labels (Goal, Current State, Key Decisions, Files, References) with lists under them
2. **Load handoff**: lists `ai-handoff/*.md`, presents them in a selector, and injects the selected page as a follow-up message
3. **Update handoff**: reads the loaded handoff page and updates it from the conversation entries after the load point, excluding the injected handoff content itself
4. **Load notes**: uses `rg --files` against the bundle, filters matches with `rg` as you type, and injects the selected page as a follow-up message
5. **Journal integration**: each create/update upserts a line in the daily journal file
6. **Page linking**: the prompt gets the concept paths of the bundle's pages (`/simgym.md`) and writes Markdown links `[SimGym](/simgym.md)`. A stray `[[wikilink]]` is converted to a Markdown link before saving

File names follow the Tessela rule: the title in lowercase, whitespace runs as `-`, other punctuation dropped (`SimGym Flat-List Prompt` becomes `simgym-flat-list-prompt.md`). `index`, `log` and `home` get `-page` added.

## Directory Structure

```
~/tessela/
├── ai-handoff/
│   └── <slug>.md             # saved handoff pages
└── journals/
    └── 2026-11-05.md         # journal days with handoff links
```

## Installation

Copy or symlink the folder into your pi extensions directory:

```bash
ln -s /path/to/logseq-context ~/.pi/agent/extensions/logseq-context
```

Pi auto-discovers extensions via the `pi.extensions` field in `package.json`.

## Configuration

Set `TESSELA_DIR` to override the default bundle location (`~/tessela`):

```bash
TESSELA_DIR=~/other-notes pi
```

## Requirements

- A Tessela bundle (defaults to `~/tessela/`) and the `tessela` CLI on `PATH`
- `../logseq-lint.ts` (the Pi agent's lint hook) for the post-save lint report. Report only: it never rewrites the handoff page or the journal.

## Testing

```bash
pnpm test
```

`acceptance.test.ts` clones `~/tessela` (or `$TESSELA_BUNDLE`) into a temp folder, saves handoffs there, and checks that `tessela lint` reports no error or warning for the new pages and journals. It is skipped when `tessela` or the bundle is missing.

## License

MIT
