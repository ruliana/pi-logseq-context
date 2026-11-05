import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	availablePagePaths,
	cleanTitle,
	slugify,
	contextHref,
	contextPageName,
	contextPagePath,
	conceptHref,
	journalPath,
	journalRef,
	buildContextPage,
	buildExtractionPrompt,
	buildUpdatePrompt,
	EXTRACT_SYSTEM_PROMPT,
	EXTRACT_SYSTEM_PROMPT_RULES,
	buildJournalEntry,
	upsertJournalEntry,
	updateContextPage,
	extractCreatedDate,
	extractJSON,
	filePathToPageName,
	parseContextFiles,
	wikilinksToLinks,
	NOTES_DIR,
	type ContextPageParams,
} from "./context.ts";

const DIR = "/notes";

describe("cleanTitle", () => {
	it("trims whitespace and collapses spaces", () => {
		assert.equal(cleanTitle("  too   many   spaces  "), "too many spaces");
	});

	it("removes characters that break file names and links", () => {
		assert.equal(cleanTitle('a/b\\c:d*e?f"g<h>i|j'), "abcdefghij");
		assert.equal(cleanTitle("fix #123 & deploy $app [x]"), "fix 123 deploy app x");
	});

	it("keeps normal titles and parentheses", () => {
		assert.equal(cleanTitle("Optimize Graph Embeddings (v2)"), "Optimize Graph Embeddings (v2)");
	});
});

describe("slugify", () => {
	it("lowercases and joins words with -", () => {
		assert.equal(slugify("Optimize Graph Embeddings"), "optimize-graph-embeddings");
	});

	it("matches the slugs of imported handoff pages", () => {
		assert.equal(slugify("SimGym Dual-Theme Step Support"), "simgym-dual-theme-step-support");
		assert.equal(slugify("Herdr Agent Recovery 2026-08-26"), "herdr-agent-recovery-2026-08-26");
		assert.equal(slugify("Fix hung single-theme batch job"), "fix-hung-single-theme-batch-job");
	});

	it("drops punctuation", () => {
		assert.equal(slugify("Fix: bug #42 (urgent)"), "fix-bug-42-urgent");
	});

	it("collapses repeated hyphens and trims them", () => {
		assert.equal(slugify("A - B"), "a-b");
		assert.equal(slugify("-- x --"), "x");
	});

	it("keeps non-ASCII letters", () => {
		assert.equal(slugify("Ação rápida"), "ação-rápida");
	});

	it("falls back to untitled", () => {
		assert.equal(slugify(""), "untitled");
		assert.equal(slugify("###"), "untitled");
	});

	it("avoids the names OKF and Tessela reserve", () => {
		assert.equal(slugify("Index"), "index-page");
		assert.equal(slugify("Log"), "log-page");
		assert.equal(slugify("Home"), "home-page");
	});
});

describe("contextPageName and contextHref", () => {
	it("prefixes with the namespace using /", () => {
		assert.equal(contextPageName("My Context"), "AI Handoff/My Context");
	});

	it("cleans the title part", () => {
		assert.equal(contextPageName("Fix #123"), "AI Handoff/Fix 123");
	});

	it("links to /ai-handoff/<slug>.md", () => {
		assert.equal(contextHref("My Context"), "/ai-handoff/my-context.md");
	});
});

describe("contextPagePath", () => {
	it("writes to ai-handoff/<slug>.md in the bundle", () => {
		assert.equal(contextPagePath("My Context", DIR), "/notes/ai-handoff/my-context.md");
	});

	it("defaults to the configured notes directory", () => {
		assert.equal(contextPagePath("My Context"), `${NOTES_DIR}/ai-handoff/my-context.md`);
	});
});

