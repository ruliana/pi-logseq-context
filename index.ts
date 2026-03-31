/**
 * Logseq Context Extension
 *
 * /save-context — Reflect on conversation, create a logseq page with
 *                 everything needed for another AI agent to continue.
 *                 Also adds a journal entry referencing the context page.
 *                 If a context was loaded this session, updates it in place.
 *
 * /load-context — Show an fzf-style fuzzy finder of saved contexts (sorted
 *                 by recency), load the selected one into the conversation.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { complete, type Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import { Input, fuzzyFilter, matchesKey, Key, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

import {
	LOGSEQ_DIR,
	EXTRACT_SYSTEM_PROMPT,
	buildContextPage,
	buildExtractionPrompt,
	upsertJournalEntry,
	contextPagePath,
	extractCreatedDate,
	extractJSON,
	filenamesToPageNames,
	journalPath,
	journalRef,
	parseContextFiles,
	type ContextPageParams,
	type LoadedContextState,
} from "./context.ts";

/**
 * Format a timestamp as a relative time string (e.g. "5 min ago", "3 days ago").
 */
function relativeTime(mtime: Date): string {
	const seconds = Math.floor((Date.now() - mtime.getTime()) / 1000);
	if (seconds < 60) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	const months = Math.floor(days / 30);
	return `${months}mo ago`;
}

interface SaveParams {
	conversationText: string;
	availablePages: string[];
	isUpdate: boolean;
	extraGoal: string | undefined;
	snapshot: LoadedContextState | null;
	model: Parameters<typeof complete>[0];
	apiKey: string;
	headers?: Record<string, string>;
}

async function saveInBackground(
	ctx: ExtensionCommandContext,
	params: SaveParams,
): Promise<void> {
	const { conversationText, availablePages, isUpdate, extraGoal, snapshot, model, apiKey, headers } = params;

	try {
		// LLM extraction
		const userPrompt = buildExtractionPrompt(conversationText, {
			extraGoal,
			existingTitle: isUpdate ? snapshot!.title : undefined,
			availablePages,
		});

		const userMessage: Message = {
			role: "user",
			content: [{ type: "text", text: userPrompt }],
			timestamp: Date.now(),
		};

		const response = await complete(
			model,
			{ systemPrompt: EXTRACT_SYSTEM_PROMPT, messages: [userMessage] },
			{ apiKey, headers },
		);

		if (response.stopReason === "aborted") {
			ctx.ui.setWidget("save-context", undefined);
			ctx.ui.notify("Context save aborted", "info");
			return;
		}

		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();

		const extracted = extractJSON(text);
		if (!extracted) {
			ctx.ui.setWidget("save-context", undefined);
			ctx.ui.notify("Context extraction failed: could not parse LLM response", "error");
			return;
		}

		// Build page content
		let pageContent: string;
		let targetPath: string;

		if (isUpdate && snapshot) {
			let createdDate: string | undefined;
			try {
				const existing = readFileSync(snapshot.filePath, "utf-8");
				createdDate = extractCreatedDate(existing) ?? undefined;
			} catch {
				// File might have been deleted
			}
			pageContent = buildContextPage(extracted, {
				createdDate,
				updatedDate: journalRef(new Date()),
			});
			targetPath = snapshot.filePath;
		} else {
			pageContent = buildContextPage(extracted);
			targetPath = contextPagePath(extracted.title);
		}

		// Write context page
		writeFileSync(targetPath, pageContent, "utf-8");

		// Upsert journal entry
		const today = new Date();
		const jPath = journalPath(today);
		const title = isUpdate ? snapshot!.title : extracted.title;
		const existingJournal = existsSync(jPath) ? readFileSync(jPath, "utf-8") : "";
		const updatedJournal = upsertJournalEntry(existingJournal, title);
		writeFileSync(jPath, updatedJournal, "utf-8");

		// Run logseq-lint
		const linter = `${process.env.HOME}/.local/bin/logseq-lint.js`;
		for (const fp of [targetPath, jPath]) {
			try {
				execSync(`bun ${linter} --fix --root ${LOGSEQ_DIR} ${fp}`, {
					encoding: "utf-8",
					timeout: 10_000,
				});
			} catch {
				// Lint errors are non-fatal
			}
		}

		const verb = isUpdate ? "updated" : "saved";
		ctx.ui.setWidget("save-context", undefined);
		ctx.ui.notify(`Context ${verb}: ${targetPath}`, "success");
	} catch (err) {
		ctx.ui.setWidget("save-context", undefined);
		ctx.ui.notify(`Context save failed: ${err}`, "error");
	}
}

