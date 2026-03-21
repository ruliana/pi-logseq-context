import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	slugify,
	contextPageName,
	contextPagePath,
	journalPath,
	journalRef,
	buildContextPage,
	buildExtractionPrompt,
	buildJournalEntry,
	upsertJournalEntry,
	extractCreatedDate,
	extractJSON,
	filenamesToPageNames,
	parseContextFiles,
	NAMESPACE,
	NAMESPACE_SEP,
	LOGSEQ_DIR,
	type ContextPageParams,
} from "./context.ts";

describe("slugify", () => {
	it("trims whitespace", () => {
		assert.equal(slugify("  hello world  "), "hello world");
	});

	it("removes dangerous filesystem characters", () => {
		assert.equal(slugify('a/b\\c:d*e?f"g<h>i|j'), "abcdefghij");
	});

	it("removes logseq-problematic characters", () => {
		assert.equal(slugify("fix #123 & deploy $app"), "fix 123 deploy app");
	});

	it("collapses multiple spaces", () => {
		assert.equal(slugify("too   many   spaces"), "too many spaces");
	});

	it("handles empty string", () => {
		assert.equal(slugify(""), "");
	});

	it("preserves normal titles", () => {
		assert.equal(slugify("Optimize Graph Embeddings"), "Optimize Graph Embeddings");
	});
});

describe("contextPageName", () => {
	it("prefixes with namespace using /", () => {
		assert.equal(contextPageName("My Context"), "AI Context/My Context");
	});

	it("slugifies the title part", () => {
		assert.equal(contextPageName("Fix #123"), "AI Context/Fix 123");
	});
});

describe("contextPagePath", () => {
	it("uses ___ separator and .md extension", () => {
		const path = contextPagePath("My Context");
		assert.equal(path, `${LOGSEQ_DIR}/pages/${NAMESPACE}${NAMESPACE_SEP}My Context.md`);
	});

	it("slugifies the title in the path", () => {
		const path = contextPagePath("Fix: bug #42");
		assert.ok(path.endsWith(`${NAMESPACE}${NAMESPACE_SEP}Fix bug 42.md`));
	});
});

describe("journalPath", () => {
	it("formats date as YYYY_MM_DD.md", () => {
		const date = new Date(2026, 2, 18); // March 18, 2026
		assert.equal(journalPath(date), `${LOGSEQ_DIR}/journals/2026_03_18.md`);
	});

	it("zero-pads single digit months and days", () => {
		const date = new Date(2026, 0, 5); // Jan 5, 2026
		assert.equal(journalPath(date), `${LOGSEQ_DIR}/journals/2026_01_05.md`);
	});
});

describe("journalRef", () => {
	it("formats as YYYY-MM-DD", () => {
		const date = new Date(2026, 2, 18);
		assert.equal(journalRef(date), "2026-03-18");
	});
});

describe("filenamesToPageNames", () => {
	it("converts simple filenames", () => {
		assert.deepEqual(filenamesToPageNames(["SimGym.md", "Neo4j.md"]), ["Neo4j", "SimGym"]);
	});

	it("converts namespaced filenames using ___", () => {
		assert.deepEqual(filenamesToPageNames(["Neo4j___Pregel.md"]), ["Neo4j/Pregel"]);
	});

	it("filters out non-.md files", () => {
		assert.deepEqual(filenamesToPageNames(["README.txt", "notes.md"]), ["notes"]);
	});

	it("sorts alphabetically", () => {
		assert.deepEqual(filenamesToPageNames(["Zebra.md", "Apple.md", "Mango.md"]), [
			"Apple",
			"Mango",
			"Zebra",
		]);
	});

	it("handles empty input", () => {
		assert.deepEqual(filenamesToPageNames([]), []);
	});
});