describe("journalRef and journalPath", () => {
	it("formats as YYYY-MM-DD", () => {
		assert.equal(journalRef(new Date("2026-03-18T12:00:00-04:00")), "2026-03-18");
	});

	it("uses the Toronto day, not the UTC day", () => {
		// 23:30 on 5 November in Toronto is already 6 November in UTC.
		assert.equal(journalRef(new Date("2026-11-05T23:30:00-05:00")), "2026-11-05");
		// Summer time (UTC-4): 03:30 UTC on 6 July is 23:30 on 5 July in Toronto.
		assert.equal(journalRef(new Date("2026-07-06T04:30:00Z")), "2026-07-06");
		assert.equal(journalRef(new Date("2026-07-06T03:30:00Z")), "2026-07-05");
	});

	it("writes journals/YYYY-MM-DD.md", () => {
		assert.equal(journalPath(new Date("2026-01-05T12:00:00-05:00"), DIR), "/notes/journals/2026-01-05.md");
	});
});

describe("conceptHref and filePathToPageName", () => {
	it("makes a bundle-relative link target from a file path", () => {
		assert.equal(conceptHref("/notes/ai-handoff/a.md", DIR), "/ai-handoff/a.md");
	});

	it("names a page by its path without .md", () => {
		assert.equal(filePathToPageName("/notes/simgym.md", DIR), "simgym");
		assert.equal(filePathToPageName("/notes/journals/2026-05-27.md", DIR), "journals/2026-05-27");
		assert.equal(filePathToPageName("/notes/ai-handoff/a.md", DIR), "ai-handoff/a");
	});
});

describe("availablePagePaths", () => {
	it("lists concept paths and leaves out journals, assets, hidden and reserved files", () => {
		const paths = availablePagePaths([
			"simgym.md",
			"project/tessela.md",
			"journals/2026-11-05.md",
			"assets/export.md",
			".tessela/cache.md",
			"notes/.hidden/x.md",
			"index.md",
			"folder/log.md",
			"photo.png",
			"ai-handoff",
		]);
		assert.deepEqual(paths, ["/project/tessela.md", "/simgym.md"]);
	});
});

describe("extractCreatedDate", () => {
	it("extracts the created: date from frontmatter", () => {
		const content = '---\ntype: concept\ncreated: "2026-03-15"\n---\n\n**Goal**\n';
		assert.equal(extractCreatedDate(content), "2026-03-15");
	});

	it("returns null if there is no created: field", () => {
		assert.equal(extractCreatedDate("---\ntype: concept\n---\n\n**Goal**\n"), null);
	});

	it("ignores a created: line in the body", () => {
		assert.equal(extractCreatedDate('---\ntype: concept\n---\n\ncreated: "2020-01-01"\n'), null);
	});

	it("handles created: with updated: present", () => {
		const content = '---\ncreated: "2026-03-15"\nupdated: "2026-03-18"\n---\n';
		assert.equal(extractCreatedDate(content), "2026-03-15");
	});
});

describe("wikilinksToLinks", () => {
	it("converts [[Page Name]] to a Markdown link", () => {
		assert.equal(wikilinksToLinks("See [[SimGym]]"), "See [SimGym](/simgym.md)");
	});

	it("maps / in a page name to a folder", () => {
		assert.equal(wikilinksToLinks("[[Project/Tessela Plan]]"), "[Project/Tessela Plan](/project/tessela-plan.md)");
	});

	it("leaves code spans alone", () => {
		assert.equal(wikilinksToLinks("`a[[0]]` and [[B]]"), "`a[[0]]` and [B](/b.md)");
	});
});

