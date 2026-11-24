import { UserMessageComponent, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences, type Component } from "@earendil-works/pi-tui";
import { reconstructTurnPromptText } from "../features/prompt-chips/registry.ts";
import type { FullscreenShellContext } from "./fullscreen-layout.ts";

export type StickyDisplayMode = "auto" | "always";

export interface BranchTurn {
	readonly id: string;
	readonly ordinal: number;
	readonly title: string;
	readonly prompt: string;
	readonly timestamp?: number | string;
	readonly formattedTime: string;
}

export interface IndexedTurn extends BranchTurn {
	readonly index: number;
	readonly start: number;
	readonly end: number;
	readonly height: number;
	readonly component?: UserMessageComponent;
	readonly mounted: boolean;
}

export interface MountedUserMetric {
	readonly component: UserMessageComponent;
	readonly start: number;
	readonly end: number;
	readonly height: number;
}

export interface JumpToTurnOptions {
	direction?: "prev" | "next" | "jump";
	viewportWidth?: number;
}

export interface TranscriptTurnIndexOptions {
	shell: FullscreenShellContext;
	getBranch: ExtensionContext["sessionManager"]["getBranch"];
	getTranscriptWidth?: (viewportWidth?: number) => number;
}

const CONTROL_CHARS_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export function sanitizeTurnText(text: string): string {
	return stripTerminalSequences(text.replace(/\r\n?/g, "\n")).replace(CONTROL_CHARS_RE, "");
}

export function summarizeTurnTitle(prompt: string, ordinal: number): string {
	const oneLine = prompt.replace(/\s+/g, " ").trim();
	return oneLine || `Реплика #${ordinal}`;
}

