import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	NOTES_DIR,
	buildContextPage,
	conceptHref,
	contextPagePath,
	extractCreatedDate,
	journalPath,
	journalRef,
	upsertJournalEntry,
	type ContextPageParams,
	type LoadedContextState,
} from "./context.ts";

/** Write through a temp file in the same folder, so a reader never sees half a page. */
export function writeFileAtomic(filePath: string, content: string): void {
	mkdirSync(path.dirname(filePath), { recursive: true });
	const tmp = `${filePath}.tmp-${process.pid}`;
	writeFileSync(tmp, content, "utf-8");
	renameSync(tmp, filePath);
}

/**
 * Write the handoff page (a new one, or the loaded one when `snapshot` is set) and
 * add or bump its line in today's journal, creating the journal file if needed.
 */
export function saveHandoff(
	extracted: ContextPageParams,
	options: { snapshot?: LoadedContextState | null; dir?: string; now?: Date } = {},
): { targetPath: string; journalFile: string } {
	const { snapshot = null, dir = NOTES_DIR, now = new Date() } = options;
	let targetPath: string;
	let pageContent: string;

	if (snapshot) {
		let createdDate: string | undefined;
		try {
			createdDate = extractCreatedDate(readFileSync(snapshot.filePath, "utf-8")) ?? undefined;
		} catch {
			// File might have been deleted
		}
		pageContent = buildContextPage(extracted, { createdDate, updatedDate: journalRef(now) });
		targetPath = snapshot.filePath;
	} else {
		pageContent = buildContextPage(extracted, { createdDate: journalRef(now) });
		targetPath = contextPagePath(extracted.title, dir);
	}
	writeFileAtomic(targetPath, pageContent);

	const journalFile = journalPath(now, dir);
	const existing = existsSync(journalFile) ? readFileSync(journalFile, "utf-8") : "";
	const updated = upsertJournalEntry(existing, snapshot ? snapshot.title : extracted.title, {
		pageName: snapshot?.pageName,
		href: snapshot ? conceptHref(snapshot.filePath, dir) : undefined,
		date: journalRef(now),
	});
	writeFileAtomic(journalFile, updated);

	return { targetPath, journalFile };
}