describe("buildContextPage", () => {
	const baseParams: ContextPageParams = {
		title: "Test Context",
		goal: "Build a feature",
		currentState: "Halfway done",
		keyDecisions: ["Use TypeScript", "TDD approach"],
		files: [
			{
				reason: "Implementation files for the feature",
				paths: ["/repo/src/index.ts", "/repo/src/utils.ts"],
			},
		],
	};

	it("starts with YAML frontmatter", () => {
		const page = buildContextPage(baseParams, { createdDate: "2026-11-05" });
		assert.ok(
			page.startsWith(
				'---\ntype: ai-handoff\ntitle: "AI Handoff/Test Context"\ntags: ["ai", "handoff"]\ncreated: "2026-11-05"\n---\n\n',
			),
		);
	});

	it("quotes a title that has quotes or a colon", () => {
		const page = buildContextPage({ ...baseParams, title: "Say 'hi': (v2)" });
		assert.ok(page.includes('title: "AI Handoff/Say hi (v2)"'));
	});

	it("has no Logseq properties, headings-as-bullets or wikilinks", () => {
		const page = buildContextPage({ ...baseParams, goal: "See [[SimGym]]" });
		assert.ok(!page.includes("::"));
		assert.ok(!page.includes("- ## "));
		assert.ok(!page.includes("[["));
		assert.ok(page.includes("- See [SimGym](/simgym.md)"));
	});

	it("has a Goal section as a list under a bold label", () => {
		const page = buildContextPage(baseParams);
		assert.ok(page.includes("**Goal**\n- Build a feature\n"));
	});

	it("has a Current State section", () => {
		const page = buildContextPage(baseParams);
		assert.ok(page.includes("**Current State**\n- Halfway done\n"));
	});

	it("lists key decisions as bullets", () => {
		const page = buildContextPage(baseParams);
		assert.ok(page.includes("**Key Decisions**\n- Use TypeScript\n- TDD approach\n"));
	});

	it("groups files under a reason with backtick formatting", () => {
		const page = buildContextPage(baseParams);
		assert.ok(
			page.includes("**Files**\n- Implementation files for the feature\n  - `/repo/src/index.ts`\n  - `/repo/src/utils.ts`\n"),
		);
	});

	it("keeps a multi-line value inside its list item", () => {
		const page = buildContextPage({ ...baseParams, goal: "line one\n\nline two" });
		assert.ok(page.includes("**Goal**\n- line one\n  line two\n"));
	});

	it("does not render legacy next steps", () => {
		const page = buildContextPage({
			...baseParams,
			nextSteps: ["Write tests", "Deploy"],
		} as ContextPageParams & { nextSteps: string[] });
		assert.ok(!page.includes("Next Steps"));
		assert.ok(!page.includes("Write tests"));
	});

	it("omits Key Decisions section when empty", () => {
		const page = buildContextPage({ ...baseParams, keyDecisions: [] });
		assert.ok(!page.includes("Key Decisions"));
	});

	it("omits Files section when empty", () => {
		const page = buildContextPage({ ...baseParams, files: [] });
		assert.ok(!page.includes("**Files**"));
	});

	it("omits References section when absent", () => {
		const page = buildContextPage(baseParams);
		assert.ok(!page.includes("**References**"));
	});

	it("turns page names into Markdown links", () => {
		const page = buildContextPage({ ...baseParams, references: ["Neo4j", "[[SimGym]]", "/sidekick.md", "[Roman](/roman-baiocco.md)"] });
		assert.ok(page.includes("**References**\n- [Neo4j](/neo4j.md)\n- [SimGym](/simgym.md)\n- [sidekick](/sidekick.md)\n- [Roman](/roman-baiocco.md)\n"));
	});

	it("renders URLs bare", () => {
		const page = buildContextPage({
			...baseParams,
			references: ["https://github.com/acme-org/repo/pull/42", "[[SimGym]]"],
		});
		assert.ok(page.includes("- https://github.com/acme-org/repo/pull/42\n"));
		assert.ok(!page.includes("[[https://"));
	});

	it("ends with exactly one newline", () => {
		const page = buildContextPage(baseParams);
		assert.ok(page.endsWith("\n") && !page.endsWith("\n\n"));
	});

	it("uses today (Toronto) when no createdDate is given", () => {
		const page = buildContextPage(baseParams);
		assert.ok(page.includes(`created: "${journalRef(new Date())}"`));
	});

	it("includes updated: when updatedDate provided", () => {
		const page = buildContextPage(baseParams, { createdDate: "2026-01-01", updatedDate: "2026-03-18" });
		assert.ok(page.includes('created: "2026-01-01"'));
		assert.ok(page.includes('updated: "2026-03-18"'));
	});

	it("omits updated: when not provided", () => {
		assert.ok(!buildContextPage(baseParams).includes("updated:"));
	});
});

