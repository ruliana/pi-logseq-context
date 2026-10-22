/**
 * Logseq handoff extension.
 *
 * /create-handoff — Reflect on the conversation and create a Logseq handoff
 *                   page with everything another AI agent needs to take over.
 *                   Also adds a journal entry referencing the handoff page.
 *                   If a handoff was loaded this session, updates it in place.
 *
 * /update-handoff — Update the loaded handoff using conversation that happened
 *                   after /load-handoff injected it into the current session.
 *
 * /load-handoff — Show an fzf-style fuzzy finder of saved handoffs (sorted
 *                 by recency), load the selected one into the conversation.
 *
 * /load-logseq — Use rg to scan Logseq pages and journals as the user types,
 *                then load the selected page into the conversation.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { complete, type Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, SessionEntry } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import { Input, fuzzyFilter, matchesKey, Key, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

import {
	LOGSEQ_DIR,
	EXTRACT_SYSTEM_PROMPT,
	buildContextPage,
	buildExtractionPrompt,
	buildUpdatePrompt,
	upsertJournalEntry,
	contextPagePath,
	extractCreatedDate,
	extractJSON,
	filenamesToPageNames,
	filePathToPageName,
	journalPath,
	journalRef,
	parseContextFiles,
	type LoadedContextState,
} from "./context.ts";
import { lintSavedPages } from "./lint-saved.ts";

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

function escapeXmlAttribute(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function unescapeXmlAttribute(value: string): string {
	return value
		.replaceAll("&quot;", '"')
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&amp;", "&");
}

function xmlAttribute(attrs: string, name: string): string | null {
	const match = attrs.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
	return match?.[1] !== undefined ? unescapeXmlAttribute(match[1]) : null;
}

interface LogseqPageSearchItem {
	title: string;
	pageName: string;
	filePath: string;
	mtime: Date;
}

const MAX_LOGSEQ_SEARCH_RESULTS = 200;

function runRg(args: string[], input?: string): string[] {
	const result = spawnSync("rg", args, {
		input,
		encoding: "utf-8",
		timeout: 2_000,
		maxBuffer: 4 * 1024 * 1024,
	});

	if (result.status === 1) return [];
	if (result.status !== 0) return [];

	return result.stdout.split("\n").filter(Boolean);
}

function logseqSearchRoots(): string[] {
	return [`${LOGSEQ_DIR}/pages`, `${LOGSEQ_DIR}/journals`].filter((dir) => existsSync(dir));
}

function filterLinesWithRg(lines: string[], query: string): string[] {
	const tokens = query.trim().split(/\s+/).filter(Boolean);
	let filtered = lines;

	for (const token of tokens) {
		filtered = runRg(["--fixed-strings", "--ignore-case", "--", token], filtered.join("\n"));
		if (filtered.length === 0) break;
	}

	return filtered;
}

function searchLogseqPages(query: string): LogseqPageSearchItem[] {
	const roots = logseqSearchRoots();
	if (roots.length === 0) return [];

	const files = runRg(["--files", "-g", "*.md", "--", ...roots]);
	const searchableLines = files.map((filePath) => `${filePath}\t${filePathToPageName(filePath)}`);
	const matchingLines = query.trim() ? filterLinesWithRg(searchableLines, query) : searchableLines;
	const seen = new Set<string>();

	return matchingLines
		.map((line) => line.split("\t", 1)[0]!)
		.filter((filePath) => {
			if (seen.has(filePath)) return false;
			seen.add(filePath);
			return true;
		})
		.map((filePath) => {
			let mtime = new Date(0);
			try {
				mtime = statSync(filePath).mtime;
			} catch {
				// File may have changed between rg and stat.
			}
			const pageName = filePathToPageName(filePath);
			return { title: pageName, pageName, filePath, mtime };
		})
		.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
		.slice(0, MAX_LOGSEQ_SEARCH_RESULTS);
}

type MessageEntry = SessionEntry & { type: "message" };

function getAvailablePages(): string[] {
	const pagesDir = `${LOGSEQ_DIR}/pages`;
	try {
		return filenamesToPageNames(readdirSync(pagesDir));
	} catch {
		return [];
	}
}

function messageText(entry: MessageEntry): string {
	const content = entry.message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.filter((block): block is { type: "text"; text: string } => {
			if (!block || typeof block !== "object") return false;
			const maybeBlock = block as { type?: unknown; text?: unknown };
			return maybeBlock.type === "text" && typeof maybeBlock.text === "string";
		})
		.map((block) => block.text)
		.join("\n");
}

function messagesAfterLoadedHandoff(
	branch: SessionEntry[],
	loadedAfterEntryId: string | null,
): MessageEntry[] | null {
	const startIndex = loadedAfterEntryId === null ? -1 : branch.findIndex((entry) => entry.id === loadedAfterEntryId);
	if (loadedAfterEntryId !== null && startIndex === -1) return null;

	const messages = branch
		.slice(startIndex + 1)
		.filter((entry): entry is MessageEntry => entry.type === "message");
	const handoffMessageIndex = messages.findIndex((entry) => messageText(entry).includes("<loaded-handoff"));
	if (handoffMessageIndex < 0) return messages;

	const afterInjectedHandoff = messages.slice(handoffMessageIndex + 1);
	const firstUserMessageIndex = afterInjectedHandoff.findIndex((entry) => entry.message.role === "user");
	return firstUserMessageIndex < 0 ? [] : afterInjectedHandoff.slice(firstUserMessageIndex);
}

function handoffPages() {
	const pagesDir = `${LOGSEQ_DIR}/pages`;
	try {
		return parseContextFiles(readdirSync(pagesDir).map((filename) => `${pagesDir}/${filename}`));
	} catch {
		return [];
	}
}

function newestFirst<T extends { filePath: string }>(items: T[]): T[] {
	return [...items].sort((a, b) => {
		const aTime = existsSync(a.filePath) ? statSync(a.filePath).mtime.getTime() : 0;
		const bTime = existsSync(b.filePath) ? statSync(b.filePath).mtime.getTime() : 0;
		return bTime - aTime;
	});
}

function findLoadedHandoffInConversation(branch: SessionEntry[]): LoadedContextState | null {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "message") continue;

		const text = messageText(entry as MessageEntry);
		const tag = text.match(/<loaded-handoff\b([^>]*)>/);
		if (!tag) continue;

		const attrs = tag[1] ?? "";
		const title = xmlAttribute(attrs, "title");
		const pageName = xmlAttribute(attrs, "page-name") ?? xmlAttribute(attrs, "pageName");
		const filePath = xmlAttribute(attrs, "path");
		const pages = newestFirst(handoffPages());
		const match =
			(filePath ? pages.find((page) => page.filePath === filePath) : undefined) ??
			(pageName ? pages.find((page) => page.pageName === pageName) : undefined) ??
			(title ? pages.find((page) => page.title === title || page.pageName === title) : undefined);

		if (!match) continue;

		return {
			filePath: match.filePath,
			title: match.title,
			pageName: match.pageName,
			loadedAfterEntryId: entry.parentId,
		};
	}

	return null;
}

interface CreateHandoffParams {
	conversationText: string;
	availablePages: string[];
	isUpdate: boolean;
	handoffGoal?: string;
	snapshot: LoadedContextState | null;
	model: Parameters<typeof complete>[0];
	apiKey: string;
	headers?: Record<string, string>;
	existingHandoffContent?: string;
	widgetKey?: string;
}

async function createHandoffInBackground(
	ctx: ExtensionCommandContext,
	params: CreateHandoffParams,
): Promise<void> {
	const {
		conversationText,
		availablePages,
		isUpdate,
		handoffGoal,
		snapshot,
		model,
		apiKey,
		headers,
		existingHandoffContent,
		widgetKey = "create-handoff",
	} = params;

	try {
		const userPrompt = existingHandoffContent
			? buildUpdatePrompt(existingHandoffContent, conversationText, {
				handoffGoal,
				existingTitle: snapshot?.title,
				availablePages,
			})
			: buildExtractionPrompt(conversationText, {
				handoffGoal,
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
			ctx.ui.setWidget(widgetKey, undefined);
			ctx.ui.notify(`Handoff ${isUpdate ? "update" : "creation"} aborted`, "info");
			return;
		}

		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();

		const extracted = extractJSON(text);
		if (!extracted) {
			ctx.ui.setWidget(widgetKey, undefined);
			ctx.ui.notify("Handoff extraction failed: could not parse LLM response", "error");
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

		// Write handoff page
		writeFileSync(targetPath, pageContent, "utf-8");

		// Upsert journal entry
		const today = new Date();
		const jPath = journalPath(today);
		const title = isUpdate ? snapshot!.title : extracted.title;
		const existingJournal = existsSync(jPath) ? readFileSync(jPath, "utf-8") : "";
		const updatedJournal = upsertJournalEntry(existingJournal, title, {
			pageName: isUpdate ? snapshot!.pageName : undefined,
		});
		writeFileSync(jPath, updatedJournal, "utf-8");

		// Report only: lint never rewrites the handoff page or the journal.
		const lint = await lintSavedPages([targetPath, jPath], LOGSEQ_DIR);

		const verb = isUpdate ? "updated" : "created";
		ctx.ui.setWidget(widgetKey, undefined);
		if (lint.ok) {
			ctx.ui.notify(`Handoff ${verb}: ${targetPath} (lint passed)`, "success");
		} else {
			ctx.ui.notify([`Handoff ${verb}: ${targetPath}`, ...lint.messages].join("\n"), "warning");
		}
	} catch (err) {
		ctx.ui.setWidget(widgetKey, undefined);
		ctx.ui.notify(`Handoff ${isUpdate ? "update" : "creation"} failed: ${err}`, "error");
	}
}

export default function (pi: ExtensionAPI) {
	/** Tracks which handoff was loaded via /load-handoff in this session. */
	let loadedHandoff: LoadedContextState | null = null;

	// ── /create-handoff ──────────────────────────────────────────────

	pi.registerCommand("create-handoff", {
		description: "Create a task handoff as a Logseq page",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("create-handoff requires interactive mode", "error");
				return;
			}

			// Goal/intent is optional. Default to a generic continue-later handoff.
			const handoffGoal =
				args?.trim() || "Produce a handoff to continue this session later.";

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
				ctx.ui.notify("No conversation to turn into a handoff", "error");
				return;
			}

			const llmMessages = convertToLlm(messages);
			const conversationText = serializeConversation(llmMessages);

			const availablePages = getAvailablePages();
			loadedHandoff = loadedHandoff ?? findLoadedHandoffInConversation(branch);
			const isUpdate = loadedHandoff !== null;
			const model = ctx.model;
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok || !auth.apiKey) {
				ctx.ui.notify("No API key for current model", "error");
				return;
			}
			const apiKey = auth.apiKey;
			const headers = auth.headers;

			// Snapshot loadedHandoff before going async
			const snapshot = isUpdate ? { ...loadedHandoff! } : null;

			// ── Background create/update (non-blocking) ───────────────

			const statusLabel = isUpdate
				? `💾 Updating handoff: ${snapshot!.title}`
				: "💾 Creating handoff…";
			ctx.ui.setWidget("create-handoff", (_tui, theme) => ({
				render: () => [theme.fg("dim", statusLabel)],
				invalidate: () => {},
			}), { placement: "belowEditor" });

			createHandoffInBackground(ctx, {
				conversationText,
				availablePages,
				isUpdate,
				handoffGoal,
				snapshot,
				model,
				apiKey,
				headers,
			}).catch(() => {});

			// Returns immediately — user can keep working
		},
	});

	// Update the loaded handoff from the post-load conversation.
	pi.registerCommand("update-handoff", {
		description: "Update the loaded handoff using conversation since it was loaded",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("update-handoff requires interactive mode", "error");
				return;
			}

			const branch = ctx.sessionManager.getBranch();
			const handoff = loadedHandoff ?? findLoadedHandoffInConversation(branch);
			if (!handoff) {
				ctx.ui.notify("No loaded handoff found in the current conversation", "error");
				return;
			}
			loadedHandoff = handoff;

			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			let existingHandoffContent: string;
			try {
				existingHandoffContent = readFileSync(handoff.filePath, "utf-8");
			} catch {
				ctx.ui.notify(`Could not read loaded handoff: ${handoff.filePath}`, "error");
				return;
			}

			const updateMessages = messagesAfterLoadedHandoff(branch, handoff.loadedAfterEntryId);
			if (updateMessages === null) {
				ctx.ui.notify("Loaded handoff point is not on the current conversation branch", "error");
				return;
			}

			if (updateMessages.length === 0) {
				ctx.ui.notify("No conversation found after the handoff was loaded", "warning");
				return;
			}

			const conversationText = serializeConversation(convertToLlm(updateMessages.map((entry) => entry.message)));
			const model = ctx.model;
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok || !auth.apiKey) {
				ctx.ui.notify("No API key for current model", "error");
				return;
			}

			const snapshot = { ...handoff };
			const statusLabel = `💾 Updating handoff: ${snapshot.title}`;
			ctx.ui.setWidget("update-handoff", (_tui, theme) => ({
				render: () => [theme.fg("dim", statusLabel)],
				invalidate: () => {},
			}), { placement: "belowEditor" });

			createHandoffInBackground(ctx, {
				conversationText,
				availablePages: getAvailablePages(),
				isUpdate: true,
				handoffGoal: args?.trim() || undefined,
				snapshot,
				model,
				apiKey: auth.apiKey,
				headers: auth.headers,
				existingHandoffContent,
				widgetKey: "update-handoff",
			}).catch(() => {});
		},
	});

	// ── /load-logseq ─────────────────────────────────────────────────

	pi.registerCommand("load-logseq", {
		description: "Load any Logseq page into the conversation",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("load-logseq requires interactive mode", "error");
				return;
			}

			if (logseqSearchRoots().length === 0) {
				ctx.ui.notify("Could not find logseq pages or journals directories", "error");
				return;
			}

			const initialPages = searchLogseqPages("");
			if (initialPages.length === 0) {
				ctx.ui.notify("No Logseq pages found", "warning");
				return;
			}

			const selected = await ctx.ui.custom<LogseqPageSearchItem | null>((tui, theme, _kb, done) => {
				const topBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
				const bottomBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
				const searchInput = new Input();
				searchInput.focused = true;

				let filtered = initialPages;
				let selectedIdx = 0;
				let lastQuery = "";
				const maxVisible = Math.min(15, MAX_LOGSEQ_SEARCH_RESULTS);

				const refilter = () => {
					const query = searchInput.getValue();
					if (query === lastQuery) return;
					lastQuery = query;
					filtered = searchLogseqPages(query);
					selectedIdx = 0;
				};

				return {
					// Focusable: propagate to Input for IME cursor positioning
					get focused() { return searchInput.focused; },
					set focused(v: boolean) { searchInput.focused = v; },

					render: (w: number) => {
						const lines: string[] = [];
						lines.push(...topBorder.render(w));
						lines.push(` ${theme.fg("accent", theme.bold("Load Logseq Page"))}`);
						lines.push(...searchInput.render(w));
						lines.push("");

						if (filtered.length === 0) {
							lines.push(theme.fg("warning", "  No matching Logseq pages"));
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
						lines.push(theme.fg("dim", " ↑↓ navigate • type to rg-search pages • enter select • esc cancel"));
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
							done(filtered[selectedIdx] ?? null);
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

			let content: string;
			try {
				content = readFileSync(selected.filePath, "utf-8");
			} catch {
				ctx.ui.notify(`Could not read: ${selected.filePath}`, "error");
				return;
			}

			pi.sendUserMessage(
				`Here is a Logseq page loaded from disk:\n\n<logseq-page title="${escapeXmlAttribute(selected.pageName)}" path="${escapeXmlAttribute(selected.filePath)}">\n${content}\n</logseq-page>\n\nRead the page above. Summarize in one sentence what it contains, then list any task-relevant context or open items it provides. Do NOT start working yet — wait for instructions.`,
				{ deliverAs: "followUp" },
			);

			ctx.ui.notify(`Loaded Logseq page: ${selected.pageName}`, "success");
		},
	});

	// ── /load-handoff ────────────────────────────────────────────────

	pi.registerCommand("load-handoff", {
		description: "Load a saved handoff into the conversation",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("load-handoff requires interactive mode", "error");
				return;
			}

			// Find all handoff pages
			const pagesDir = `${LOGSEQ_DIR}/pages`;
			let allFiles: string[];
			try {
				allFiles = readdirSync(pagesDir).map((f) => `${pagesDir}/${f}`);
			} catch {
				ctx.ui.notify("Could not read logseq pages directory", "error");
				return;
			}

			const handoffs = parseContextFiles(allFiles);

			if (handoffs.length === 0) {
				ctx.ui.notify("No saved handoffs found", "warning");
				return;
			}

			// Sort by file modification time (most recent first)
			const withMtime = handoffs.map((c) => {
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
						lines.push(` ${theme.fg("accent", theme.bold("Load Handoff"))}`);
						lines.push(...searchInput.render(w));
						lines.push("");

						if (filtered.length === 0) {
							lines.push(theme.fg("warning", "  No matching handoffs"));
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

			// Read the handoff file
			let content: string;
			try {
				content = readFileSync(selected, "utf-8");
			} catch {
				ctx.ui.notify(`Could not read: ${selected}`, "error");
				return;
			}

			const loadedAfterEntryId = ctx.sessionManager.getLeafId();
			const match = handoffs.find((c) => c.filePath === selected);
			loadedHandoff = match
				? {
					filePath: match.filePath,
					title: match.title,
					pageName: match.pageName,
					loadedAfterEntryId,
				}
				: null;

			// Inject into conversation as a user message
			const handoffTitle = match?.title ?? "handoff";
			const handoffAttrs = [
				`title="${escapeXmlAttribute(handoffTitle)}"`,
				match ? `page-name="${escapeXmlAttribute(match.pageName)}"` : null,
				`path="${escapeXmlAttribute(selected)}"`,
			]
				.filter((attr): attr is string => attr !== null)
				.join(" ");
			pi.sendUserMessage(
				`Here is a saved handoff to continue from:\n\n<loaded-handoff ${handoffAttrs}>\n${content}\n</loaded-handoff>\n\nRead the handoff above. Summarize in one sentence the handoff goal and current state, then list the decisions, constraints, and file groups it provides. Do NOT infer or propose next steps. Do NOT start working yet — wait for instructions.`,
				{ deliverAs: "followUp" },
			);

			ctx.ui.notify(`Loaded handoff: ${handoffTitle}`, "success");
		},
	});
}
