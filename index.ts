/**
 * Logseq Context Extension
 *
 * /save-context — Reflect on conversation, create a logseq page with
 *                 everything needed for another AI agent to continue.
 *                 Also adds a journal entry referencing the context page.
 *                 If a context was loaded this session, updates it in place.
 *
 * /load-context — Show a SelectList of saved contexts, load the selected
 *                 one into the current conversation.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { complete, type Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@mariozechner/pi-coding-agent";
import { BorderedLoader, DynamicBorder, convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";

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

			// Gather conversation from current branch
			const branch = ctx.sessionManager.getBranch();
			const messages = branch
				.filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
				.map((entry) => entry.message);

			if (messages.length === 0) {
				ctx.ui.notify("No conversation to save", "error");
				return;
			}

			// Serialize conversation for the LLM
			const llmMessages = convertToLlm(messages);
			const conversationText = serializeConversation(llmMessages);

			// Scan available logseq pages for [[linking]]
			const pagesDir = `${LOGSEQ_DIR}/pages`;
			let availablePages: string[] = [];
			try {
				const filenames = readdirSync(pagesDir);
				availablePages = filenamesToPageNames(filenames);
			} catch {
				// Non-fatal — extraction works without page list
			}

			// Determine if we're updating an existing context
			const isUpdate = loadedContext !== null;
			const extraGoal = args?.trim() || undefined;

			// Extract context via LLM with loader UI
			const loaderLabel = isUpdate
				? `Updating context: ${loadedContext!.title}...`
				: "Extracting context...";

			const extracted = await ctx.ui.custom<ContextPageParams | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, loaderLabel);
				loader.onAbort = () => done(null);

				const doExtract = async () => {
					const apiKey = await ctx.modelRegistry.getApiKey(ctx.model!);

					const userPrompt = buildExtractionPrompt(conversationText, {
						extraGoal,
						existingTitle: isUpdate ? loadedContext!.title : undefined,
						availablePages,
					});

					const userMessage: Message = {
						role: "user",
						content: [{ type: "text", text: userPrompt }],
						timestamp: Date.now(),
					};

					const response = await complete(
						ctx.model!,
						{ systemPrompt: EXTRACT_SYSTEM_PROMPT, messages: [userMessage] },
						{ apiKey, signal: loader.signal },
					);

					if (response.stopReason === "aborted") return null;

					const text = response.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n")
						.trim();

					return extractJSON(text);
				};

				doExtract()
					.then(done)
					.catch((err) => {
						console.error("Context extraction failed:", err);
						done(null);
					});

				return loader;
			});

			if (!extracted) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			// Build page content — preserve original created date on updates
			let pageContent: string;
			let targetPath: string;

			if (isUpdate) {
				let createdDate: string | undefined;
				try {
					const existing = readFileSync(loadedContext!.filePath, "utf-8");
					createdDate = extractCreatedDate(existing) ?? undefined;
				} catch {
					// File might have been deleted — fall through
				}
				pageContent = buildContextPage(extracted, {
					createdDate,
					updatedDate: journalRef(new Date()),
				});
				targetPath = loadedContext!.filePath;
			} else {
				pageContent = buildContextPage(extracted);
				targetPath = contextPagePath(extracted.title);
			}

			// Write the context page directly — no review step
			writeFileSync(targetPath, pageContent, "utf-8");

			// Upsert journal entry (deduplicates, increments counter on repeat saves)
			const today = new Date();
			const jPath = journalPath(today);
			const title = isUpdate ? loadedContext!.title : extracted.title;
			const existingJournal = existsSync(jPath) ? readFileSync(jPath, "utf-8") : "";
			const updatedJournal = upsertJournalEntry(existingJournal, title);
			writeFileSync(jPath, updatedJournal, "utf-8");

			// Run logseq-lint --fix on both written files
			const linter = `${process.env.HOME}/.local/bin/logseq-lint.js`;
			for (const fp of [targetPath, jPath]) {
				try {
					execSync(`bun ${linter} --fix --root ${LOGSEQ_DIR} ${fp}`, {
						encoding: "utf-8",
						timeout: 10_000,
					});
				} catch {
					// Lint errors are non-fatal for save-context
				}
			}

			const verb = isUpdate ? "updated" : "saved";
			ctx.ui.notify(`Context ${verb}: ${targetPath}`, "success");
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

			// Build SelectList items
			const items: SelectItem[] = contexts.map((c) => ({
				value: c.filePath,
				label: c.title,
				description: c.pageName,
			}));

			// Show fzf-style selector
			const selected = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const container = new Container();
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
				container.addChild(new Text(theme.fg("accent", theme.bold("Load Context")), 1, 0));

				const selectList = new SelectList(items, Math.min(items.length, 15), {
					selectedPrefix: (t) => theme.fg("accent", t),
					selectedText: (t) => theme.fg("accent", t),
					description: (t) => theme.fg("muted", t),
					scrollInfo: (t) => theme.fg("dim", t),
					noMatch: (t) => theme.fg("warning", t),
				});

				selectList.onSelect = (item) => done(item.value);
				selectList.onCancel = () => done(null);
				container.addChild(selectList);

				container.addChild(new Text(theme.fg("dim", "↑↓ navigate • type to filter • enter select • esc cancel"), 1, 0));
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

				return {
					render: (w: number) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						selectList.handleInput(data);
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
