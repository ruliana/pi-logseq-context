import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveHandoff } from "./save.ts";
import type { ContextPageParams } from "./context.ts";

const params = (title: string): ContextPageParams => ({ title, goal: "G", currentState: "S", keyDecisions: [], files: [] });
const now = new Date("2026-11-06T10:00:00-05:00");

describe("saveHandoff", () => {
	let dir = "";
	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "save-test-"));
		mkdirSync(`${dir}/ai-handoff`);
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("update keeps every frontmatter key of the loaded handoff", () => {
		const filePath = `${dir}/ai-handoff/review.md`;
		const front = 'type: ai-handoff\ntitle: "AI Handoff/Review"\ntags: ["ai", "handoff", "simgym"]\nproject: "[SimGym](/simgym.md)"\ncreated: "2026-10-01"\nstatus: "changes-pushed"';
		writeFileSync(filePath, `---\n${front}\n---\n\nOld\n`);
		const snapshot = { filePath, title: "Review", pageName: "AI Handoff/Review", loadedAfterEntryId: null };
		saveHandoff(params("Review"), { dir, snapshot, now });
		const page = readFileSync(filePath, "utf-8");
		assert.ok(page.startsWith(`---\n${front}\nupdated: "2026-11-06"\n---\n\n**Goal**`));
	});

	it("a new handoff gets type ai-handoff", () => {
		const { targetPath } = saveHandoff(params("Fresh"), { dir, now });
		assert.ok(readFileSync(targetPath, "utf-8").startsWith("---\ntype: ai-handoff\n"));
	});

	it("a new handoff never overwrites a page with the same slug", () => {
		const old = `${dir}/ai-handoff/fix-judge-creation.md`;
		writeFileSync(old, "---\ntype: ai-handoff\n---\n\nJune handoff\n");
		const first = saveHandoff(params("fix: Judge creation!"), { dir, now });
		assert.equal(first.targetPath, `${dir}/ai-handoff/fix-judge-creation-2.md`);
		const second = saveHandoff(params("fix: Judge creation!"), { dir, now });
		assert.equal(second.targetPath, `${dir}/ai-handoff/fix-judge-creation-3.md`);
		assert.equal(readFileSync(old, "utf-8"), "---\ntype: ai-handoff\n---\n\nJune handoff\n");
		const journal = readFileSync(first.journalFile, "utf-8");
		assert.ok(journal.includes("(/ai-handoff/fix-judge-creation-2.md)") && journal.includes("(/ai-handoff/fix-judge-creation-3.md)"));
	});

	it("titles made only of symbols do not overwrite each other", () => {
		const a = saveHandoff(params("???"), { dir, now });
		const b = saveHandoff(params("!!!"), { dir, now });
		assert.notEqual(a.targetPath, b.targetPath);
		assert.equal(b.targetPath, `${dir}/ai-handoff/untitled-2.md`);
	});

	it("a handoff line never joins the Daily TODO list", () => {
		mkdirSync(`${dir}/journals`);
		writeFileSync(`${dir}/journals/2026-11-06.md`, '---\ntype: journal\ntitle: "2026-11-06"\ndate: "2026-11-06"\n---\n\n[Daily TODO](/daily-todo.md)\n- One\n- Two\n');
		const { journalFile } = saveHandoff(params("Fresh"), { dir, now });
		assert.ok(readFileSync(journalFile, "utf-8").includes("- Two\n\n* Created AI handoff:"));
	});
});