describe("buildJournalEntry", () => {
	it("creates a list item that links to the page", () => {
		assert.equal(
			buildJournalEntry("My Task"),
			"- Created AI handoff: [AI Handoff/My Task](/ai-handoff/my-task.md)",
		);
	});

	it("cleans the title in the link text and slugs the target", () => {
		assert.equal(
			buildJournalEntry("Fix: bug #42"),
			"- Created AI handoff: [AI Handoff/Fix bug 42](/ai-handoff/fix-bug-42.md)",
		);
	});
});

describe("updateContextPage", () => {
	const params: ContextPageParams = { title: "T", goal: "New goal", currentState: "New state", keyDecisions: [], files: [] };
	const existing = [
		"---",
		"type: ai-handoff",
		'title: "AI Handoff/T"',
		'tags: ["ai", "handoff", "simgym"]',
		'project: "[SimGym](/simgym.md)"',
		'created: "2026-10-01"',
		'status: "changes-pushed"',
		"---",
		"",
		"Old body",
		"",
	].join("\n");

	it("keeps every frontmatter line byte for byte and adds only updated", () => {
		const page = updateContextPage(existing, params, "2026-11-06")!;
		const front = existing.split("\n---\n")[0].slice(4);
		assert.ok(page.startsWith(`---\n${front}\nupdated: "2026-11-06"\n---\n\n**Goal**`));
		assert.ok(!page.includes("Old body"));
		assert.ok(page.includes("New state"));
	});

	it("replaces an existing updated line in place", () => {
		const page = updateContextPage(existing.replace('status:', 'updated: "2026-10-02"\nstatus:'), params, "2026-11-06")!;
		assert.ok(page.includes('updated: "2026-11-06"\nstatus: "changes-pushed"'));
		assert.equal(page.match(/^updated:/gm)?.length, 1);
	});

	it("adds a missing tag and keeps the others", () => {
		const page = updateContextPage(existing.replace('["ai", "handoff", "simgym"]', '["simgym"]'), params, "2026-11-06")!;
		assert.ok(page.includes('tags: ["simgym", "ai", "handoff"]'));
		const block = updateContextPage(existing.replace('tags: ["ai", "handoff", "simgym"]', "tags:\n  - ai\n  - simgym"), params, "2026-11-06")!;
		assert.ok(block.includes("tags:\n  - ai\n  - simgym\n  - handoff\nproject:"));
	});

	it("does not change type, even when it is not ai-handoff", () => {
		const page = updateContextPage(existing.replace("ai-handoff\n", "concept\n"), params, "2026-11-06")!;
		assert.ok(page.startsWith("---\ntype: concept\n"));
	});

	it("returns null without frontmatter", () => {
		assert.equal(updateContextPage("no frontmatter\n", params, "2026-11-06"), null);
	});
});

