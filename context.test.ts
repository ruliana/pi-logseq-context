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
	buildUpdatePrompt,
	EXTRACT_SYSTEM_PROMPT,
	EXTRACT_SYSTEM_PROMPT_RULES,
	buildJournalEntry,
	upsertJournalEntry,
	extractCreatedDate,
	extractJSON,
	filenamesToPageNames,
	filePathToPageName,
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
		assert.equal(contextPageName("My Context"), "AI Handoff/My Context");
	});

	it("slugifies the title part", () => {
		assert.equal(contextPageName("Fix #123"), "AI Handoff/Fix 123");
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

describe("filePathToPageName", () => {
	it("converts a simple page path", () => {
		assert.equal(filePathToPageName(`${LOGSEQ_DIR}/pages/SimGym.md`), "SimGym");
	});

	it("converts a namespaced page path", () => {
		assert.equal(filePathToPageName(`${LOGSEQ_DIR}/pages/Neo4j___Pregel.md`), "Neo4j/Pregel");
	});

	it("converts a journal path to the Logseq journal name", () => {
		assert.equal(filePathToPageName(`${LOGSEQ_DIR}/journals/2026_05_27.md`), "2026-05-27");
	});
});

describe("extractCreatedDate", () => {
	it("extracts date from created:: property", () => {
		const content = "type:: #ai-handoff\ntags:: #ai #handoff\ncreated:: [[2026-03-15]]\n\n- ## Goal\n";
		assert.equal(extractCreatedDate(content), "2026-03-15");
	});

	it("returns null if no created:: property", () => {
		const content = "type:: #ai-handoff\ntags:: #ai #handoff\n\n- ## Goal\n";
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
		files: [
			{
				reason: "Implementation files for the feature",
				paths: ["/repo/src/index.ts", "/repo/src/utils.ts"],
			},
		],
	};

	it("starts with page properties in logseq format", () => {
		const page = buildContextPage(baseParams);
		assert.ok(page.startsWith("type:: #ai-handoff\n"));
		assert.ok(page.includes("tags:: #ai #handoff\n"));
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

	it("groups files under a reason with backtick formatting", () => {
		const page = buildContextPage(baseParams);
		assert.ok(page.includes("- ## Files\n\t- Implementation files for the feature\n\t\t- `/repo/src/index.ts`\n\t\t- `/repo/src/utils.ts`"));
	});

	it("does not render legacy next steps", () => {
		const page = buildContextPage({
			...baseParams,
			nextSteps: ["Write tests", "Deploy"],
		} as ContextPageParams & { nextSteps: string[] });
		assert.ok(!page.includes("## Next Steps"));
		assert.ok(!page.includes("Write tests"));
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
		assert.equal(entry, "- Created AI handoff: [[AI Handoff/My Task]]");
	});

	it("slugifies the title in the reference", () => {
		const entry = buildJournalEntry("Fix: bug #42");
		assert.equal(entry, "- Created AI handoff: [[AI Handoff/Fix bug 42]]");
	});
});

describe("upsertJournalEntry", () => {
	it("appends new entry to empty journal", () => {
		const result = upsertJournalEntry("", "My Task");
		assert.equal(result, "- Created AI handoff: [[AI Handoff/My Task]]\n");
	});

	it("appends new entry to existing journal content", () => {
		const journal = "- Did some work\n- Another note\n";
		const result = upsertJournalEntry(journal, "My Task");
		assert.ok(result.includes("- Did some work\n"));
		assert.ok(result.includes("- Another note\n"));
		assert.ok(result.endsWith("- Created AI handoff: [[AI Handoff/My Task]]\n"));
	});

	it("increments to (2) on first re-save", () => {
		const journal = "- Created AI handoff: [[AI Handoff/My Task]]\n";
		const result = upsertJournalEntry(journal, "My Task");
		assert.ok(result.includes("- Updated AI handoff: [[AI Handoff/My Task]] (2)"));
		assert.ok(!result.includes("Saved"));
	});

	it("updates legacy AI context journal entries using the loaded page reference", () => {
		const journal = "- Saved AI context: [[AI Context/My Task]]\n";
		const result = upsertJournalEntry(journal, "My Task", { pageName: "AI Context/My Task" });
		assert.ok(result.includes("- Updated AI handoff: [[AI Context/My Task]] (2)"));
		assert.ok(!result.includes("Saved AI context"));
	});

	it("increments (2) to (3)", () => {
		const journal = "- Updated AI handoff: [[AI Handoff/My Task]] (2)\n";
		const result = upsertJournalEntry(journal, "My Task");
		assert.ok(result.includes("- Updated AI handoff: [[AI Handoff/My Task]] (3)"));
	});

	it("increments (9) to (10)", () => {
		const journal = "- Updated AI handoff: [[AI Handoff/My Task]] (9)\n";
		const result = upsertJournalEntry(journal, "My Task");
		assert.ok(result.includes("- Updated AI handoff: [[AI Handoff/My Task]] (10)"));
	});

	it("does not duplicate when entry already exists", () => {
		const journal = "- Some note\n- Created AI handoff: [[AI Handoff/My Task]]\n- Another note\n";
		const result = upsertJournalEntry(journal, "My Task");
		const matches = result.match(/AI Handoff\/My Task/g);
		assert.equal(matches?.length, 1, "should have exactly one reference to the handoff");
	});

	it("preserves surrounding journal content on update", () => {
		const journal = "- Before\n- Created AI handoff: [[AI Handoff/My Task]]\n- After\n";
		const result = upsertJournalEntry(journal, "My Task");
		assert.ok(result.includes("- Before\n"));
		assert.ok(result.includes("- After\n"));
		assert.ok(result.includes("(2)"));
	});

	it("handles title with special regex characters", () => {
		const journal = "- Created AI handoff: [[AI Handoff/Fix bug (urgent)]]\n";
		// Title gets slugified so parens are stripped: "Fix bug urgent"
		// But the entry in the journal uses the original pageName
		const result = upsertJournalEntry(journal, "Fix bug (urgent)");
		assert.ok(result.includes("(2)"));
	});

	it("does not match entries for different handoffs", () => {
		const journal = "- Created AI handoff: [[AI Handoff/Other Task]]\n";
		const result = upsertJournalEntry(journal, "My Task");
		// Should have both entries
		assert.ok(result.includes("[[AI Handoff/Other Task]]"));
		assert.ok(result.includes("[[AI Handoff/My Task]]"));
	});
});

describe("parseContextFiles", () => {
	it("extracts title from filename", () => {
		const items = parseContextFiles([`${LOGSEQ_DIR}/pages/AI Handoff___Graph Optimization.md`]);
		assert.equal(items.length, 1);
		assert.equal(items[0].title, "Graph Optimization");
		assert.equal(items[0].pageName, "AI Handoff/Graph Optimization");
	});

	it("ignores non-handoff files", () => {
		const items = parseContextFiles([
			`${LOGSEQ_DIR}/pages/AI Handoff___Valid.md`,
			`${LOGSEQ_DIR}/pages/Neo4j___Pregel.md`,
			`${LOGSEQ_DIR}/pages/Random.md`,
		]);
		assert.equal(items.length, 1);
		assert.equal(items[0].title, "Valid");
	});

	it("includes legacy AI Context pages", () => {
		const items = parseContextFiles([`${LOGSEQ_DIR}/pages/AI Context___Legacy Task.md`]);
		assert.equal(items.length, 1);
		assert.equal(items[0].title, "Legacy Task");
		assert.equal(items[0].pageName, "AI Context/Legacy Task");
	});

	it("preserves full file path", () => {
		const fp = `${LOGSEQ_DIR}/pages/AI Handoff___Test.md`;
		const items = parseContextFiles([fp]);
		assert.equal(items[0].filePath, fp);
	});

	it("sorts by title", () => {
		const items = parseContextFiles([
			`${LOGSEQ_DIR}/pages/AI Handoff___Zebra.md`,
			`${LOGSEQ_DIR}/pages/AI Handoff___Apple.md`,
			`${LOGSEQ_DIR}/pages/AI Handoff___Mango.md`,
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
		const items = parseContextFiles([`${LOGSEQ_DIR}/pages/AI Handoff___NoExt`]);
		assert.equal(items.length, 0);
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
		const prompt = buildExtractionPrompt("convo", { existingTitle: "My Old Handoff" });
		assert.ok(prompt.includes('UPDATE to an existing handoff titled "My Old Handoff"'));
	});

	it("places available pages before instruction", () => {
		const prompt = buildExtractionPrompt("convo", {
			availablePages: ["SimGym"],
		});
		const pagesIdx = prompt.indexOf("<available_logseq_pages>");
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
		assert.ok(prompt.includes("<available_logseq_pages>\nSimGym\nNeo4j\n</available_logseq_pages>"));
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

	it("requires complete URL and Logseq references without overloading references", () => {
		const referencesRule = EXTRACT_SYSTEM_PROMPT_RULES.find((rule) => rule.id === "references")?.text ?? "";
		assert.ok(referencesRule.includes("include ALL Logseq page references and URL-backed references"));
		assert.ok(referencesRule.includes("full GitHub URL"));
		assert.ok(referencesRule.includes("Non-URL identifiers without a Logseq page"));
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