describe("extractCreatedDate", () => {
	it("extracts date from created:: property", () => {
		const content = "type:: #ai-context\ntags:: #ai\ncreated:: [[2026-03-15]]\n\n- ## Goal\n";
		assert.equal(extractCreatedDate(content), "2026-03-15");
	});

	it("returns null if no created:: property", () => {
		const content = "type:: #ai-context\ntags:: #ai\n\n- ## Goal\n";
		assert.equal(extractCreatedDate(content), null);
	});

	it("handles created:: with updated:: present", () => {
		const content = "created:: [[2026-03-15]]\nupdated:: [[2026-03-18]]\n";
		assert.equal(extractCreatedDate(content), "2026-03-15");
	});
});

describe("buildContextPage", () => {
	const baseParams: ContextPageParams = {
		title: "Test Context",
		goal: "Build a feature",
		currentState: "Halfway done",
		keyDecisions: ["Use TypeScript", "TDD approach"],
		files: ["src/index.ts", "src/utils.ts"],
		nextSteps: ["Write tests", "Deploy"],
	};

	it("starts with page properties in logseq format", () => {
		const page = buildContextPage(baseParams);
		assert.ok(page.startsWith("type:: #ai-context\n"));
		assert.ok(page.includes("tags:: #ai\n"));
		assert.ok(page.includes("created:: [["));
	});

	it("has Goal section in outliner format", () => {
		const page = buildContextPage(baseParams);
		assert.ok(page.includes("- ## Goal\n\t- Build a feature"));
	});

	it("has Current State section", () => {
		const page = buildContextPage(baseParams);
		assert.ok(page.includes("- ## Current State\n\t- Halfway done"));
	});

	it("lists key decisions as child bullets", () => {
		const page = buildContextPage(baseParams);
		assert.ok(page.includes("- ## Key Decisions\n\t- Use TypeScript\n\t- TDD approach"));
	});

	it("lists files with backtick formatting", () => {
		const page = buildContextPage(baseParams);
		assert.ok(page.includes("\t- `src/index.ts`"));
		assert.ok(page.includes("\t- `src/utils.ts`"));
	});

	it("lists next steps", () => {
		const page = buildContextPage(baseParams);
		assert.ok(page.includes("- ## Next Steps\n\t- Write tests\n\t- Deploy"));
	});

	it("omits Key Decisions section when empty", () => {
		const page = buildContextPage({ ...baseParams, keyDecisions: [] });
		assert.ok(!page.includes("## Key Decisions"));
	});

	it("omits Files section when empty", () => {
		const page = buildContextPage({ ...baseParams, files: [] });
		assert.ok(!page.includes("## Files"));
	});

	it("omits References section when absent", () => {
		const page = buildContextPage(baseParams);
		assert.ok(!page.includes("## References"));
	});

	it("wraps page references in [[ ]] if not already wrapped", () => {
		const page = buildContextPage({ ...baseParams, references: ["Neo4j", "[[SimGym]]"] });
		assert.ok(page.includes("\t- [[Neo4j]]"));
		assert.ok(page.includes("\t- [[SimGym]]"));
	});

	it("renders URLs bare without [[ ]] wrapping", () => {
		const page = buildContextPage({
			...baseParams,
			references: ["https://github.com/acme-org/repo/pull/42", "[[SimGym]]"],
		});
		assert.ok(page.includes("\t- https://github.com/acme-org/repo/pull/42"));
		assert.ok(!page.includes("[[https://"));
	});

	it("ends with newline", () => {
		const page = buildContextPage(baseParams);
		assert.ok(page.endsWith("\n"));
	});

	it("uses provided createdDate instead of today", () => {
		const page = buildContextPage(baseParams, { createdDate: "2026-01-01" });
		assert.ok(page.includes("created:: [[2026-01-01]]"));
	});

	it("includes updated:: property when updatedDate provided", () => {
		const page = buildContextPage(baseParams, {
			createdDate: "2026-01-01",
			updatedDate: "2026-03-18",
		});
		assert.ok(page.includes("created:: [[2026-01-01]]"));
		assert.ok(page.includes("updated:: [[2026-03-18]]"));
	});

	it("omits updated:: when not provided", () => {
		const page = buildContextPage(baseParams);
		assert.ok(!page.includes("updated::"));
	});
});