describe("upsertJournalEntry", () => {
	const link = "[AI Handoff/My Task](/ai-handoff/my-task.md)";

	it("creates a journal file with frontmatter when the journal is empty", () => {
		const result = upsertJournalEntry("", "My Task", { date: "2026-11-05" });
		assert.equal(
			result,
			`---\ntype: journal\ntitle: "2026-11-05"\ndate: "2026-11-05"\n---\n\n- Created AI handoff: ${link}\n`,
		);
	});

	it("puts a blank line and another bullet marker before the entry after a list item", () => {
		const result = upsertJournalEntry("- Did some work\n- Another note\n", "My Task");
		assert.equal(result, `- Did some work\n- Another note\n\n* Created AI handoff: ${link}\n`);
	});

	it("keeps the entry out of a list that belongs to a paragraph (Daily TODO)", () => {
		const journal = "---\ntype: journal\n---\n\n[Daily TODO](/daily-todo.md)\n- Item one\n- Item two";
		const result = upsertJournalEntry(journal, "My Task");
		assert.ok(result.endsWith(`- Item two\n\n* Created AI handoff: ${link}\n`));
	});

	it("keeps handoff lines together, in the same list", () => {
		const other = "[AI Handoff/Other](/ai-handoff/other.md)";
		assert.ok(upsertJournalEntry(`- Note\n\n* Created AI handoff: ${other}\n`, "My Task").endsWith(`${other}\n* Created AI handoff: ${link}\n`));
		assert.ok(upsertJournalEntry(`Note\n\n- Created AI handoff: ${other}\n`, "My Task").endsWith(`${other}\n- Created AI handoff: ${link}\n`));
	});

	it("bumps the counter of an entry written with another bullet marker", () => {
		assert.ok(upsertJournalEntry(`- Note\n\n* Created AI handoff: ${link}\n`, "My Task").endsWith(`* Updated AI handoff: ${link} (2)\n`));
	});

	it("does not expand $ patterns in a title when it bumps the counter", () => {
		const cost = "[AI Handoff/Cost $1 run $& $$](/ai-handoff/cost-1-run.md)";
		const result = upsertJournalEntry(`- Created AI handoff: ${cost}\n`, "Cost $1 run $& $$", { pageName: "AI Handoff/Cost $1 run $& $$", href: "/ai-handoff/cost-1-run.md" });
		assert.equal(result, `- Updated AI handoff: ${cost} (2)\n`);
	});

	it("keeps the trailing spaces and CRLF of the last line", () => {
		const result = upsertJournalEntry("- Note  \r\n", "My Task");
		assert.equal(result, `- Note  \r\n\r\n* Created AI handoff: ${link}\r\n`);
		assert.ok(upsertJournalEntry("Last line  ", "My Task").startsWith("Last line  \n\n- Created"));
	});

	it("keeps the entry out of a paragraph that has no blank line after it", () => {
		const journal = "---\ntype: journal\ntitle: \"2026-11-05\"\ndate: \"2026-11-05\"\n---\n\nNo newline at the end";
		const result = upsertJournalEntry(journal, "My Task");
		assert.ok(result.endsWith(`No newline at the end\n\n- Created AI handoff: ${link}\n`));
	});

	it("increments to (2) on first re-save", () => {
		const result = upsertJournalEntry(`- Created AI handoff: ${link}\n`, "My Task");
		assert.ok(result.includes(`- Updated AI handoff: ${link} (2)`));
	});

	it("updates a bare line from an imported journal", () => {
		const result = upsertJournalEntry(`Created AI handoff: ${link}\n`, "My Task");
		assert.equal(result, `Updated AI handoff: ${link} (2)\n`);
	});

	it("updates a loaded page using its own name and path", () => {
		const legacy = "[AI Handoff/Old Name](/ai-handoff/old-name.md)";
		const result = upsertJournalEntry(`- Created AI handoff: ${legacy}\n`, "New Name", {
			pageName: "AI Handoff/Old Name",
			href: "/ai-handoff/old-name.md",
		});
		assert.ok(result.includes(`- Updated AI handoff: ${legacy} (2)`));
	});

	it("increments (2) to (3) and (9) to (10)", () => {
		assert.ok(upsertJournalEntry(`- Updated AI handoff: ${link} (2)\n`, "My Task").includes("(3)"));
		assert.ok(upsertJournalEntry(`- Updated AI handoff: ${link} (9)\n`, "My Task").includes("(10)"));
	});

	it("does not duplicate when the entry already exists", () => {
		const journal = `- Some note\n- Created AI handoff: ${link}\n- Another note\n`;
		const result = upsertJournalEntry(journal, "My Task");
		assert.equal(result.match(/my-task\.md/g)?.length, 1);
	});

	it("preserves surrounding journal content on update", () => {
		const result = upsertJournalEntry(`- Before\n- Created AI handoff: ${link}\n- After\n`, "My Task");
		assert.ok(result.includes("- Before\n"));
		assert.ok(result.includes("- After\n"));
		assert.ok(result.includes("(2)"));
	});

	it("handles a title with parentheses", () => {
		const entry = "- Created AI handoff: [AI Handoff/Fix bug (urgent)](/ai-handoff/fix-bug-urgent.md)\n";
		assert.ok(upsertJournalEntry(entry, "Fix bug (urgent)").includes("(2)"));
	});

	it("does not match entries for different handoffs", () => {
		const other = "[AI Handoff/Other Task](/ai-handoff/other-task.md)";
		const result = upsertJournalEntry(`- Created AI handoff: ${other}\n`, "My Task");
		assert.ok(result.includes(other));
		assert.ok(result.includes(link));
	});
});

