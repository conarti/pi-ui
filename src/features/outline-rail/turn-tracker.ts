import { UserMessageComponent, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ScrollView } from "@earendil-works/pi-tui";

export interface OutlineTurn {
	id: string;
	ordinal: number;
	title: string;
	prompt: string;
}

function stripControls(text: string): string {
	return text
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

function extractPromptVisibleText(content: unknown): string {
	if (typeof content === "string") return stripControls(content);
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((b) =>
			b?.type === "text" && typeof b.text === "string"
				? [stripControls(b.text)]
				: b?.type === "image"
					? ["[изображение]"]
					: [],
		)
		.join("\n\n");
}

function summarizeTitle(prompt: string, ordinal: number): string {
	const oneLine = prompt.replace(/\s+/g, " ").trim();
	return oneLine || `Реплика #${ordinal}`;
}

export function appendBranchTurns(turns: OutlineTurn[], entries: readonly any[]): OutlineTurn[] {
	for (const e of entries) {
		if (e?.type !== "message" || e.message?.role !== "user") continue;
		const prompt = extractPromptVisibleText(e.message.content).trim();
		if (!prompt) continue;
		const ordinal = turns.length + 1;
		turns.push({
			id: String(e.id ?? ordinal),
			ordinal,
			title: summarizeTitle(prompt, ordinal),
			prompt,
		});
	}
	return turns;
}

export function createTurnsReader(ctx: ExtensionContext): () => OutlineTurn[] {
	let seenIds: string[] = [];
	let cached: OutlineTurn[] = [];

	return () => {
		const branch = ctx.sessionManager.getBranch();
		let same = 0;
		const max = Math.min(seenIds.length, branch.length);
		while (same < max && seenIds[same] === branch[same]?.id) same++;

		if (same === seenIds.length && branch.length >= seenIds.length) {
			if (branch.length > seenIds.length) {
				cached = appendBranchTurns(cached.slice(), branch.slice(seenIds.length));
			}
		} else {
			cached = appendBranchTurns([], branch);
		}
		seenIds = branch.map((e: any) => e.id);
		return cached;
	};
}

function collectMountedUserComponents(node: any, out: UserMessageComponent[] = []): UserMessageComponent[] {
	if (!node) return out;
	if (node instanceof UserMessageComponent) {
		out.push(node);
		return out;
	}
	if (Array.isArray(node.children)) {
		for (const ch of node.children) collectMountedUserComponents(ch, out);
	}
	if (node.child && node.child !== node && !(node.children ?? []).includes(node.child)) {
		collectMountedUserComponents(node.child, out);
	}
	return out;
}

export function collectPromptRowOffsets(
	doc: any,
	turns: readonly OutlineTurn[],
	width: number,
	heightsOut?: number[],
): number[] {
	const users = collectMountedUserComponents(doc);
	const lines: string[] = doc.render(width);
	const rendered = users.map((u) => u.render(width));
	const needles = rendered.map((r) => r[0]);
	const wanted = new Set(needles.filter(Boolean));
	const rows = new Map<string, number[]>();

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (!wanted.has(line)) continue;
		const list = rows.get(line);
		if (list) list.push(i);
		else rows.set(line, [i]);
	}

	const needleRank = new Array<number>(users.length).fill(0);
	const seen = new Map<string, number>();
	for (let i = 0; i < users.length; i++) {
		const needle = needles[i];
		if (!needle) continue;
		const rank = seen.get(needle) ?? 0;
		needleRank[i] = rank;
		seen.set(needle, rank + 1);
	}

	// Compaction can hide older prompts while branch still holds them; align from the tail
	const tailOffset = Math.max(0, turns.length - users.length);

	return turns.map((_turn, tIdx) => {
		const uIdx = tIdx - tailOffset;
		if (heightsOut) {
			heightsOut[tIdx] = uIdx >= 0 && rendered[uIdx] ? Math.max(1, rendered[uIdx]!.length) : 1;
		}
		if (uIdx < 0 || uIdx >= users.length) return 0;
		const needle = needles[uIdx];
		if (needle) {
			const row = rows.get(needle)?.[needleRank[uIdx]!];
			if (row !== undefined) return row;
		}
		return 0;
	});
}

export function jumpScrollToTurn(scroll: ScrollView, requestRender: () => void, targetY: number): void {
	scroll.scrollTo(Math.max(0, targetY), { disableFollow: true });
	requestRender();
}
