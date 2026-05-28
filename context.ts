/**
 * Pure logic for Logseq handoff pages.
 * No side effects — all I/O happens in index.ts.
 */

export const LOGSEQ_DIR = process.env.LOGSEQ_DIR ?? `${process.env.HOME}/logseq`;
export const NAMESPACE = "AI Handoff";
export const LEGACY_NAMESPACES = ["AI Context"] as const;
export const NAMESPACE_SEP = "___";

export interface ContextFileGroup {
	reason: string;
	paths: string[];
}

export interface ContextPageParams {
	title: string;
	goal: string;
	currentState: string;
	keyDecisions: string[];
	files: ContextFileGroup[];
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

/** Tracks which handoff was loaded in this session (set by /load-handoff). */
export interface LoadedContextState {
	filePath: string;
	title: string;
	pageName: string;
	/** Current branch leaf before /load-handoff injected the handoff message. */
	loadedAfterEntryId: string | null;
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
 * Build the full Logseq page name (with namespace).
 */
export function contextPageName(title: string): string {
	return `${NAMESPACE}/${slugify(title)}`;
}

/**
 * Build the file path for a handoff page.
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
 * Convert a Logseq markdown file path to its page name.
 */
export function filePathToPageName(filePath: string): string {
	const parts = filePath.split("/");
	const basename = parts.at(-1) ?? "";
	const parent = parts.at(-2) ?? "";
	const withoutExt = basename.endsWith(".md") ? basename.slice(0, -3) : basename;

	if (parent === "journals") {
		const match = withoutExt.match(/^(\d{4})_(\d{2})_(\d{2})$/);
		if (match) return `${match[1]}-${match[2]}-${match[3]}`;
	}

	return withoutExt.replaceAll(NAMESPACE_SEP, "/");
}

/**
 * Extract the created:: date string from an existing handoff page.
 * Returns null if not found.
 */
export function extractCreatedDate(fileContent: string): string | null {
	const match = fileContent.match(/^created:: \[\[(.+?)\]\]/m);
	return match ? match[1] : null;
}

/**
 * Build the markdown content for a handoff page in Logseq outliner format.
 */
export function buildContextPage(params: ContextPageParams, options?: BuildPageOptions): string {
	const lines: string[] = [];

	// Page properties
	lines.push(`type:: #ai-handoff`);
	lines.push(`tags:: #ai #handoff`);
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
		for (const group of params.files) {
			lines.push(`\t- ${group.reason}`);
			for (const filePath of group.paths) {
				lines.push(`\t\t- \`${filePath}\``);
			}
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
 * Build a journal entry bullet referencing the handoff page.
 */
export function buildJournalEntry(title: string, pageName = contextPageName(title)): string {
	return `- Created AI handoff: [[${pageName}]]`;
}

/**
 * Update journal content to reflect a handoff create/update.
 *
 * If an entry for this handoff already exists in the journal, increments
 * the update counter (e.g. "(2)" → "(3)"). Otherwise appends a new entry.
 *
 * Returns the full updated journal content.
 */
export function upsertJournalEntry(
	journalContent: string,
	title: string,
	options?: { pageName?: string },
): string {
	const pageName = options?.pageName ?? contextPageName(title);
	const ref = `[[${pageName}]]`;

	// Match an existing entry for this handoff with optional " (N)".
	const entryPattern = new RegExp(
		`^- (?:(?:Created|Updated) AI handoff|(?:Saved|Updated) AI context): \\[\\[${escapeRegExp(pageName)}\\]\\](?: \\((\\d+)\\))?$`,
		"m",
	);

	const match = journalContent.match(entryPattern);
	if (match) {
		const count = match[1] ? parseInt(match[1], 10) + 1 : 2;
		const updated = `- Updated AI handoff: ${ref} (${count})`;
		return journalContent.replace(entryPattern, updated);
	}

	// No existing entry — append
	const entry = buildJournalEntry(title, pageName);
	const trimmed = journalContent.trimEnd();
	return trimmed.length > 0 ? `${trimmed}\n${entry}\n` : `${entry}\n`;
}

/** Escape special regex characters in a string. */
function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parse a list of handoff page filenames into ContextItems.
 * Supports current "AI Handoff___Some Title.md" files and legacy "AI Context___Some Title.md" files.
 */
export function parseContextFiles(filePaths: string[]): ContextItem[] {
	const namespaces = [NAMESPACE, ...LEGACY_NAMESPACES];
	return filePaths
		.map((fp) => {
			const basename = fp.split("/").pop() ?? "";
			const namespace = namespaces.find((ns) => {
				const prefix = `${ns}${NAMESPACE_SEP}`;
				return basename.startsWith(prefix) && basename.endsWith(".md");
			});
			if (!namespace) return null;

			const prefix = `${namespace}${NAMESPACE_SEP}`;
			const title = basename.slice(prefix.length, -3); // remove prefix and .md
			return {
				title,
				pageName: `${namespace}/${title}`,
				filePath: fp,
			};
		})
		.filter((item): item is ContextItem => item !== null)
		.sort((a, b) => a.title.localeCompare(b.title));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function normalizeFileGroups(value: unknown): ContextFileGroup[] {
	if (!Array.isArray(value)) return [];

	const groups: ContextFileGroup[] = [];

	for (const item of value) {
		if (!isRecord(item)) continue;

		const paths = typeof item.path === "string"
			? [item.path]
			: stringArray(item.paths ?? item.files ?? item.filePaths);
		if (paths.length === 0) continue;

		const reason = typeof item.reason === "string" ? item.reason.trim() : "";
		if (reason.length === 0) continue;
		groups.push({ reason, paths });
	}

	return groups;
}

function normalizeContextPageParams(value: unknown): ContextPageParams {
	if (!isRecord(value)) {
		throw new SyntaxError("Extracted JSON was not an object");
	}

	const normalized: ContextPageParams = {
		title: typeof value.title === "string" ? value.title : "",
		goal: typeof value.goal === "string" ? value.goal : "",
		currentState: typeof value.currentState === "string" ? value.currentState : "",
		keyDecisions: stringArray(value.keyDecisions),
		files: normalizeFileGroups(value.files),
	};

	const references = stringArray(value.references);
	if (references.length > 0) {
		normalized.references = references;
	}

	return normalized;
}

function parseContextPageJSON(text: string): ContextPageParams {
	return normalizeContextPageParams(JSON.parse(text));
}

/**
 * Extract JSON from LLM response text.
 * Handles: bare JSON, markdown-fenced JSON, or JSON embedded in prose.
 */
export function extractJSON(text: string): ContextPageParams {
	const trimmed = text.trim();

	// Try 1: parse the whole thing
	try {
		return parseContextPageJSON(trimmed);
	} catch {
		/* continue */
	}

	// Try 2: strip markdown fences
	const fenced = trimmed.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?\s*```\s*$/m, "");
	try {
		return parseContextPageJSON(fenced);
	} catch {
		/* continue */
	}

	// Try 3: find first { ... last } in the text
	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");
	if (firstBrace !== -1 && lastBrace > firstBrace) {
		try {
			return parseContextPageJSON(trimmed.slice(firstBrace, lastBrace + 1));
		} catch {
			/* continue */
		}
	}

	throw new SyntaxError(`Could not extract JSON from LLM response. First 200 chars: ${trimmed.slice(0, 200)}`);
}

/**
 * Build the user message that asks the LLM to create a handoff.
 * Conversation is wrapped in XML tags to prevent the model from
 * continuing or echoing it. The instruction comes AFTER the
 * conversation so it benefits from recency bias.
 */
export function buildExtractionPrompt(
	conversationText: string,
	options?: { handoffGoal?: string; extraGoal?: string; existingTitle?: string; availablePages?: string[] },
): string {
	const parts: string[] = [];
	const handoffGoal = options?.handoffGoal ?? options?.extraGoal;

	parts.push(`<conversation>\n${conversationText}\n</conversation>`);

	if (options?.availablePages && options.availablePages.length > 0) {
		parts.push(`<available_logseq_pages>\n${options.availablePages.join("\n")}\n</available_logseq_pages>`);
	}

	if (handoffGoal) {
		parts.push(`<handoff_goal>\n${handoffGoal}\n</handoff_goal>`);
	}

	if (options?.existingTitle) {
		parts.push(
			`This is an UPDATE to an existing handoff titled "${options.existingTitle}". Reuse the same title unless the scope has fundamentally changed.`,
		);
	}

	parts.push(
		`Now create the handoff from the conversation above as a single JSON object. Output ONLY valid JSON, nothing else.`,
	);

	return parts.join("\n\n");
}

/** Build the user message that asks the LLM to update a loaded handoff. */
export function buildUpdatePrompt(
	existingHandoff: string,
	conversationAfterLoad: string,
	options?: { handoffGoal?: string; existingTitle?: string; availablePages?: string[] },
): string {
	const parts: string[] = [];

	if (options?.existingTitle) {
		parts.push(`<existing_handoff_title>\n${options.existingTitle}\n</existing_handoff_title>`);
	}

	parts.push(`<existing_handoff>\n${existingHandoff}\n</existing_handoff>`);
	parts.push(`<conversation_after_handoff_load>\n${conversationAfterLoad}\n</conversation_after_handoff_load>`);

	if (options?.availablePages && options.availablePages.length > 0) {
		parts.push(`<available_logseq_pages>\n${options.availablePages.join("\n")}\n</available_logseq_pages>`);
	}

	if (options?.handoffGoal) {
		parts.push(`<handoff_goal>\n${options.handoffGoal}\n</handoff_goal>`);
	}

	parts.push(
		[
			`Update the existing handoff using only the conversation that happened after it was loaded.`,
			`Produce a COMPLETE replacement handoff JSON object, not a patch.`,
			`Preserve still-relevant facts from <existing_handoff>, revise stale facts contradicted by <conversation_after_handoff_load>, and add new decisions, file groups, and references from the later conversation.`,
			`Do not include next steps; the user decides the next action after loading the handoff.`,
			`Reuse the existing title unless the scope has fundamentally changed.`,
			`Output ONLY valid JSON, nothing else.`,
		].join(" "),
	);

	return parts.join("\n\n");
}

/**
 * The system prompt used to create a handoff from a conversation.
 */
const EXTRACT_OUTPUT_SCHEMA = `{
  "title": "short descriptive title (3-6 words)",
  "goal": "handoff goal or intent for the next agent (1-2 sentences)",
  "currentState": "where things stand right now (1-3 sentences)",
  "keyDecisions": ["decision 1", "decision 2"],
  "files": [
    {
      "reason": "why the next agent should read these paths",
      "paths": ["/absolute/path/to/file.ts"]
    }
  ],
  "references": ["[[Logseq Page Name]]", "https://github.com/org/repo/pull/123"]
}`;

export const EXTRACT_SYSTEM_PROMPT_RULES = [
	{
		id: "handoff-goal",
		text: `- Use <handoff_goal> as the scope and intent for the document when present. Set the JSON goal to a concise restatement of that goal, enriched only with task facts inferred from the conversation. Include context that helps the next agent achieve the handoff goal; omit context that does not affect that goal.`,
	},
	{
		id: "handoff-completeness",
		text: `- Optimize for handoff, not transcript summary. Capture the facts another agent needs to act: current goal, resolved state, constraints, open questions, exact commands/tests/results, branch names, commit hashes, issue/PR numbers, API names, table names, feature flags, environment names, and other task-specific identifiers.`,
	},
	{
		id: "concise-completeness",
		text: `- Be concise but complete. Omit conversation noise, not facts or references needed to resume.`,
	},
	{
		id: "self-contained-references",
		text: `- SELF-CONTAINED: include everything another agent needs. No ambiguous references like "the plan", "the PR", "the failing test", "that file", or "it" when the conversation contains an exact title, path, URL, command, error, or ID.`,
	},
	{
		id: "logseq-page-links",
		text: `- LINK TO EXISTING PAGES: when the conversation mentions a project, person, team, concept, or tool that matches a page in <available_logseq_pages>, use [[Page Name]] syntax in prose text fields (goal, currentState, keyDecisions, files.reason) — not just in references.
  Example: "Deployed [[SimGym]] with [[Roman]]'s review" — not "Deployed SimGym with Roman's review".
  Match page names case-sensitively. Only link pages that actually appear in the available list.`,
	},
	{
		id: "file-paths",
		text: `- files: group paths by why the next agent should read them. Each files item must have a reason and paths. Include every file required to understand or continue the task: source code, tests, plans, configs, scripts, docs, generated artifacts, and screenshots.
  The reason must explain what the paths are for, e.g. "Implementation and tests for the Logseq handoff schema". Use FULL ABSOLUTE paths. If a plan or design doc is mentioned, include its path (e.g., "/Users/ronie/project/plan.md"), not "the plan".`,
	},
	{
		id: "inline-path-formatting",
		text: `- When mentioning file paths in prose text fields (goal, currentState, keyDecisions, files.reason), wrap them in backticks: \`/path/to/file.ts\`. The files[].paths values are plain strings (no backticks) — backticks are only for paths embedded in prose.`,
	},
	{
		id: "reference-first",
		text: `- Prefer references over snippets. Do not paste code, docs, logs, or transcript snippets when a stable reference can point to the source. Use exact local paths, Logseq pages, GitHub URLs, docs URLs, Slack/thread URLs, trace URLs, symbol names, line ranges, commands, test names, and artifact paths. Include a short snippet only when no stable reference exists or a literal value is necessary.`,
	},
	{
		id: "references",
		text: `- references: include ALL Logseq page references and URL-backed references future work depends on, using their most specific stable form.
  PRs/issues/commits → full GitHub URL (e.g., "https://github.com/acme-org/repo/pull/42"), not "PR #42".
  Dashboards, docs, Slack threads, traces, tickets, specs, external resources → full URL when present.
  Logseq concepts → [[page name]] for pages that exist in the graph.
  Non-URL identifiers without a Logseq page (trace IDs, table names, feature flags, branch names, commands, errors) belong in goal, currentState, keyDecisions, or files.reason, not references.
  If a URL or Logseq page reference appears in goal, currentState, keyDecisions, or files.reason, also include it in references.`,
	},
	{
		id: "no-next-steps",
		text: `- Do NOT include next steps, proposed task lists, or future action bullets. The user decides the next action after loading the handoff. Capture current state, blockers, and decisions only.`,
	},
	{
		id: "future-decisions-only",
		text: `- keyDecisions: only decisions that affect future work.`,
	},
	{
		id: "exclude-process-noise",
		text: `- Exclude failed attempts, exploratory dead ends, back-and-forth, apologies, and irrelevant tangents. If a failed action leaves an unresolved blocker, record only the current blocker/result and its implication, not the attempt history.`,
	},
	{
		id: "json-only",
		text: `- Output ONLY the JSON object. No text before or after it.`,
	},
] as const;

export const EXTRACT_SYSTEM_PROMPT = [
	`You create structured Logseq handoff documents from conversations. A handoff transfers task knowledge to another AI agent so the next agent can take over without the original conversation. You NEVER continue, summarize, or echo the conversation. You ONLY output a JSON object.`,
	`The handoff must be SELF-CONTAINED through exact references. Another AI agent must be able to continue the job using only this JSON and the files, URLs, IDs, pages, symbols, commands, and artifacts it names, without reading the original conversation or searching to rediscover missing references. Preserve the handoff goal, current state, decisions, constraints, exact identifiers, and references needed to resume.`,
	`Prefer stable references over copied snippets. Point to docs, Logseq pages, local code paths, GitHub URLs, artifact paths, and other durable sources whenever they can carry the needed context.`,
	`Your output must be a single valid JSON object with this exact schema — no prose, no markdown fences, no explanation before or after:\n\n${EXTRACT_OUTPUT_SCHEMA}`,
	`Rules:\n${EXTRACT_SYSTEM_PROMPT_RULES.map((rule) => rule.text).join("\n")}`,
].join("\n\n");