describe("parseContextFiles", () => {
	const pages: Record<string, string> = {
		"/notes/ai-handoff/graph-optimization.md": '---\ntype: concept\ntitle: "AI Handoff/Graph Optimization"\n---\n',
		"/notes/ai-handoff/zebra.md": '---\ntitle: "AI Handoff/Zebra"\n---\n',
		"/notes/ai-handoff/apple.md": '---\ntitle: "AI Handoff/Apple"\n---\n',
		"/notes/ai-handoff/no-title.md": "no frontmatter\n",
	};
	const read = (fp: string) => {
		if (!(fp in pages)) throw new Error("ENOENT");
		return pages[fp];
	};

	it("reads the title from frontmatter", () => {
		const items = parseContextFiles(["/notes/ai-handoff/graph-optimization.md"], read);
		assert.equal(items.length, 1);
		assert.equal(items[0].title, "Graph Optimization");
		assert.equal(items[0].pageName, "AI Handoff/Graph Optimization");
	});

	it("falls back to the file name when there is no title or the read fails", () => {
		const items = parseContextFiles(["/notes/ai-handoff/no-title.md", "/notes/ai-handoff/gone.md"], read);
		assert.deepEqual(items.map((i) => i.title).sort(), ["gone", "no-title"]);
	});

	it("ignores files that are not Markdown", () => {
		assert.equal(parseContextFiles(["/notes/ai-handoff/notes.txt", "/notes/ai-handoff/dir"], read).length, 0);
	});

	it("preserves the full file path", () => {
		const fp = "/notes/ai-handoff/zebra.md";
		assert.equal(parseContextFiles([fp], read)[0].filePath, fp);
	});

	it("sorts by title", () => {
		const items = parseContextFiles(
			["/notes/ai-handoff/zebra.md", "/notes/ai-handoff/apple.md", "/notes/ai-handoff/graph-optimization.md"],
			read,
		);
		assert.deepEqual(items.map((i) => i.title), ["Apple", "Graph Optimization", "Zebra"]);
	});

	it("handles empty input", () => {
		assert.deepEqual(parseContextFiles([], read), []);
	});
});

describe("extractJSON", () => {
	const validJSON: ContextPageParams = {
		title: "Test",
		goal: "Build it",
		currentState: "In progress",
		keyDecisions: ["Use TS"],
		files: [
			{
				reason: "Implementation entry point",
				paths: ["/repo/index.ts"],
			},
		],
	};
	const jsonStr = JSON.stringify(validJSON);

	it("parses bare JSON", () => {
		const result = extractJSON(jsonStr);
		assert.deepEqual(result, validJSON);
	});

	it("parses JSON with leading/trailing whitespace", () => {
		const result = extractJSON(`  \n${jsonStr}\n  `);
		assert.deepEqual(result, validJSON);
	});

	it("strips markdown json fences", () => {
		const result = extractJSON(`\`\`\`json\n${jsonStr}\n\`\`\``);
		assert.deepEqual(result, validJSON);
	});

	it("strips markdown fences without language tag", () => {
		const result = extractJSON(`\`\`\`\n${jsonStr}\n\`\`\``);
		assert.deepEqual(result, validJSON);
	});

	it("extracts JSON embedded in prose", () => {
		const text = `Here is the extracted context:\n\n${jsonStr}\n\nLet me know if you need changes.`;
		const result = extractJSON(text);
		assert.deepEqual(result, validJSON);
	});

	it("extracts JSON from 'Human:' echo scenario", () => {
		const text = `Human: some conversation text\n\nAssistant: here is the json\n${jsonStr}`;
		const result = extractJSON(text);
		assert.deepEqual(result, validJSON);
	});

	it("drops legacy flat file arrays and nextSteps", () => {
		const result = extractJSON(JSON.stringify({
			...validJSON,
			files: ["/repo/index.ts"],
			nextSteps: ["Deploy"],
		}));
		assert.deepEqual(result, {
			...validJSON,
			files: [],
		});
		assert.equal("nextSteps" in result, false);
	});

	it("drops file groups without reasons", () => {
		const result = extractJSON(JSON.stringify({
			...validJSON,
			files: [{ paths: ["/repo/index.ts"] }],
		}));
		assert.deepEqual(result, {
			...validJSON,
			files: [],
		});
	});

	it("throws on completely non-JSON text", () => {
		assert.throws(() => extractJSON("✅ All tests pass!"), /Could not extract JSON/);
	});

	it("throws on text with no braces", () => {
		assert.throws(() => extractJSON("No JSON here at all"), /Could not extract JSON/);
	});

	it("throws on malformed JSON with braces", () => {
		assert.throws(() => extractJSON("{ broken json }"), /Could not extract JSON/);
	});
});