export default function (pi: ExtensionAPI) {
	/** Tracks which context was loaded via /load-context in this session. */
	let loadedContext: LoadedContextState | null = null;

	// ── /save-context ────────────────────────────────────────────────

	pi.registerCommand("save-context", {
		description: "Save conversation context as a Logseq page",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("save-context requires interactive mode", "error");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			// ── Synchronous capture (must happen before returning) ────

			const branch = ctx.sessionManager.getBranch();
			const messages = branch
				.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
				.map((entry) => entry.message);

			if (messages.length === 0) {
				ctx.ui.notify("No conversation to save", "error");
				return;
			}

			const llmMessages = convertToLlm(messages);
			const conversationText = serializeConversation(llmMessages);

			const pagesDir = `${LOGSEQ_DIR}/pages`;
			let availablePages: string[] = [];
			try {
				const filenames = readdirSync(pagesDir);
				availablePages = filenamesToPageNames(filenames);
			} catch {
				// Non-fatal — extraction works without page list
			}

			const isUpdate = loadedContext !== null;
			const extraGoal = args?.trim() || undefined;
			const model = ctx.model;
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok || !auth.apiKey) {
				ctx.ui.notify("No API key for current model", "error");
				return;
			}
			const apiKey = auth.apiKey;
			const headers = auth.headers;

			// Snapshot loadedContext before going async
			const snapshot = isUpdate ? { ...loadedContext! } : null;

			// ── Background save (non-blocking) ───────────────────────

			const statusLabel = isUpdate
				? `💾 Updating: ${snapshot!.title}`
				: "💾 Saving context…";
			ctx.ui.setWidget("save-context", (_tui, theme) => ({
				render: () => [theme.fg("dim", statusLabel)],
				invalidate: () => {},
			}), { placement: "belowEditor" });

			saveInBackground(ctx, {
				conversationText,
				availablePages,
				isUpdate,
				extraGoal,
				snapshot,
				model,
				apiKey,
				headers,
			}).catch(() => {});

			// Returns immediately — user can keep working
		},
	});

	// ── /load-context ────────────────────────────────────────────────

	pi.registerCommand("load-context", {
		description: "Load a saved context into the conversation",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("load-context requires interactive mode", "error");
				return;
			}

			// Find all context pages
			const pagesDir = `${LOGSEQ_DIR}/pages`;
			let allFiles: string[];
			try {
				allFiles = readdirSync(pagesDir).map((f) => `${pagesDir}/${f}`);
			} catch {
				ctx.ui.notify("Could not read logseq pages directory", "error");
				return;
			}

			const contexts = parseContextFiles(allFiles);

			if (contexts.length === 0) {
				ctx.ui.notify("No saved contexts found", "warning");
				return;
			}

			// Sort by file modification time (most recent first)
			const withMtime = contexts.map((c) => {
				try {
					return { ...c, mtime: statSync(c.filePath).mtime };
				} catch {
					return { ...c, mtime: new Date(0) };
				}
			});
			withMtime.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

			// Show fzf-style selector with fuzzy search
			const selected = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const topBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
				const bottomBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
				const searchInput = new Input();
				searchInput.focused = true;

				let filtered = [...withMtime];
				let selectedIdx = 0;
				let lastQuery = "";
				const maxVisible = Math.min(15, withMtime.length);

				const refilter = () => {
					const query = searchInput.getValue();
					if (query === lastQuery) return;
					lastQuery = query;
					filtered = query.trim()
						? fuzzyFilter(withMtime, query, (c) => c.title)
						: [...withMtime];
					selectedIdx = Math.min(selectedIdx, Math.max(0, filtered.length - 1));
				};

				return {
					// Focusable: propagate to Input for IME cursor positioning
					get focused() { return searchInput.focused; },
					set focused(v: boolean) { searchInput.focused = v; },

					render: (w: number) => {
						const lines: string[] = [];
						lines.push(...topBorder.render(w));
						lines.push(` ${theme.fg("accent", theme.bold("Load Context"))}`);
						lines.push(...searchInput.render(w));
						lines.push("");

						if (filtered.length === 0) {
							lines.push(theme.fg("warning", "  No matching contexts"));
						} else {
							const startIdx = Math.max(0, Math.min(
								selectedIdx - Math.floor(maxVisible / 2),
								filtered.length - maxVisible,
							));
							const endIdx = Math.min(startIdx + maxVisible, filtered.length);

							for (let i = startIdx; i < endIdx; i++) {
								const item = filtered[i]!;
								const isSelected = i === selectedIdx;
								const prefix = isSelected ? "→ " : "  ";
								const timeStr = `  ${relativeTime(item.mtime)}`;
								const titleMax = Math.max(1, w - visibleWidth(prefix) - visibleWidth(timeStr) - 1);
								const title = truncateToWidth(item.title, titleMax);
								const gap = " ".repeat(Math.max(1, w - visibleWidth(prefix) - visibleWidth(title) - visibleWidth(timeStr)));

								if (isSelected) {
									lines.push(theme.fg("accent", `${prefix}${title}${gap}`) + theme.fg("muted", timeStr));
								} else {
									lines.push(`${prefix}${title}${gap}${theme.fg("dim", timeStr)}`);
								}
							}

							if (filtered.length > maxVisible) {
								lines.push(theme.fg("dim", `  (${selectedIdx + 1}/${filtered.length})`));
							}
						}

						lines.push("");
						lines.push(theme.fg("dim", " ↑↓ navigate • type to search • enter select • esc cancel"));
						lines.push(...bottomBorder.render(w));
						return lines;
					},
					invalidate: () => {
						topBorder.invalidate();
						bottomBorder.invalidate();
						searchInput.invalidate();
					},
					handleInput: (data: string) => {
						if (matchesKey(data, Key.up)) {
							if (filtered.length > 0) {
								selectedIdx = selectedIdx === 0 ? filtered.length - 1 : selectedIdx - 1;
							}
						} else if (matchesKey(data, Key.down)) {
							if (filtered.length > 0) {
								selectedIdx = selectedIdx >= filtered.length - 1 ? 0 : selectedIdx + 1;
							}
						} else if (matchesKey(data, Key.enter)) {
							done(filtered[selectedIdx]?.filePath ?? null);
							return;
						} else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
							done(null);
							return;
						} else {
							searchInput.handleInput(data);
							refilter();
						}
						tui.requestRender();
					},
				};
			});

			if (!selected) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			// Read the context file
			let content: string;
			try {
				content = readFileSync(selected, "utf-8");
			} catch {
				ctx.ui.notify(`Could not read: ${selected}`, "error");
				return;
			}

			// Track loaded context for update-on-save
			const match = contexts.find((c) => c.filePath === selected);
			loadedContext = match
				? { filePath: match.filePath, title: match.title, pageName: match.pageName }
				: null;

			// Inject into conversation as a user message
			const contextTitle = match?.title ?? "context";
			pi.sendUserMessage(
				`Here is a saved context to continue from:\n\n<saved-context title="${contextTitle}">\n${content}\n</saved-context>\n\nRead the context above. Summarize in one sentence what was done, then list what remains to be done (if anything). Do NOT start working yet — wait for instructions.`,
				{ deliverAs: "followUp" },
			);

			ctx.ui.notify(`Loaded context: ${contextTitle}`, "success");
		},
	});
}