export function formatTurnTime(timestamp: number | string | undefined): string {
	if (timestamp === undefined) return "";
	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return "";
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

const EXISTING_IMAGE_TOKEN_RE = /\[(?:Image #(\d+):[^\]]+|🖼 Image #(\d+))\]/gu;

function extractPromptVisibleText(content: unknown): string {
	if (typeof content === "string") return sanitizeTurnText(content);
	if (!Array.isArray(content)) return "";
	const textParts: string[] = [];
	let imageBlockCount = 0;
	for (const block of content) {
		if (block?.type === "text" && typeof block.text === "string") {
			textParts.push(sanitizeTurnText(block.text));
		} else if (block?.type === "image") {
			imageBlockCount += 1;
		}
	}
	const joinedText = textParts.join("\n\n");
	if (imageBlockCount === 0) return joinedText;

	let existingImageMarkers = 0;
	let maxImageNumber = 0;
	for (const m of joinedText.matchAll(EXISTING_IMAGE_TOKEN_RE)) {
		existingImageMarkers += 1;
		const parsed = Number.parseInt(m[1] ?? m[2] ?? "0", 10);
		if (parsed > maxImageNumber) maxImageNumber = parsed;
	}
	const remainingImages = imageBlockCount - existingImageMarkers;
	if (remainingImages <= 0) return joinedText;

	const pills = Array.from(
		{ length: remainingImages },
		(_, idx) => `[🖼 Image #${maxImageNumber + idx + 1}]`,
	).join(" ");
	const trimmedText = joinedText.trim();
	return trimmedText ? `${trimmedText} ${pills}` : pills;
}

function appendBranchTurns(turns: BranchTurn[], entries: readonly any[]): BranchTurn[] {
	for (const entry of entries) {
		if (entry?.type !== "message" || entry.message?.role !== "user") continue;
		const prompt = extractPromptVisibleText(entry.message.content).trim();
		if (!prompt) continue;
		const ordinal = turns.length + 1;
		const id = String(entry.id ?? ordinal);
		const timestamp: number | string | undefined = entry.message?.timestamp ?? entry.timestamp;
		const displayPrompt = reconstructTurnPromptText(prompt, {
			timestamp,
			messageId: id,
			entries,
		});
		turns.push({
			id,
			ordinal,
			title: summarizeTurnTitle(displayPrompt || prompt, ordinal),
			prompt,
			timestamp,
			formattedTime: formatTurnTime(timestamp),
		});
	}
	return turns;
}

function isWalkableContainer(node: Component): node is Container {
	return (
		node instanceof Container &&
		(node.constructor === Container ||
			node.constructor?.name === "Container" ||
			node.render === Container.prototype.render)
	);
}

/**
 * Walks the transcript container hierarchy structurally to compute exact top-row offsets
 * and rendered heights for each mounted `UserMessageComponent` without full-document
 * renders or ANSI string matching.
 */
export function collectStructuralUserMetrics(doc: Component, width: number): MountedUserMetric[] {
	const metrics: MountedUserMetric[] = [];
	let cursor = 0;

	const visit = (node: Component | undefined): void => {
		if (!node) return;
		if (node instanceof UserMessageComponent) {
			const lines = node.render(width);
			const height = lines.length;
			if (height > 0) {
				metrics.push({
					component: node,
					start: cursor,
					end: cursor + height,
					height,
				});
				cursor += height;
			}
			return;
		}
		if (isWalkableContainer(node)) {
			for (const child of node.children) {
				visit(child);
			}
			return;
		}
		const lines = node.render(width);
		cursor += lines.length;
	};

	visit(doc);
	return metrics;
}

function countMountedUserComponents(node: Component | undefined): number {
	if (!node) return 0;
	if (node instanceof UserMessageComponent) return 1;
	if (isWalkableContainer(node)) {
		let count = 0;
		for (const child of node.children) {
			count += countMountedUserComponents(child);
		}
		return count;
	}
	return 0;
}

export function selectStickyTurn(
	turns: readonly IndexedTurn[],
	scrollTop: number,
	mode?: StickyDisplayMode,
): IndexedTurn | undefined;
export function selectStickyTurn(
	turns: readonly IndexedTurn[],
	scrollTop: number,
	followingEnd: boolean,
	mode: StickyDisplayMode,
): IndexedTurn | undefined;
export function selectStickyTurn(
	turns: readonly IndexedTurn[],
	scrollTop: number,
	modeOrFollowingEnd: StickyDisplayMode | boolean = "auto",
	maybeMode?: StickyDisplayMode,
): IndexedTurn | undefined {
	const mode: StickyDisplayMode =
		typeof modeOrFollowingEnd === "string" ? modeOrFollowingEnd : (maybeMode ?? "auto");
	const mounted = turns.filter((t) => t.mounted);
	if (mounted.length === 0) return undefined;
	const above = mounted.findLast((item) => item.start < scrollTop);
	if (above) return above;
	return mode === "always" ? mounted[0] : undefined;
}

/**
 * Single shared source of truth for transcript `Turn` discovery, post-compaction tail
 * alignment, structural row/height caching, active `Turn` selection, and scroll navigation.
 */
export class TranscriptTurnIndex {
	private readonly shell: FullscreenShellContext;
	private readonly getBranch: ExtensionContext["sessionManager"]["getBranch"];
	private readonly getTranscriptWidth?: (viewportWidth?: number) => number;

	private seenEntries: readonly unknown[] = [];
	private branchTurns: BranchTurn[] = [];
	private branchVersion = 0;

	private cacheDoc: Component | undefined;
	private cacheBranchVersion = -1;
	private cacheWidth = -1;
	private cacheContentHeight = -1;
	private cacheMountedCount = -1;
	private cacheZeroHeightChildCount = -1;
	private cacheTurns: readonly IndexedTurn[] = [];

	constructor(options: TranscriptTurnIndexOptions) {
		this.shell = options.shell;
		this.getBranch = options.getBranch;
		this.getTranscriptWidth = options.getTranscriptWidth;
	}

	invalidate(): void {
		this.cacheDoc = undefined;
		this.cacheBranchVersion = -1;
		this.cacheWidth = -1;
		this.cacheContentHeight = -1;
		this.cacheMountedCount = -1;
		this.cacheZeroHeightChildCount = -1;
	}

	getBranchTurns(): readonly BranchTurn[] {
		const branch = this.getBranch() ?? [];
		let same = 0;
		const max = Math.min(this.seenEntries.length, branch.length);
		while (same < max && this.seenEntries[same] === branch[same]) {
			same++;
		}

		if (same === this.seenEntries.length && branch.length === this.seenEntries.length) {
			return this.branchTurns;
		}

		if (same === this.seenEntries.length && branch.length > this.seenEntries.length) {
			this.branchTurns = appendBranchTurns(this.branchTurns.slice(), branch.slice(this.seenEntries.length));
		} else {
			this.branchTurns = appendBranchTurns([], branch);
		}
		this.seenEntries = branch.slice();
		this.branchVersion += 1;
		return this.branchTurns;
	}

	getTurnCount(): number {
		const branchCount = this.getBranchTurns().length;
		const mountedCount = countMountedUserComponents(this.shell.scroll.children[0]);
		return Math.max(branchCount, mountedCount);
	}

	getContentWidth(viewportWidth?: number): number {
		const transcriptWidth = this.getTranscriptWidth
			? this.getTranscriptWidth(viewportWidth)
			: (viewportWidth ?? this.shell.tui.terminal?.columns ?? 80);
		return Math.max(1, this.shell.scroll.getContentWidth(Math.max(1, transcriptWidth)));
	}

	getTurns(viewportWidth?: number): readonly IndexedTurn[] {
		const branchTurns = this.getBranchTurns();
		const doc = this.shell.scroll.children[0];
		const contentWidth = this.getContentWidth(viewportWidth);
		const contentHeight = (this.shell.scroll as unknown as { contentHeight?: number }).contentHeight ?? 0;
		const mountedCount = countMountedUserComponents(doc);
		const zeroHeightChildCount = contentHeight === 0 && doc instanceof Container ? doc.children.length : -1;

		if (
			doc === this.cacheDoc &&
			this.branchVersion === this.cacheBranchVersion &&
			contentWidth === this.cacheWidth &&
			contentHeight === this.cacheContentHeight &&
			mountedCount === this.cacheMountedCount &&
			(contentHeight > 0 || zeroHeightChildCount === this.cacheZeroHeightChildCount)
		) {
			return this.cacheTurns;
		}

		const mountedUsers = doc ? collectStructuralUserMetrics(doc, contentWidth) : [];
		let indexed: IndexedTurn[];

		const buildMountedTurn = (metric: MountedUserMetric, idx: number): IndexedTurn => {
			const rawText: unknown = Reflect.get(metric.component, "text");
			const prompt = sanitizeTurnText(typeof rawText === "string" ? rawText : "").trim();
			const ordinal = idx + 1;
			const rawId: unknown = Reflect.get(metric.component, "messageId");
			const id = String(rawId ?? ordinal);
			const rawTs: unknown = Reflect.get(metric.component, "timestamp");
			const timestamp = typeof rawTs === "number" || typeof rawTs === "string" ? rawTs : undefined;
			const displayPrompt = reconstructTurnPromptText(prompt, {
				timestamp,
				messageId: id,
				entries: this.getBranch() ?? [],
			});
			return {
				id,
				index: idx,
				ordinal,
				title: summarizeTurnTitle(displayPrompt || prompt, ordinal),
				prompt,
				timestamp,
				formattedTime: formatTurnTime(timestamp),
				start: metric.start,
				end: metric.end,
				height: Math.max(1, metric.height),
				component: metric.component,
				mounted: true,
			};
		};

		if (branchTurns.length === 0 && mountedUsers.length > 0) {
			indexed = mountedUsers.map((metric, idx) => buildMountedTurn(metric, idx));
		} else if (mountedUsers.length > branchTurns.length) {
			/* Новая карточка реплики уже смонтирована на message_start до записи в ветку на message_end */
			indexed = branchTurns.map((bt, tIdx) => {
				const metric = mountedUsers[tIdx];
				return {
					...bt,
					index: tIdx,
					start: metric ? metric.start : 0,
					end: metric ? metric.end : 1,
					height: metric ? Math.max(1, metric.height) : 1,
					component: metric?.component,
					mounted: Boolean(metric),
				};
			});
			for (let mIdx = branchTurns.length; mIdx < mountedUsers.length; mIdx++) {
				indexed.push(buildMountedTurn(mountedUsers[mIdx]!, mIdx));
			}
		} else {
			/* При компакте старые карточки удаляются, но если у карточек есть явный messageId, сопоставляем сначала по нему */
			const branchIds = new Set(branchTurns.map((bt) => bt.id));
			const byId = new Map<string, MountedUserMetric>();
			const usedMetrics = new Set<MountedUserMetric>();
			for (const metric of mountedUsers) {
				const rawId: unknown = Reflect.get(metric.component, "messageId");
				if (rawId !== undefined && rawId !== null) {
					const idStr = String(rawId);
					if (branchIds.has(idStr) && !byId.has(idStr)) {
						byId.set(idStr, metric);
						usedMetrics.add(metric);
					}
				}
			}

			const tailOffset = Math.max(0, branchTurns.length - mountedUsers.length);
			indexed = branchTurns.map((bt, tIdx) => {
				let metric = byId.get(bt.id);
				if (!metric && byId.size === 0) {
					const uIdx = tIdx - tailOffset;
					metric = uIdx >= 0 && uIdx < mountedUsers.length ? mountedUsers[uIdx] : undefined;
				} else if (!metric) {
					const uIdx = tIdx - tailOffset;
					const candidate = uIdx >= 0 && uIdx < mountedUsers.length ? mountedUsers[uIdx] : undefined;
					if (candidate && !usedMetrics.has(candidate)) {
						metric = candidate;
					}
				}
				return {
					...bt,
					index: tIdx,
					start: metric ? metric.start : 0,
					end: metric ? metric.end : 1,
					height: metric ? Math.max(1, metric.height) : 1,
					component: metric?.component,
					mounted: Boolean(metric),
				};
			});
		}

		this.cacheDoc = doc;
		this.cacheBranchVersion = this.branchVersion;
		this.cacheWidth = contentWidth;
		this.cacheContentHeight = contentHeight;
		this.cacheMountedCount = mountedCount;
		this.cacheZeroHeightChildCount = zeroHeightChildCount;
		this.cacheTurns = indexed;
		return indexed;
	}

	jumpToTurn(turnIndex: number, options?: JumpToTurnOptions): IndexedTurn | undefined {
		const turns = this.getTurns(options?.viewportWidth);
		const target = turns[turnIndex];
		if (!target) return undefined;

		const { scroll } = this.shell;
		const targetRow = Math.max(0, target.start);
		const isFinal = turnIndex === turns.length - 1;
		const contentHeight = (scroll as unknown as { contentHeight?: number }).contentHeight ?? 0;
		const viewportHeight = scroll.viewportHeight ?? 0;
		const maxScrollTop = Math.max(0, contentHeight - viewportHeight);
		const movingForward =
			options?.direction === "next" || scroll.scrollTop < targetRow || targetRow >= maxScrollTop;

		if (isFinal && movingForward) {
			scroll.scrollToEnd();
		} else {
			scroll.scrollTo(targetRow, { disableFollow: true });
		}
		this.shell.requestRender();
		return target;
	}
}