describe("buildJournalEntry", () => {
	it("creates a bullet with page reference using namespace", () => {
		const entry = buildJournalEntry("My Task");
		assert.equal(entry, "- Saved AI context: [[AI Context/My Task]]");
	});

	it("slugifies the title in the reference", () => {
		const entry = buildJournalEntry("Fix: bug #42");
		assert.equal(entry, "- Saved AI context: [[AI Context/Fix bug 42]]");
	});
});

describe("upsertJournalEntry", () => {
	it("appends new entry to empty journal", () => {
		const result = upsertJournalEntry("", "My Task");
		assert.equal(result, "- Saved AI context: [[AI Context/My Task]]\n");
	});

	it("appends new entry to existing journal content", () => {
		const journal = "- Did some work\n- Another note\n";
		const result = upsertJournalEntry(journal, "My Task");
		assert.ok(result.includes("- Did some work\n"));
		assert.ok(result.includes("- Another note\n"));
		assert.ok(result.endsWith("- Saved AI context: [[AI Context/My Task]]\n"));
	});

	it("increments to (2) on first re-save", () => {
		const journal = "- Saved AI context: [[AI Context/My Task]]\n";
		const result = upsertJournalEntry(journal, "My Task");
		assert.ok(result.includes("- Updated AI context: [[AI Context/My Task]] (2)"));
		assert.ok(!result.includes("Saved"));
	});

	it("increments (2) to (3)", () => {
		const journal = "- Updated AI context: [[AI Context/My Task]] (2)\n";
		const result = upsertJournalEntry(journal, "My Task");
		assert.ok(result.includes("- Updated AI context: [[AI Context/My Task]] (3)"));
	});

	it("increments (9) to (10)", () => {
		const journal = "- Updated AI context: [[AI Context/My Task]] (9)\n";
		const result = upsertJournalEntry(journal, "My Task");
		assert.ok(result.includes("- Updated AI context: [[AI Context/My Task]] (10)"));
	});

	it("does not duplicate when entry already exists", () => {
		const journal = "- Some note\n- Saved AI context: [[AI Context/My Task]]\n- Another note\n";
		const result = upsertJournalEntry(journal, "My Task");
		const matches = result.match(/AI Context\/My Task/g);
		assert.equal(matches?.length, 1, "should have exactly one reference to the context");
	});

	it("preserves surrounding journal content on update", () => {
		const journal = "- Before\n- Saved AI context: [[AI Context/My Task]]\n- After\n";
		const result = upsertJournalEntry(journal, "My Task");
		assert.ok(result.includes("- Before\n"));
		assert.ok(result.includes("- After\n"));
		assert.ok(result.includes("(2)"));
	});

	it("handles title with special regex characters", () => {
		const journal = "- Saved AI context: [[AI Context/Fix bug (urgent)]]\n";
		// Title gets slugified so parens are stripped: "Fix bug urgent"
		// But the entry in the journal uses the original pageName
		const result = upsertJournalEntry(journal, "Fix bug (urgent)");
		assert.ok(result.includes("(2)"));
	});

	it("does not match entries for different contexts", () => {
		const journal = "- Saved AI context: [[AI Context/Other Task]]\n";
		const result = upsertJournalEntry(journal, "My Task");
		// Should have both entries
		assert.ok(result.includes("[[AI Context/Other Task]]"));
		assert.ok(result.includes("[[AI Context/My Task]]"));
	});
});