describe("buildExtractionPrompt", () => {
	it("wraps conversation in XML tags", () => {
		const prompt = buildExtractionPrompt("Hello world");
		assert.ok(prompt.includes("<conversation>\nHello world\n</conversation>"));
	});

	it("puts handoff creation instruction after conversation", () => {
		const prompt = buildExtractionPrompt("convo text");
		const convoIdx = prompt.indexOf("<conversation>");
		const instructIdx = prompt.indexOf("Now create the handoff");
		assert.ok(instructIdx > convoIdx, "instruction should come after conversation");
	});

	it("includes handoff goal when provided", () => {
		const prompt = buildExtractionPrompt("convo", { handoffGoal: "Help the next agent finish the auth flow" });
		assert.ok(prompt.includes("<handoff_goal>\nHelp the next agent finish the auth flow\n</handoff_goal>"));
	});

	it("omits handoff_goal when not provided", () => {
		const prompt = buildExtractionPrompt("convo");
		assert.ok(!prompt.includes("handoff_goal"));
	});

	it("includes available pages in XML tags", () => {
		const prompt = buildExtractionPrompt("convo", {
			availablePages: ["SimGym", "Neo4j", "Roman Fries"],
		});
		assert.ok(prompt.includes("<available_pages>"));
		assert.ok(prompt.includes("SimGym\nNeo4j\nRoman Fries"));
		assert.ok(prompt.includes("</available_pages>"));
	});

	it("omits available_pages when empty", () => {
		const prompt = buildExtractionPrompt("convo", { availablePages: [] });
		assert.ok(!prompt.includes("available_pages"));
	});

	it("omits available_pages when not provided", () => {
		const prompt = buildExtractionPrompt("convo");
		assert.ok(!prompt.includes("available_pages"));
	});

	it("includes update instruction when existingTitle provided", () => {
		const prompt = buildExtractionPrompt("convo", { existingTitle: "My Old Handoff" });
		assert.ok(prompt.includes('UPDATE to an existing handoff titled "My Old Handoff"'));
	});

	it("places available pages before instruction", () => {
		const prompt = buildExtractionPrompt("convo", {
			availablePages: ["SimGym"],
		});
		const pagesIdx = prompt.indexOf("<available_pages>");
		const instructIdx = prompt.indexOf("Now create the handoff");
		assert.ok(pagesIdx < instructIdx, "pages should come before extraction instruction");
	});
});

describe("buildUpdatePrompt", () => {
	it("separates the existing handoff from the conversation after load", () => {
		const prompt = buildUpdatePrompt("- ## Goal\n\t- Old", "User: new result", {
			existingTitle: "Existing Task",
		});
		assert.ok(prompt.includes("<existing_handoff_title>\nExisting Task\n</existing_handoff_title>"));
		assert.ok(prompt.includes("<existing_handoff>\n- ## Goal\n\t- Old\n</existing_handoff>"));
		assert.ok(prompt.includes("<conversation_after_handoff_load>\nUser: new result\n</conversation_after_handoff_load>"));
	});

	it("includes optional pages and handoff goal", () => {
		const prompt = buildUpdatePrompt("old", "new", {
			handoffGoal: "Refresh current state only",
			availablePages: ["SimGym", "Neo4j"],
		});
		assert.ok(prompt.includes("<available_pages>\nSimGym\nNeo4j\n</available_pages>"));
		assert.ok(prompt.includes("<handoff_goal>\nRefresh current state only\n</handoff_goal>"));
	});

	it("requires a complete replacement handoff based on later conversation", () => {
		const prompt = buildUpdatePrompt("old", "new");
		assert.ok(prompt.includes("conversation that happened after it was loaded"));
		assert.ok(prompt.includes("COMPLETE replacement handoff JSON object"));
		assert.ok(prompt.includes("Preserve still-relevant facts"));
		assert.ok(prompt.includes("file groups"));
		assert.ok(prompt.includes("Do not include next steps"));
		assert.ok(prompt.includes("Output ONLY valid JSON"));
	});
});

