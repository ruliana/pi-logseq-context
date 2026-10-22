import path from "node:path";
// Shares the hook's runner and rule config so both lint the same way; neither ever passes --fix.
import { formatOutcome, lintPage } from "../logseq-lint.ts";

/** Lints saved pages without changing them. `messages` holds one block per page that did not pass. */
export async function lintSavedPages(files: string[], root: string): Promise<{ ok: boolean; messages: string[] }> {
	const messages: string[] = [];
	for (const file of files) {
		const outcome = await lintPage(file, root);
		if (outcome.kind !== "passed") messages.push(formatOutcome(outcome, path.relative(root, file)).trim());
	}
	return { ok: messages.length === 0, messages };
}