describe("parseContextFiles", () => {
	it("extracts title from filename", () => {
		const items = parseContextFiles([`${LOGSEQ_DIR}/pages/AI Context___Graph Optimization.md`]);
		assert.equal(items.length, 1);
		assert.equal(items[0].title, "Graph Optimization");
		assert.equal(items[0].pageName, "AI Context/Graph Optimization");
	});

	it("ignores non-context files", () => {
		const items = parseContextFiles([
			`${LOGSEQ_DIR}/pages/AI Context___Valid.md`,
			`${LOGSEQ_DIR}/pages/Neo4j___Pregel.md`,
			`${LOGSEQ_DIR}/pages/Random.md`,
		]);
		assert.equal(items.length, 1);
		assert.equal(items[0].title, "Valid");
	});

	it("preserves full file path", () => {
		const fp = `${LOGSEQ_DIR}/pages/AI Context___Test.md`;
		const items = parseContextFiles([fp]);
		assert.equal(items[0].filePath, fp);
	});

	it("sorts by title", () => {
		const items = parseContextFiles([
			`${LOGSEQ_DIR}/pages/AI Context___Zebra.md`,
			`${LOGSEQ_DIR}/pages/AI Context___Apple.md`,
			`${LOGSEQ_DIR}/pages/AI Context___Mango.md`,
		]);
		assert.deepEqual(
			items.map((i) => i.title),
			["Apple", "Mango", "Zebra"],
		);
	});

	it("handles empty input", () => {
		assert.deepEqual(parseContextFiles([]), []);
	});

	it("handles filenames without .md extension", () => {
		const items = parseContextFiles([`${LOGSEQ_DIR}/pages/AI Context___NoExt`]);
		assert.equal(items.length, 0);
	});
});

describe("extractJSON", () => {
	const validJSON: ContextPageParams = {
		title: "Test",
		goal: "Build it",
		currentState: "In progress",
		keyDecisions: ["Use TS"],
		files: ["index.ts"],
		nextSteps: ["Deploy"],
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

	it("puts extraction instruction after conversation", () => {
		const prompt = buildExtractionPrompt("convo text");
		const convoIdx = prompt.indexOf("<conversation>");
		const instructIdx = prompt.indexOf("Now extract the context");
		assert.ok(instructIdx > convoIdx, "instruction should come after conversation");
	});

	it("includes additional focus when provided", () => {
		const prompt = buildExtractionPrompt("convo", { extraGoal: "Focus on the auth flow" });
		assert.ok(prompt.includes("<additional_focus>\nFocus on the auth flow\n</additional_focus>"));
	});

	it("omits additional_focus when not provided", () => {
		const prompt = buildExtractionPrompt("convo");
		assert.ok(!prompt.includes("additional_focus"));
	});

	it("includes available pages in XML tags", () => {
		const prompt = buildExtractionPrompt("convo", {
			availablePages: ["SimGym", "Neo4j", "Roman Fries"],
		});
		assert.ok(prompt.includes("<available_logseq_pages>"));
		assert.ok(prompt.includes("SimGym\nNeo4j\nRoman Fries"));
		assert.ok(prompt.includes("</available_logseq_pages>"));
	});

	it("omits available_logseq_pages when empty", () => {
		const prompt = buildExtractionPrompt("convo", { availablePages: [] });
		assert.ok(!prompt.includes("available_logseq_pages"));
	});

	it("omits available_logseq_pages when not provided", () => {
		const prompt = buildExtractionPrompt("convo");
		assert.ok(!prompt.includes("available_logseq_pages"));
	});

	it("includes update instruction when existingTitle provided", () => {
		const prompt = buildExtractionPrompt("convo", { existingTitle: "My Old Context" });
		assert.ok(prompt.includes('UPDATE to an existing context titled "My Old Context"'));
	});

	it("places available pages before instruction", () => {
		const prompt = buildExtractionPrompt("convo", {
			availablePages: ["SimGym"],
		});
		const pagesIdx = prompt.indexOf("<available_logseq_pages>");
		const instructIdx = prompt.indexOf("Now extract the context");
		assert.ok(pagesIdx < instructIdx, "pages should come before extraction instruction");
	});
});