describe("EXTRACT_SYSTEM_PROMPT", () => {
	it("renders every named rule into the prompt", () => {
		for (const rule of EXTRACT_SYSTEM_PROMPT_RULES) {
			assert.ok(EXTRACT_SYSTEM_PROMPT.includes(rule.text), `missing rule ${rule.id}`);
		}
	});

	it("requires self-contained handoff context without rediscovery", () => {
		const rules = EXTRACT_SYSTEM_PROMPT_RULES.map((rule) => rule.id);
		assert.ok(rules.includes("handoff-goal"));
		assert.ok(rules.includes("handoff-completeness"));
		assert.ok(rules.includes("self-contained-references"));
		assert.ok(EXTRACT_SYSTEM_PROMPT.includes("continue the job using only this JSON"));
		assert.ok(EXTRACT_SYSTEM_PROMPT.includes("without reading the original conversation or searching"));
	});

	it("requires complete URL and note page references without overloading references", () => {
		const referencesRule = EXTRACT_SYSTEM_PROMPT_RULES.find((rule) => rule.id === "references")?.text ?? "";
		assert.ok(referencesRule.includes("include ALL note page references and URL-backed references"));
		assert.ok(referencesRule.includes("full GitHub URL"));
		assert.ok(referencesRule.includes("Non-URL identifiers without a note page"));
		assert.ok(referencesRule.includes("files.reason"));
		assert.ok(referencesRule.includes("not references"));
	});

	it("requires files to be grouped by why they matter", () => {
		const fileRule = EXTRACT_SYSTEM_PROMPT_RULES.find((rule) => rule.id === "file-paths")?.text ?? "";
		assert.ok(fileRule.includes("group paths by why the next agent should read them"));
		assert.ok(fileRule.includes("reason and paths"));
		assert.ok(EXTRACT_SYSTEM_PROMPT.includes('"files": ['));
		assert.ok(EXTRACT_SYSTEM_PROMPT.includes('"reason": "why the next agent should read these paths"'));
		assert.ok(EXTRACT_SYSTEM_PROMPT.includes('"paths": ["/absolute/path/to/file.ts"]'));
	});

	it("forbids generated next steps", () => {
		const ruleIds = EXTRACT_SYSTEM_PROMPT_RULES.map((rule) => rule.id);
		assert.ok(ruleIds.includes("no-next-steps"));
		assert.ok(EXTRACT_SYSTEM_PROMPT.includes("Do NOT include next steps"));
		assert.ok(!EXTRACT_SYSTEM_PROMPT.includes('"nextSteps"'));
	});

	it("prefers references over copied snippets", () => {
		const referenceFirstRule = EXTRACT_SYSTEM_PROMPT_RULES.find((rule) => rule.id === "reference-first")?.text ?? "";
		assert.ok(referenceFirstRule.includes("Prefer references over snippets"));
		assert.ok(referenceFirstRule.includes("local paths"));
		assert.ok(referenceFirstRule.includes("GitHub URLs"));
		assert.ok(referenceFirstRule.includes("short snippet only when no stable reference exists"));
	});

	it("excludes failed attempts and conversation back-and-forth", () => {
		const noiseRule = EXTRACT_SYSTEM_PROMPT_RULES.find((rule) => rule.id === "exclude-process-noise")?.text ?? "";
		assert.ok(noiseRule.includes("Exclude failed attempts"));
		assert.ok(noiseRule.includes("back-and-forth"));
		assert.ok(noiseRule.includes("not the attempt history"));
	});
});
