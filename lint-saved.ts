import path from "node:path";
// Shares the hook's runner so both lint the same way; neither ever rewrites a page.
import { formatOutcome, lintTesselaPage } from "../logseq-lint.ts";

/** Lints saved pages of the Tessela bundle at `root` without changing them. `messages` holds one block per page that did not pass. */
export async function lintSavedPages(files: string[], root: string): Promise<{ ok: boolean; messages: string[] }> {
	const outcomes = await Promise.all(files.map((file) => lintTesselaPage(file, root)));
	const messages = outcomes.flatMap((outcome, i) =>
		outcome.kind === "passed" ? [] : [formatOutcome(outcome, path.relative(root, files[i]), "tessela-lint").trim()],
	);
	return { ok: messages.length === 0, messages };
}
