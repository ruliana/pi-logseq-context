// Acceptance: save a handoff into a throwaway clone of a real bundle and let `tessela lint` judge the files.
// Set TESSELA_BUNDLE to clone another bundle than ~/tessela. Skipped when tessela or the bundle is missing.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveHandoff } from "./save.ts";
import type { ContextPageParams } from "./context.ts";

const source = process.env.TESSELA_BUNDLE ?? `${process.env.HOME}/tessela`;
const haveTessela = spawnSync("tessela", ["--version"]).status === 0;
const skip = !haveTessela || !existsSync(source) ? "needs the tessela CLI and a bundle to clone" : false;

const params: ContextPageParams = {
	title: "Acceptance: Handoff #1 (copy)",
	goal: "Port the handoff writer to [[Tessela]]\nand keep the page lint-clean.",
	currentState: "Written at 2026-11-06 10:00 by the acceptance test; see `/tmp/x.ts`.",
	keyDecisions: ["Use [SimGym](/simgym.md) as the example link"],
	files: [{ reason: "Writer under test", paths: ["/Users/ronie/.pi/agent/extensions/logseq-context/save.ts"] }],
	references: ["https://example.com/pr/1", "[[Sidekick]]", "/simgym.md"],
};

function lintFindings(bundle: string, files: string[]) {
	// Exit 1 only means errors somewhere in the bundle, so read the JSON, not the exit code.
	const out = spawnSync("tessela", ["lint", bundle, "--json"], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
	const all = JSON.parse(out.stdout) as { rule: string; severity: string; path: string; line: number; message: string }[];
	return all.filter((d) => files.includes(d.path) && d.severity !== "info");
}

describe("handoff written into a bundle", { skip }, () => {
	let bundle = "";
	before(() => {
		bundle = mkdtempSync(path.join(tmpdir(), "handoff-acceptance-"));
		execFileSync("git", ["clone", "-q", source, bundle]);
	});
	after(() => rmSync(bundle, { recursive: true, force: true }));

	it("the judge is not blind: a page without frontmatter is flagged", () => {
		writeFileSync(`${bundle}/planted.md`, "no frontmatter\n");
		assert.equal(lintFindings(bundle, ["planted.md"]).length, 1);
		rmSync(`${bundle}/planted.md`);
	});

	it("creates a new journal day and a page that tessela lint accepts", () => {
		const now = new Date("2026-11-06T10:00:00-05:00");
		const { targetPath, journalFile } = saveHandoff(params, { dir: bundle, now });
		assert.equal(targetPath, `${bundle}/ai-handoff/acceptance-handoff-1-copy.md`);
		assert.equal(journalFile, `${bundle}/journals/2026-11-06.md`);
		assert.deepEqual(lintFindings(bundle, ["ai-handoff/acceptance-handoff-1-copy.md", "journals/2026-11-06.md"]), []);
		const journal = readFileSync(journalFile, "utf-8");
		assert.ok(journal.includes("- Created AI handoff: [AI Handoff/Acceptance Handoff 1 (copy)](/ai-handoff/acceptance-handoff-1-copy.md)\n"));
		if (process.env.SHOW_PAGE) console.log(readFileSync(targetPath, "utf-8"), "\n----\n", journal);
	});

	it("bumps the counter on an update the same day without breaking lint", () => {
		const now = new Date("2026-11-06T11:00:00-05:00");
		const filePath = `${bundle}/ai-handoff/acceptance-handoff-1-copy.md`;
		const snapshot = { filePath, title: "Acceptance Handoff 1 (copy)", pageName: "AI Handoff/Acceptance Handoff 1 (copy)", loadedAfterEntryId: null };
		saveHandoff({ ...params, currentState: "Second save." }, { dir: bundle, snapshot, now });
		const journal = readFileSync(`${bundle}/journals/2026-11-06.md`, "utf-8");
		assert.ok(journal.includes("- Updated AI handoff: [AI Handoff/Acceptance Handoff 1 (copy)](/ai-handoff/acceptance-handoff-1-copy.md) (2)\n"));
		assert.equal(journal.match(/AI handoff/g)?.length, 1);
		assert.deepEqual(lintFindings(bundle, ["ai-handoff/acceptance-handoff-1-copy.md", "journals/2026-11-06.md"]), []);
	});

	it("appends to an existing journal that has no final newline", () => {
		const journal = `${bundle}/journals/2026-11-07.md`;
		writeFileSync(journal, '---\ntype: journal\ntitle: "2026-11-07"\ndate: "2026-11-07"\n---\n\n[Daily TODO](/daily-todo.md)\n- Existing item');
		saveHandoff({ ...params, title: "Second Page" }, { dir: bundle, now: new Date("2026-11-07T09:00:00-05:00") });
		const text = readFileSync(journal, "utf-8");
		assert.ok(text.includes("- Existing item\n\n* Created AI handoff: [AI Handoff/Second Page](/ai-handoff/second-page.md)\n"));
		assert.deepEqual(lintFindings(bundle, ["ai-handoff/second-page.md", "journals/2026-11-07.md"]), []);
		// The judge for finding 4: the handoff line must not become a child of the Daily TODO paragraph.
		const out = spawnSync("tessela", ["query", bundle, "--page", "journals/2026-11-07", "--text", "AI handoff", "--json"], { encoding: "utf-8" });
		const blocks = JSON.parse(out.stdout) as { parent: string | null; path_refs: string[] }[];
		assert.equal(blocks.length, 1);
		assert.equal(blocks[0].parent, null);
		assert.ok(!blocks[0].path_refs.includes("daily-todo"));
	});

	it("updates a loaded handoff in place and keeps its created date", () => {
		const filePath = `${bundle}/ai-handoff/acceptance-handoff-1-copy.md`;
		const snapshot = { filePath, title: "Acceptance Handoff 1 (copy)", pageName: "AI Handoff/Acceptance Handoff 1 (copy)", loadedAfterEntryId: null };
		saveHandoff({ ...params, currentState: "Third save." }, { dir: bundle, snapshot, now: new Date("2026-11-08T09:00:00-05:00") });
		const page = readFileSync(filePath, "utf-8");
		assert.ok(page.includes('created: "2026-11-06"') && page.includes('updated: "2026-11-08"') && page.includes("Third save."));
		assert.deepEqual(lintFindings(bundle, ["ai-handoff/acceptance-handoff-1-copy.md", "journals/2026-11-08.md"]), []);
	});
});
