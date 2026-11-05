import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	NOTES_DIR,
	HANDOFF_FOLDER,
	buildContextPage,
	contextPagePath,
	conceptHref,
	extractCreatedDate,
	journalPath,
	journalRef,
	slugify,
	updateContextPage,
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

/** Page path for a new handoff: the title's slug, or "-2", "-3", ... when that file exists already. */
export function newHandoffPath(title: string, dir = NOTES_DIR): string {
	const first = contextPagePath(title, dir);
	if (!existsSync(first)) return first;
	const slug = slugify(title);
	for (let n = 2; ; n++) {
		const candidate = `${dir}/${HANDOFF_FOLDER}/${slug}-${n}.md`;
		if (!existsSync(candidate)) return candidate;
	}
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
		let existingContent: string | null = null;
		try {
			existingContent = readFileSync(snapshot.filePath, "utf-8");
		} catch {
			// File might have been deleted
		}
		const kept = existingContent === null ? null : updateContextPage(existingContent, extracted, journalRef(now));
		pageContent =
			kept ??
			buildContextPage(extracted, {
				createdDate: (existingContent && extractCreatedDate(existingContent)) || undefined,
				updatedDate: journalRef(now),
			});
		targetPath = snapshot.filePath;
	} else {
		pageContent = buildContextPage(extracted, { createdDate: journalRef(now) });
		targetPath = newHandoffPath(extracted.title, dir);
	}
	writeFileAtomic(targetPath, pageContent);

	const journalFile = journalPath(now, dir);
	const existing = existsSync(journalFile) ? readFileSync(journalFile, "utf-8") : "";
	const updated = upsertJournalEntry(existing, snapshot ? snapshot.title : extracted.title, {
		pageName: snapshot?.pageName,
		href: conceptHref(targetPath, dir),
		date: journalRef(now),
	});
	writeFileAtomic(journalFile, updated);

	return { targetPath, journalFile };
}
