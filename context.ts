/**
 * Pure logic for handoff pages in a Tessela bundle (a folder of Markdown pages with YAML frontmatter).
 * No side effects — all I/O happens in index.ts.
 */

// One setting for the bundle location; every path below takes the directory as an optional argument for tests.
export const NOTES_DIR = process.env.TESSELA_DIR ?? `${process.env.HOME}/tessela`;
export const NAMESPACE = "AI Handoff";
export const HANDOFF_FOLDER = "ai-handoff";
export const HANDOFF_TYPE = "ai-handoff";
const HANDOFF_TAGS = ["ai", "handoff"];
// Journal days are Ronie's local days, wherever the machine clock is set.
export const TIME_ZONE = "America/Toronto";

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
	/** Add an updated: field. */
	updatedDate?: string;
}

/**
 * Clean a title for display and for the link text: drop characters that break
 * file names, Markdown links or tags.
 */
export function cleanTitle(title: string): string {
	return title
		.trim()
		.replace(/[\/\\:*?"<>|#%&{}$!@`^+='~\[\]]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Tessela file slug of a title: lowercase, whitespace runs become "-", other punctuation is dropped.
 * OKF reserves index, log and home, so those get "-page" (the importer does the same).
 */
export function slugify(title: string): string {
	const slug = cleanTitle(title)
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(/[^\p{L}\p{N}_-]/gu, "")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "");
	if (slug === "") return "untitled";
	return ["index", "log", "home"].includes(slug) ? `${slug}-page` : slug;
}

/** Full page name (with namespace), used as the title and the link text. */
export function contextPageName(title: string): string {
	return `${NAMESPACE}/${cleanTitle(title)}`;
}

/** Bundle-relative concept path of a handoff, as written in links: "/ai-handoff/<slug>.md". */
export function contextHref(title: string): string {
	return `/${HANDOFF_FOLDER}/${slugify(title)}.md`;
}

/** File path for a handoff page. */
export function contextPagePath(title: string, dir = NOTES_DIR): string {
	return `${dir}/${HANDOFF_FOLDER}/${slugify(title)}.md`;
}

/** Today's date (or the given instant's) as YYYY-MM-DD in Ronie's time zone. */
export function journalRef(date: Date): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: TIME_ZONE,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(date);
}

/** Journal file path for a given date: <dir>/journals/YYYY-MM-DD.md. */
export function journalPath(date: Date, dir = NOTES_DIR): string {
	return `${dir}/journals/${journalRef(date)}.md`;
}

/** Quote a string as a YAML double-quoted scalar. */
function yamlString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Convert a file path inside the bundle to its link target: "/folder/page.md". */
export function conceptHref(filePath: string, dir = NOTES_DIR): string {
	const prefix = dir.endsWith("/") ? dir : `${dir}/`;
	return `/${filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath}`;
}

/**
 * Concept paths of the pages the model may link to, from bundle-relative file paths.
 * Journal days, attachments, hidden folders and reserved files are left out.
 */
export function availablePagePaths(relativePaths: string[]): string[] {
	return relativePaths
		.filter((p) => p.endsWith(".md"))
		.filter((p) => !p.split("/").some((part) => part.startsWith(".")))
		.filter((p) => !p.startsWith("assets/") && !p.startsWith("journals/"))
		.filter((p) => !["index.md", "log.md"].includes(p.split("/").at(-1) ?? ""))
		.map((p) => `/${p}`)
		.sort();
}

/** Display name of a page for /load-notes: its path in the bundle without ".md". */
export function filePathToPageName(filePath: string, dir = NOTES_DIR): string {
	const prefix = dir.endsWith("/") ? dir : `${dir}/`;
	const rel = filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath;
	return rel.endsWith(".md") ? rel.slice(0, -3) : rel;
}

/** Read one scalar frontmatter field, unquoted; null when absent. */
function frontmatterField(fileContent: string, key: string): string | null {
	const block = fileContent.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
	if (!block) return null;
	const line = block[1].match(new RegExp(`^${key}:[ \\t]*(.+)$`, "m"));
	if (!line) return null;
	const raw = line[1].trim();
	if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
		return raw.slice(1, -1).replace(/\\(["\\])/g, "$1");
	}
	return raw.replace(/^'(.*)'$/, "$1");
}

/** Extract the created: date from an existing handoff page. Returns null if not found. */
export function extractCreatedDate(fileContent: string): string | null {
	return frontmatterField(fileContent, "created");
}

/**
 * Turn [[Page Name]] into [Page Name](/page-name.md) outside code spans. The model is told to write
 * Markdown links, but Tessela has no wikilinks, so a stray one must not reach the page.
 */
export function wikilinksToLinks(text: string): string {
	return text
		.split(/(`[^`]*`)/)
		.map((part, i) =>
			i % 2 === 1
				? part
				: part.replace(/\[\[([^\]\n]+?)\]\]/g, (_m, name: string) => {
						const label = name.trim();
						const folders = label.split("/").map((seg) => slugify(seg));
						return `[${label}](/${folders.join("/")}.md)`;
					}),
		)
		.join("");
}

/** One Markdown list item; later lines of the text stay inside the item. */
function bullet(text: string, depth: number): string {
	const indent = "  ".repeat(depth);
	// Blank lines would end the item, so they are dropped.
	const lines = wikilinksToLinks(text.trim()).split(/\r?\n/).filter((l) => l.trim() !== "");
	return lines.map((line, i) => (i === 0 ? `${indent}- ${line}` : `${indent}  ${line.trim()}`)).join("\n");
}

/** A reference line: URLs and Markdown links stay; [[Page]] or a bare page name become a Markdown link. */
function referenceItem(ref: string): string {
	const r = ref.trim();
	if (/^https?:\/\//.test(r) || /^\[[^\]]*\]\([^)]*\)$/.test(r)) return bullet(r, 0);
	if (/^\/.*\.md$/.test(r)) return bullet(`[${r.slice(1, -3)}](${r})`, 0);
	const name = r.replace(/^\[\[/, "").replace(/\]\]$/, "");
	return bullet(wikilinksToLinks(`[[${name}]]`), 0);
}

/**
 * Build the markdown content for a handoff page: YAML frontmatter, then plain Markdown
 * (bold section labels, each followed by a list).
 */
export function buildContextPage(params: ContextPageParams, options?: BuildPageOptions): string {
	const lines: string[] = [];

	lines.push(`---`);
	lines.push(`type: ${HANDOFF_TYPE}`);
	lines.push(`title: ${yamlString(contextPageName(params.title))}`);
	lines.push(`tags: [${HANDOFF_TAGS.map((t) => `"${t}"`).join(", ")}]`);
	lines.push(`created: ${yamlString(options?.createdDate ?? journalRef(new Date()))}`);
	if (options?.updatedDate) {
		lines.push(`updated: ${yamlString(options.updatedDate)}`);
	}
	lines.push(`---`);
	lines.push(``);

	return lines.join("\n") + "\n" + buildContextBody(params);
}

/**
 * Rewrite an existing handoff page: the body comes from `params`, the frontmatter lines stay as
 * they are (Tessela keeps unknown keys on every write) except a refreshed `updated` and any missing handoff tag.
 * Returns null when the file has no frontmatter block to preserve.
 */
export function updateContextPage(existing: string, params: ContextPageParams, updatedDate: string): string | null {
	const block = existing.match(/^---(\r?\n)([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
	if (!block) return null;
	const eol = block[1];
	const cr = eol === "\r\n" ? "\r" : "";
	const lines = block[2].split("\n");
	const keyIndex = (key: string) => lines.findIndex((l) => l.startsWith(`${key}:`));
	const quoted = (tags: string[]) => tags.map((t) => `"${t}"`).join(", ");

	const updatedLine = `updated: ${yamlString(updatedDate)}${cr}`;
	const u = keyIndex("updated");
	if (u >= 0) lines[u] = updatedLine;
	else lines.push(updatedLine);

	const t = keyIndex("tags");
	if (t < 0) {
		lines.push(`tags: [${quoted(HANDOFF_TAGS)}]${cr}`);
	} else {
		const inline = lines[t].slice("tags:".length).trim(); // trim also drops a CR
		let end = t + 1;
		while (end < lines.length && /^\s*-\s/.test(lines[end])) end++;
		const text = [inline, ...lines.slice(t + 1, end)].join(" ");
		const have = new Set(text.match(/[^\s\[\],"'-][^\s\[\],"']*/g) ?? []);
		const missing = HANDOFF_TAGS.filter((tag) => !have.has(tag));
		if (missing.length > 0 && inline.startsWith("[") && inline.endsWith("]")) {
			const inner = inline.slice(1, -1).trim();
			lines[t] = `tags: [${inner === "" ? quoted(missing) : `${inner}, ${quoted(missing)}`}]${cr}`;
		} else if (missing.length > 0 && inline === "") {
			lines.splice(end, 0, ...missing.map((tag) => `  - ${tag}${cr}`));
		}
	}

	return `---${eol}${lines.join("\n")}${eol}---${eol}${eol}${buildContextBody(params)}`;
}

/** The page body: bold section labels, each followed by a list. Ends with one newline. */
export function buildContextBody(params: ContextPageParams): string {
	const lines: string[] = [];

	lines.push(`**Goal**`);
	lines.push(bullet(params.goal, 0));

	lines.push(``);
	lines.push(`**Current State**`);
	lines.push(bullet(params.currentState, 0));

	if (params.keyDecisions.length > 0) {
		lines.push(``);
		lines.push(`**Key Decisions**`);
		for (const d of params.keyDecisions) lines.push(bullet(d, 0));
	}

	if (params.files.length > 0) {
		lines.push(``);
		lines.push(`**Files**`);
		for (const group of params.files) {
			lines.push(bullet(group.reason, 0));
			for (const filePath of group.paths) lines.push(`  - \`${filePath}\``);
		}
	}

	if (params.references && params.references.length > 0) {
		lines.push(``);
		lines.push(`**References**`);
		for (const r of params.references) lines.push(referenceItem(r));
	}

	return lines.join("\n") + "\n";
}

/** Journal entry list item that links to the handoff page. */
export function buildJournalEntry(title: string, link = `[${contextPageName(title)}](${contextHref(title)})`, marker = "-"): string {
	return `${marker} Created AI handoff: ${link}`;
}

/** Frontmatter for a journal file that does not exist yet. */
export function journalFrontmatter(ref: string): string {
	return `---\ntype: journal\ntitle: ${yamlString(ref)}\ndate: ${yamlString(ref)}\n---\n`;
}

/**
 * Update journal content to reflect a handoff create/update.
 *
 * An empty journal becomes a new journal file with frontmatter. If an entry for this handoff
 * already exists, its update counter goes up (e.g. "(2)" → "(3)"); otherwise the entry is appended.
 * `options.pageName` and `options.href` name an existing handoff (an update of a loaded page).
 *
 * Returns the full updated journal content.
 */
export function upsertJournalEntry(
	journalContent: string,
	title: string,
	options?: { pageName?: string; href?: string; date?: string },
): string {
	const pageName = options?.pageName ?? contextPageName(title);
	const href = options?.href ?? contextHref(title);
	const link = `[${pageName}](${href})`;

	// Match an existing entry for this handoff with optional " (N)"; the leading "- " is optional (imported journals have bare lines).
	const entryPattern = new RegExp(
		`^([-*+] )?(?:Created|Updated) AI handoff: \\[[^\\]\\n]*\\]\\(${escapeRegExp(href)}\\)(?: \\((\\d+)\\))?$`,
		"m",
	);

	const match = journalContent.match(entryPattern);
	if (match) {
		const count = match[2] ? parseInt(match[2], 10) + 1 : 2;
		// A replacer function: a string would expand "$1", "$&" and similar patterns in the title.
		return journalContent.replace(entryPattern, () => `${match[1] ?? ""}Updated AI handoff: ${link} (${count})`);
	}

	const base = journalContent.trim() === "" ? `${journalFrontmatter(options?.date ?? journalRef(new Date()))}\n` : journalContent;
	const eol = base.includes("\r\n") ? "\r\n" : "\n";
	const withNewline = base.endsWith("\n") ? base : base + eol;
	const lines = withNewline.replace(/(?:\r?\n)+$/, "").split("\n").map((l) => l.replace(/\r$/, ""));
	const lastLine = lines.at(-1) ?? "";

	// Handoff lines stay together, in the same list.
	const previous = lastLine.match(/^([-*+]) (?:Created|Updated) AI handoff: /);
	if (previous) {
		return `${withNewline.replace(/(?:\r?\n)+$/, "")}${eol}${buildJournalEntry(title, link, previous[1])}${eol}`;
	}

	// Any other line gets a blank line first. A blank line alone does not end a list, and a list under a
	// paragraph (such as Daily TODO) would adopt the entry, so after a list the entry uses another bullet marker.
	const anchor = [...lines].reverse().find((l) => l.trim() !== "" && !/^\s/.test(l)) ?? "";
	const listMarker = anchor.match(/^([-*+]) /)?.[1];
	const marker = listMarker === "-" ? "*" : "-";
	const gap = /\n\r?\n$/.test(withNewline) ? "" : eol;
	return `${withNewline}${gap}${buildJournalEntry(title, link, marker)}${eol}`;
}

/** Escape special regex characters in a string. */
function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Pull the display title out of a handoff page: its frontmatter title without the "AI Handoff/" prefix. */
export function handoffTitle(fileContent: string, fallback: string): string {
	const title = frontmatterField(fileContent, "title");
	if (!title) return fallback;
	return title.startsWith(`${NAMESPACE}/`) ? title.slice(NAMESPACE.length + 1) : title;
}

/**
 * Parse the files of the handoff folder into ContextItems.
 * `readFile` returns a file's text; a failed read falls back to the file name as the title.
 */
export function parseContextFiles(filePaths: string[], readFile: (filePath: string) => string): ContextItem[] {
	return filePaths
		.filter((fp) => fp.endsWith(".md"))
		.map((fp) => {
			const basename = (fp.split("/").pop() ?? "").slice(0, -3);
			let content = "";
			try {
				content = readFile(fp);
			} catch {
				/* file may have vanished; use the file name */
			}
			const title = handoffTitle(content, basename);
			return { title, pageName: `${NAMESPACE}/${title}`, filePath: fp };
		})
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
		parts.push(`<available_pages>\n${options.availablePages.join("\n")}\n</available_pages>`);
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
		parts.push(`<available_pages>\n${options.availablePages.join("\n")}\n</available_pages>`);
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
  "references": ["[Page Title](/page-slug.md)", "https://github.com/org/repo/pull/123"]
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
		id: "page-links",
		text: `- LINK TO EXISTING PAGES: <available_pages> lists the concept paths of the notes. When the conversation mentions a project, person, team, concept, or tool that matches one of them, write a Markdown link [Name](/path.md) in prose text fields (goal, currentState, keyDecisions, files.reason) — not just in references. Use the path exactly as listed. Never use [[wikilinks]].
  Example: "Deployed [SimGym](/simgym.md) with [Roman](/roman-baiocco.md)'s review" — not "Deployed SimGym with Roman's review".
  Only link paths that actually appear in the available list.`,
	},
	{
		id: "file-paths",
		text: `- files: group paths by why the next agent should read them. Each files item must have a reason and paths. Include every file required to understand or continue the task: source code, tests, plans, configs, scripts, docs, generated artifacts, and screenshots.
  The reason must explain what the paths are for, e.g. "Implementation and tests for the handoff schema". Use FULL ABSOLUTE paths. If a plan or design doc is mentioned, include its path (e.g., "/Users/ronie/project/plan.md"), not "the plan".`,
	},
	{
		id: "inline-path-formatting",
		text: `- When mentioning file paths in prose text fields (goal, currentState, keyDecisions, files.reason), wrap them in backticks: \`/path/to/file.ts\`. The files[].paths values are plain strings (no backticks) — backticks are only for paths embedded in prose.`,
	},
	{
		id: "reference-first",
		text: `- Prefer references over snippets. Do not paste code, docs, logs, or transcript snippets when a stable reference can point to the source. Use exact local paths, note pages, GitHub URLs, docs URLs, Slack/thread URLs, trace URLs, symbol names, line ranges, commands, test names, and artifact paths. Include a short snippet only when no stable reference exists or a literal value is necessary.`,
	},
	{
		id: "references",
		text: `- references: include ALL note page references and URL-backed references future work depends on, using their most specific stable form.
  PRs/issues/commits → full GitHub URL (e.g., "https://github.com/acme-org/repo/pull/42"), not "PR #42".
  Dashboards, docs, Slack threads, traces, tickets, specs, external resources → full URL when present.
  Note pages → Markdown link [Name](/path.md) for pages that exist in <available_pages>.
  Non-URL identifiers without a note page (trace IDs, table names, feature flags, branch names, commands, errors) belong in goal, currentState, keyDecisions, or files.reason, not references.
  If a URL or note page reference appears in goal, currentState, keyDecisions, or files.reason, also include it in references.`,
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
		id: "datetime-format",
		text: `- Write dates as YYYY-MM-DD and datetimes with a space between date and time (2026-11-05 14:30), never with a "T". Do not write [[ ]]; the notes do not use wikilinks.`,
	},
	{
		id: "json-only",
		text: `- Output ONLY the JSON object. No text before or after it.`,
	},
] as const;

export const EXTRACT_SYSTEM_PROMPT = [
	`You create structured handoff documents from conversations. A handoff transfers task knowledge to another AI agent so the next agent can take over without the original conversation. You NEVER continue, summarize, or echo the conversation. You ONLY output a JSON object.`,
	`The handoff must be SELF-CONTAINED through exact references. Another AI agent must be able to continue the job using only this JSON and the files, URLs, IDs, pages, symbols, commands, and artifacts it names, without reading the original conversation or searching to rediscover missing references. Preserve the handoff goal, current state, decisions, constraints, exact identifiers, and references needed to resume.`,
	`Prefer stable references over copied snippets. Point to docs, note pages, local code paths, GitHub URLs, artifact paths, and other durable sources whenever they can carry the needed context.`,
	`Your output must be a single valid JSON object with this exact schema — no prose, no markdown fences, no explanation before or after:\n\n${EXTRACT_OUTPUT_SCHEMA}`,
	`Rules:\n${EXTRACT_SYSTEM_PROMPT_RULES.map((rule) => rule.text).join("\n")}`,
].join("\n\n");
