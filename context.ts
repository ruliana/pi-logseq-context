/**
 * Pure logic for logseq context pages.
 * No side effects — all I/O happens in index.ts.
 */

export const LOGSEQ_DIR = `${process.env.HOME}/logseq`;
export const NAMESPACE = "AI Context";
export const NAMESPACE_SEP = "___";

export interface ContextPageParams {
	title: string;
	goal: string;
	currentState: string;
	keyDecisions: string[];
	files: string[];
	nextSteps: string[];
	references?: string[];
}

export interface ContextItem {
	/** Display title (without namespace prefix) */
	title: string;
	/** Full page name including namespace */
	pageName: string;
	/** Absolute file path */
	filePath: string;
}

/** Tracks which context was loaded in this session (set by /load-context). */
export interface LoadedContextState {
	filePath: string;
	title: string;
	pageName: string;
}

/** Options for buildContextPage when updating an existing page. */
export interface BuildPageOptions {
	/** Override the created date (preserve original on updates). */
	createdDate?: string;
	/** Add an updated:: property. */
	updatedDate?: string;
}

/**
 * Convert a title string to a filesystem-safe slug.
 * Logseq page filenames can have spaces, but we strip characters
 * that cause issues with filesystem or logseq linking.
 */
export function slugify(title: string): string {
	return title
		.trim()
		.replace(/[/\\:*?"<>|#%&{}$!@`^+='~]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Build the full logseq page name (with namespace).
 */
export function contextPageName(title: string): string {
	return `${NAMESPACE}/${slugify(title)}`;
}

/**
 * Build the file path for a context page.
 * Logseq stores namespaced pages with ___ separator.
 */
export function contextPagePath(title: string): string {
	const slug = slugify(title);
	return `${LOGSEQ_DIR}/pages/${NAMESPACE}${NAMESPACE_SEP}${slug}.md`;
}

/**
 * Build the journal file path for a given date.
 */
export function journalPath(date: Date): string {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, "0");
	const d = String(date.getDate()).padStart(2, "0");
	return `${LOGSEQ_DIR}/journals/${y}_${m}_${d}.md`;
}

/**
 * Format a date as a Logseq journal reference: YYYY-MM-DD
 */
export function journalRef(date: Date): string {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, "0");
	const d = String(date.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

/**
 * Convert page filenames to Logseq page names.
 * "SimGym.md" → "SimGym", "Neo4j___Pregel.md" → "Neo4j/Pregel"
 */
export function filenamesToPageNames(filenames: string[]): string[] {
	return filenames
		.filter((f) => f.endsWith(".md"))
		.map((f) => {
			const basename = f.endsWith(".md") ? f.slice(0, -3) : f;
			return basename.replaceAll(NAMESPACE_SEP, "/");
		})
		.sort();
}

/**
 * Extract the created:: date string from an existing context page.
 * Returns null if not found.
 */
export function extractCreatedDate(fileContent: string): string | null {
	const match = fileContent.match(/^created:: \[\[(.+?)\]\]/m);
	return match ? match[1] : null;
}

/**
 * Build the markdown content for a context page in logseq outliner format.
 */
export function buildContextPage(params: ContextPageParams, options?: BuildPageOptions): string {
	const lines: string[] = [];

	// Page properties
	lines.push(`type:: #ai-context`);
	lines.push(`tags:: #ai`);
	lines.push(`created:: [[${options?.createdDate ?? journalRef(new Date())}]]`);
	if (options?.updatedDate) {
		lines.push(`updated:: [[${options.updatedDate}]]`);
	}
	lines.push(``);

	// Goal
	lines.push(`- ## Goal`);
	lines.push(`\t- ${params.goal}`);

	// Current State
	lines.push(`- ## Current State`);
	lines.push(`\t- ${params.currentState}`);

	// Key Decisions
	if (params.keyDecisions.length > 0) {
		lines.push(`- ## Key Decisions`);
		for (const d of params.keyDecisions) {
			lines.push(`\t- ${d}`);
		}
	}

	// Files
	if (params.files.length > 0) {
		lines.push(`- ## Files`);
		for (const f of params.files) {
			lines.push(`\t- \`${f}\``);
		}
	}

	// Next Steps
	if (params.nextSteps.length > 0) {
		lines.push(`- ## Next Steps`);
		for (const s of params.nextSteps) {
			lines.push(`\t- ${s}`);
		}
	}

	// References — URLs rendered bare (Logseq auto-links), page names wrapped in [[ ]]
	if (params.references && params.references.length > 0) {
		lines.push(`- ## References`);
		for (const r of params.references) {
			if (r.startsWith("http://") || r.startsWith("https://")) {
				lines.push(`\t- ${r}`);
			} else {
				const ref = r.startsWith("[[") ? r : `[[${r}]]`;
				lines.push(`\t- ${ref}`);
			}
		}
	}

	return lines.join("\n") + "\n";
}

/**
 * Build a journal entry bullet referencing the context page.
 */
export function buildJournalEntry(title: string): string {
	const pageName = contextPageName(title);
	return `- Saved AI context: [[${pageName}]]`;
}

/**
 * Update journal content to reflect a context save.
 *
 * If an entry for this context already exists in the journal, increments
 * the update counter (e.g. "(2)" → "(3)"). Otherwise appends a new entry.
 *
 * Returns the full updated journal content.
 */
export function upsertJournalEntry(journalContent: string, title: string): string {
	const pageName = contextPageName(title);
	const ref = `[[${pageName}]]`;

	// Match an existing entry for this context: "- Saved/Updated AI context: [[...]]" with optional " (N)"
	const entryPattern = new RegExp(
		`^- (?:Saved|Updated) AI context: \\[\\[${escapeRegExp(pageName)}\\]\\](?: \\((\\d+)\\))?$`,
		"m",
	);

	const match = journalContent.match(entryPattern);
	if (match) {
		const count = match[1] ? parseInt(match[1], 10) + 1 : 2;
		const updated = `- Updated AI context: ${ref} (${count})`;
		return journalContent.replace(entryPattern, updated);
	}

	// No existing entry — append
	const entry = buildJournalEntry(title);
	const trimmed = journalContent.trimEnd();
	return trimmed.length > 0 ? `${trimmed}\n${entry}\n` : `${entry}\n`;
}

/** Escape special regex characters in a string. */
function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parse a list of context page filenames into ContextItems.
 * Expects filenames like "AI Context___Some Title.md"
 */
export function parseContextFiles(filePaths: string[]): ContextItem[] {
	const prefix = `${NAMESPACE}${NAMESPACE_SEP}`;
	return filePaths
		.filter((fp) => {
			const basename = fp.split("/").pop() ?? "";
			return basename.startsWith(prefix) && basename.endsWith(".md");
		})
		.map((fp) => {
			const basename = fp.split("/").pop()!;
			const title = basename.slice(prefix.length, -3); // remove prefix and .md
			return {
				title,
				pageName: `${NAMESPACE}/${title}`,
				filePath: fp,
			};
		})
		.sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * Extract JSON from LLM response text.
 * Handles: bare JSON, markdown-fenced JSON, or JSON embedded in prose.
 */
export function extractJSON(text: string): ContextPageParams {
	const trimmed = text.trim();

	// Try 1: parse the whole thing
	try {
		return JSON.parse(trimmed);
	} catch {
		/* continue */
	}

	// Try 2: strip markdown fences
	const fenced = trimmed.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?\s*```\s*$/m, "");
	try {
		return JSON.parse(fenced);
	} catch {
		/* continue */
	}

	// Try 3: find first { ... last } in the text
	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");
	if (firstBrace !== -1 && lastBrace > firstBrace) {
		try {
			return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
		} catch {
			/* continue */
		}
	}

	throw new SyntaxError(`Could not extract JSON from LLM response. First 200 chars: ${trimmed.slice(0, 200)}`);
}

/**
 * Build the user message that asks the LLM to extract context.
 * Conversation is wrapped in XML tags to prevent the model from
 * continuing or echoing it. The instruction comes AFTER the
 * conversation so it benefits from recency bias.
 */
export function buildExtractionPrompt(
	conversationText: string,
	options?: { extraGoal?: string; existingTitle?: string; availablePages?: string[] },
): string {
	const parts: string[] = [];

	parts.push(`<conversation>\n${conversationText}\n</conversation>`);

	if (options?.availablePages && options.availablePages.length > 0) {
		parts.push(`<available_logseq_pages>\n${options.availablePages.join("\n")}\n</available_logseq_pages>`);
	}

	if (options?.extraGoal) {
		parts.push(`<additional_focus>\n${options.extraGoal}\n</additional_focus>`);
	}

	if (options?.existingTitle) {
		parts.push(
			`This is an UPDATE to an existing context titled "${options.existingTitle}". Reuse the same title unless the scope has fundamentally changed.`,
		);
	}

	parts.push(
		`Now extract the context from the conversation above as a single JSON object. Output ONLY valid JSON, nothing else.`,
	);

	return parts.join("\n\n");
}

/**
 * The system prompt used to extract context from a conversation.
 */
export const EXTRACT_SYSTEM_PROMPT = `You extract structured context from conversations. You NEVER continue, summarize, or echo the conversation. You ONLY output a JSON object.

The context must be SELF-CONTAINED. Another AI agent will use ONLY this context to continue the work — no access to the original conversation, no guessing.

Your output must be a single valid JSON object with this exact schema — no prose, no markdown fences, no explanation before or after:

{
  "title": "short descriptive title (3-6 words)",
  "goal": "what the user is trying to accomplish (1-2 sentences)",
  "currentState": "where things stand right now (1-3 sentences)",
  "keyDecisions": ["decision 1", "decision 2"],
  "files": ["/absolute/path/to/file.ts"],
  "nextSteps": ["next step 1", "next step 2"],
  "references": ["[[Logseq Page Name]]", "https://github.com/org/repo/pull/123"]
}

Rules:
- Be terse. Every word must earn its place.
- SELF-CONTAINED: include everything another agent needs. No ambiguous references like "the plan" or "the PR".
- LINK TO EXISTING PAGES: when the conversation mentions a project, person, team, concept, or tool that matches a page in <available_logseq_pages>, use [[Page Name]] syntax in ALL text fields (goal, currentState, keyDecisions, nextSteps) — not just in references.
  Example: "Deployed [[SimGym]] with [[Roman]]'s review" — not "Deployed SimGym with Roman's review".
  Match page names case-sensitively. Only link pages that actually appear in the available list.
- files: use FULL ABSOLUTE paths. Include all files relevant to the task: source code, plans, configs, scripts.
  If a plan or design doc is mentioned, include its path (e.g., "/home/user/project/plan.md"), not "the plan".
- When mentioning file paths in ANY text field (goal, currentState, keyDecisions, nextSteps), wrap them in backticks: \`/path/to/file.ts\`. The files array values are plain strings (no backticks) — backticks are only for paths embedded in prose.
- references: include logseq page names AND full URLs.
  PRs → full GitHub URL (e.g., "https://github.com/acme-org/repo/pull/42"), not "PR #42".
  Dashboards, docs, external resources → full URL.
  Logseq concepts → [[page name]] for pages that exist in the graph.
- keyDecisions: only decisions that affect future work.
- Omit back-and-forth, failed attempts, and irrelevant tangents.
- Output ONLY the JSON object. No text before or after it.`;
