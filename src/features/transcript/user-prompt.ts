import { UserMessageComponent, type Theme } from "@earendil-works/pi-coding-agent";
import {
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { fgRgb, getActiveGlobalTheme, isLightTheme, paintSurfaceRow, type RgbTuple } from "../../shared/ansi.ts";
import { getActiveHostRuntime } from "../../shared/host-runtime.ts";
import { claimHover, copyToClipboard, hookMethod } from "../../shared/runtime-hooks.ts";
import { formatTurnTime, sanitizeTurnText } from "../../shared/turn-index.ts";
import { requestRender } from "../../shared/ui-action-bridge.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

const PILL_FORMATTER_KEY = Symbol.for("conarti.pi-ui.prompt-pill-formatter.v1");
const PENDING_USER_TS_KEY = Symbol.for("conarti.pi-ui.pending-user-ts.v1");

export interface PromptPillDescriptor {
	readonly id: string;
	readonly label: string;
	readonly onClick?: (screenX: number, screenY: number) => void;
}

export interface PromptPillFormatContext {
	readonly theme: Theme;
	readonly isLight: boolean;
	readonly surfaceRgb: RgbTuple;
	readonly messageId?: string;
	readonly timestamp?: number | string;
	readonly surface: "transcript" | "sticky";
}

export interface PromptPillFormatResult {
	readonly text: string;
	readonly pills?: readonly PromptPillDescriptor[];
}

export type PromptPillFormatter = (
	rawText: string,
	context: PromptPillFormatContext,
) => string | PromptPillFormatResult;

export interface PromptCardHitBox {
	readonly y: number;
	readonly xStart: number;
	readonly xEnd: number;
}

export interface PromptPillHitTarget extends PromptCardHitBox {
	readonly id: string;
	readonly onClick?: (screenX: number, screenY: number) => void;
}

export interface RenderUserPromptCardOptions {
	readonly formattedTime?: string;
	readonly hovered?: boolean;
	readonly copied?: boolean;
	readonly showCopyBadge?: boolean;
	readonly maxContentLines?: number;
	readonly surface: "transcript" | "sticky";
	readonly messageId?: string;
	readonly timestamp?: number | string;
}

export interface RenderedUserPromptCard {
	readonly lines: string[];
	readonly totalContentLines: number;
	readonly truncated: boolean;
	readonly copyHit?: PromptCardHitBox;
	readonly pillHits: readonly PromptPillHitTarget[];
}

interface FormatterSlot {
	formatter?: PromptPillFormatter;
}

function getFormatterSlot(): FormatterSlot {
	const g = globalThis as Record<symbol, FormatterSlot | undefined>;
	if (!g[PILL_FORMATTER_KEY]) {
		g[PILL_FORMATTER_KEY] = {};
	}
	return g[PILL_FORMATTER_KEY]!;
}

export function registerPromptPillFormatter(formatter: PromptPillFormatter | undefined): () => void {
	const slot = getFormatterSlot();
	slot.formatter = formatter;
	return () => {
		if (slot.formatter === formatter) {
			slot.formatter = undefined;
		}
	};
}

export function getPromptPillFormatter(): PromptPillFormatter | undefined {
	return getFormatterSlot().formatter;
}

export function recordPendingUserMessageTimestamp(timestamp: number | string | undefined): void {
	if (timestamp === undefined) return;
	const g = globalThis as Record<symbol, { value?: number | string } | undefined>;
	g[PENDING_USER_TS_KEY] = { value: timestamp };
}

export function clearPendingUserMessageTimestamps(): void {
	const g = globalThis as Record<symbol, { value?: number | string } | undefined>;
	g[PENDING_USER_TS_KEY] = undefined;
}

function consumePendingUserMessageTimestamp(): number | string | undefined {
	const g = globalThis as Record<symbol, { value?: number | string } | undefined>;
	const current = g[PENDING_USER_TS_KEY]?.value;
	g[PENDING_USER_TS_KEY] = undefined;
	return current;
}

function resolveFallbackTimestampFromBranch(self: any): number | string | undefined {
	const runtime = getActiveHostRuntime();
	const branch = runtime?.ctx?.sessionManager?.getBranch?.();
	if (!Array.isArray(branch) || branch.length === 0) return undefined;

	const userEntries: any[] = branch.filter(
		(entry: any) => entry?.type === "message" && entry.message?.role === "user",
	);
	if (userEntries.length === 0) return undefined;

	if (self.messageId !== undefined) {
		const byId = userEntries.find((entry: any) => String(entry.id) === String(self.messageId));
		const ts = byId?.message?.timestamp ?? byId?.timestamp;
		if (ts !== undefined) return ts;
	}

	const chatRoot = runtime?.scroll?.children[0] ?? runtime?.chatContainer;
	if (!chatRoot) return undefined;

	const mountedCards: UserMessageComponent[] = [];
	const collect = (node: any): void => {
		if (!node) return;
		if (node instanceof UserMessageComponent) {
			mountedCards.push(node);
			return;
		}
		if (Array.isArray(node.children)) {
			for (const child of node.children) collect(child);
		}
	};
	collect(chatRoot);

	const cardIdx = mountedCards.indexOf(self);
	if (cardIdx === -1) return undefined;

	const tailOffset = Math.max(0, userEntries.length - mountedCards.length);
	const userOffset = Math.max(0, mountedCards.length - userEntries.length);
	const entryIdx = cardIdx + tailOffset - userOffset;
	const matched = entryIdx >= 0 && entryIdx < userEntries.length ? userEntries[entryIdx] : undefined;
	return matched?.message?.timestamp ?? matched?.timestamp;
}

/* Восстанавливает основной цвет текста после встроенных ANSI-пилюль, не затирая их собственный fg */
function styleBodyPreservingPills(line: string, rgb: RgbTuple): string {
	const fgEsc = `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
	const patched = line
		.replace(/\x1b\[0m/g, `\x1b[0m${fgEsc}`)
		.replace(/\x1b\[39m/g, fgEsc);
	return `${fgEsc}${patched}\x1b[39m`;
}

export function renderUserPromptCardLines(
	rawInputText: string,
	width: number,
	theme: Theme,
	options: RenderUserPromptCardOptions,
): RenderedUserPromptCard {
	const cleanRaw = sanitizeTurnText(rawInputText).replace(/\t/g, "  ").trim();
	if (!cleanRaw || width < 12) {
		return {
			lines: [],
			totalContentLines: 0,
			truncated: false,
			pillHits: [],
		};
	}

	const light = isLightTheme(theme);
	const surfaceRgb: RgbTuple = light
		? options.hovered
			? [228, 238, 252]
			: [237, 243, 252]
		: options.hovered
			? [33, 43, 60]
			: [27, 35, 50];

	const chevronRgb: RgbTuple = light
		? options.hovered
			? [29, 78, 216]
			: [37, 99, 235]
		: options.hovered
			? [125, 207, 255]
			: [97, 175, 239];
	const bodyRgb: RgbTuple = light ? [30, 41, 59] : [220, 229, 242];
	const dimRgb: RgbTuple = light ? [100, 116, 139] : [124, 138, 160];

	const formatter = getPromptPillFormatter();
	let formattedText = cleanRaw;
	let pillDescriptors: readonly PromptPillDescriptor[] = [];
	if (formatter) {
		const res = formatter(cleanRaw, {
			theme,
			isLight: light,
			surfaceRgb,
			messageId: options.messageId,
			timestamp: options.timestamp,
			surface: options.surface,
		});
		if (typeof res === "string") {
			formattedText = res;
		} else {
			formattedText = res.text;
			pillDescriptors = res.pills ?? [];
		}
	}

	const leftPad = width >= 32 ? "  " : " ";
	const rightPad = width >= 32 ? "  " : " ";
	const firstPrefix = `${leftPad}${fgRgb(chevronRgb, "› ")}`;
	const prefixWidth = leftPad.length + 2;
	const nextPrefix = " ".repeat(prefixWidth);

	/* Фиксированный правый отступ под HH:MM исключает перенос строк при наведении и появлении Copy */
	const timeGutterWidth = width >= 32 ? 9 : width >= 22 ? 7 : 0;
	const textAvail = Math.max(4, width - prefixWidth - timeGutterWidth);

	const wrappedRows: string[] = [];
	for (const logical of formattedText.split("\n")) {
		const chunks = wrapTextWithAnsi(logical, textAvail);
		for (const chunk of chunks.length > 0 ? chunks : [""]) {
			wrappedRows.push(chunk);
		}
	}

	const totalContentLines = wrappedRows.length;
	let truncated = false;
	let visibleRows = wrappedRows;
	if (options.maxContentLines !== undefined && wrappedRows.length > options.maxContentLines) {
		truncated = true;
		visibleRows = wrappedRows.slice(0, options.maxContentLines);
		const lastIdx = visibleRows.length - 1;
		if (lastIdx >= 0) {
			const trimmedLast = visibleRows[lastIdx]!.replace(/\s+$/, "");
			if (visibleWidth(trimmedLast) + 1 <= textAvail) {
				visibleRows[lastIdx] = `${trimmedLast}${fgRgb(dimRgb, "…")}`;
			} else {
				visibleRows[lastIdx] = `${truncateToWidth(trimmedLast, Math.max(1, textAvail - 1), "")}${fgRgb(dimRgb, "…")}`;
			}
		}
	}

	const lines: string[] = [];
	let copyHit: PromptCardHitBox | undefined;

	if (options.showCopyBadge && (options.hovered || options.copied) && width >= 20) {
		const rawLabel = options.copied ? "✓ Copied" : "Copy";
		const styledLabel = options.copied
			? fgRgb(light ? [21, 128, 61] : [140, 194, 101], rawLabel)
			: fgRgb(light ? [71, 85, 105] : [148, 168, 198], rawLabel);
		const labelWidth = visibleWidth(rawLabel);
		const padCount = Math.max(0, width - labelWidth - rightPad.length);
		copyHit = {
			y: 0,
			xStart: Math.max(0, padCount - 1),
			xEnd: Math.min(width - 1, padCount + labelWidth),
		};
		lines.push(
			paintSurfaceRow(
				`${" ".repeat(padCount)}${styledLabel}${rightPad}`,
				width,
				surfaceRgb[0],
				surfaceRgb[1],
				surfaceRgb[2],
			),
		);
	} else {
		lines.push(paintSurfaceRow("", width, surfaceRgb[0], surfaceRgb[1], surfaceRgb[2]));
	}

	const pillHits: PromptPillHitTarget[] = [];
	let nextPillIdx = 0;

	for (let i = 0; i < visibleRows.length; i++) {
		const prefix = i === 0 ? firstPrefix : nextPrefix;
		const rowBody = visibleRows[i]!;
		const styledBody = styleBodyPreservingPills(rowBody, bodyRgb);

		if (nextPillIdx < pillDescriptors.length) {
			const plainLine = stripTerminalSequences(rowBody);
			let searchFrom = 0;
			while (nextPillIdx < pillDescriptors.length) {
				const descriptor = pillDescriptors[nextPillIdx]!;
				const foundAt = plainLine.indexOf(descriptor.label, searchFrom);
				if (foundAt === -1) break;
				const xStart = prefixWidth + visibleWidth(plainLine.slice(0, foundAt));
				const xEnd = xStart + visibleWidth(descriptor.label);
				pillHits.push({
					id: descriptor.id,
					y: i + 1,
					xStart,
					xEnd,
					onClick: descriptor.onClick,
				});
				searchFrom = foundAt + descriptor.label.length;
				nextPillIdx++;
			}
		}

		const timeStr = i === 0 && options.formattedTime && timeGutterWidth > 0 ? options.formattedTime : "";
		const rightStyled = timeStr ? `${fgRgb(dimRgb, timeStr)}${rightPad}` : "";
		const gap = " ".repeat(
			Math.max(0, width - prefixWidth - visibleWidth(styledBody) - visibleWidth(rightStyled)),
		);
		lines.push(
			paintSurfaceRow(
				`${prefix}${styledBody}${gap}${rightStyled}`,
				width,
				surfaceRgb[0],
				surfaceRgb[1],
				surfaceRgb[2],
			),
		);
	}

	lines.push(paintSurfaceRow("", width, surfaceRgb[0], surfaceRgb[1], surfaceRgb[2]));

	return {
		lines,
		totalContentLines,
		truncated,
		copyHit,
		pillHits,
	};
}

export function installUserPromptCards(): void {
	const proto = UserMessageComponent.prototype as any;

	hookMethod(
		proto,
		"rebuild",
		"transcript.userPromptRebuild",
		(self, args, original) => {
			if (self.timestamp === undefined) {
				const pendingTs = consumePendingUserMessageTimestamp();
				if (pendingTs !== undefined) {
					self.timestamp = pendingTs;
				}
			}
			return original.apply(self, args);
		},
	);

	hookMethod(
		proto,
		"render",
		"transcript.userPromptRender",
		(self, args) => {
			const width = args[0] as number;
			const rawText = String(self.text ?? "").trim();
			if (!rawText || width < 12) return [];

			const theme = getActiveGlobalTheme(self?.theme);
			const effectiveTs = self.timestamp ?? resolveFallbackTimestampFromBranch(self);
			const formattedTime = formatTurnTime(effectiveTs);

			const rendered = renderUserPromptCardLines(rawText, width, theme, {
				formattedTime,
				hovered: Boolean(self.__conartiHovered),
				copied: Boolean(self.__conartiCopied),
				showCopyBadge: true,
				surface: "transcript",
				messageId: self.messageId !== undefined ? String(self.messageId) : undefined,
				timestamp: effectiveTs,
			});

			self.__conartiCopyHit = rendered.copyHit;
			self.__conartiPillHits = rendered.pillHits;

			const out = rendered.lines;
			if (out.length > 0) {
				out[0] = OSC133_ZONE_START + out[0];
				out[out.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + out[out.length - 1];
			}
			return out;
		},
		["pi.grok-ui.hook.chat.userPromptRender"],
	);

	hookMethod(
		proto,
		"handleMouse",
		"transcript.userPromptMouse",
		(self, args) => {
			const event = args[0] as TuiMouseEvent;

			if (event.type === "move") {
				claimHover(self, () => {
					if (self.__conartiHovered) {
						self.__conartiHovered = false;
						requestRender();
					}
				});
				if (!self.__conartiHovered) {
					self.__conartiHovered = true;
					return { handled: true, render: true };
				}
				return undefined;
			}

			const copyHit = self.__conartiCopyHit as PromptCardHitBox | undefined;
			const pillHits = (self.__conartiPillHits as readonly PromptPillHitTarget[] | undefined) ?? [];
			const matchedCopy =
				copyHit && event.y === copyHit.y && event.x >= copyHit.xStart && event.x <= copyHit.xEnd;
			const matchedPill = pillHits.find(
				(hit) => event.y === hit.y && event.x >= hit.xStart && event.x < hit.xEnd,
			);

			if (event.type === "press" && event.button === "left" && (matchedCopy || matchedPill)) {
				return { handled: true, render: false };
			}

			if (event.type === "click" && event.button === "left") {
				if (matchedCopy) {
					copyToClipboard(String(self.text ?? "").trim());
					self.__conartiCopied = true;
					requestRender();
					setTimeout(() => {
						self.__conartiCopied = false;
						requestRender();
					}, 1300).unref?.();
					return { handled: true, render: true };
				}
				if (matchedPill) {
					matchedPill.onClick?.(event.screenX, event.screenY);
					return { handled: true, render: true };
				}
			}

			return undefined;
		},
		["pi.grok-ui.hook.chat.userPromptMouse"],
	);
}
