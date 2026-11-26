import { pathToFileURL } from "node:url";
import {
	getCapabilities,
	Markdown,
	sliceByColumn,
	stripTerminalSequences,
	visibleWidth,
	wrapTextWithAnsi,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import {
	getActiveGlobalTheme,
	getThemeSurfacePalette,
	paintThemeSurfaceRow,
	themeBgRgb,
	themeFgRgb,
} from "../../shared/ansi.ts";
import { getActiveHostRuntime } from "../../shared/host-runtime.ts";
import { t } from "../../shared/i18n.ts";
import {
	classifyMarkdownLinkTarget,
	findFilePathSpansInLine,
	type InspectableLinkTarget,
} from "../../shared/link-targets.ts";
import {
	serializeMarkdownTableToCsv,
	serializeMarkdownTableToMd,
	serializeMarkdownTableToTsv,
	stripBlockquoteMarkers,
	type MarkdownTableToken,
} from "../../shared/markdown-serializers.ts";
import {
	claimHover,
	copyToClipboard,
	createCopyFeedbackTimerRegistry,
	hookMethod,
} from "../../shared/runtime-hooks.ts";
import { markSelectionChrome, markSelectionCodeRow } from "../../shared/selection-copy.ts";
import { requestRender } from "../../shared/ui-action-bridge.ts";
import { openInspectableLinkTarget, toggleLinkTargetPopup } from "./link-target-popup.ts";

const LINK_OSC8_PREFIX = "\x1b]8;;conarti-link:";
const LINK_OSC8_CLOSE = "\x1b]8;;\x07";

interface BlockLinkHitMeta {
	readonly rowOffset: number;
	readonly xStart: number;
	readonly xEnd: number;
	readonly fromOsc8: boolean;
	readonly target: InspectableLinkTarget;
}

interface ResolvedLinkHit {
	readonly y: number;
	readonly xStart: number;
	readonly xEnd: number;
	readonly fromOsc8: boolean;
	readonly target: InspectableLinkTarget;
}

interface ActionButtonSpec {
	readonly key: string;
	readonly label: string;
	readonly payload: string;
}

function tableCopyButtons(token: MarkdownTableToken): ActionButtonSpec[] {
	return [
		{ key: "tsv", label: t("transcript.action.copyTsv"), payload: serializeMarkdownTableToTsv(token) },
		{ key: "csv", label: t("transcript.action.copyCsv"), payload: serializeMarkdownTableToCsv(token) },
		{ key: "md", label: t("transcript.action.copyMd"), payload: serializeMarkdownTableToMd(token) },
	];
}

interface BlockActionMeta {
	readonly kind: "code-footer" | "code-inline-hover" | "table-actions" | "blockquote-copy";
	readonly lang?: string;
	readonly raw?: string;
	readonly cardWidth: number;
	readonly startOffset: number;
	readonly endOffset: number;
	readonly actionOffset: number;
	readonly buttons: readonly ActionButtonSpec[];
}

interface ActionButtonHit {
	readonly id: string;
	readonly key: string;
	readonly label: string;
	readonly payload: string;
	readonly xStart: number;
	readonly xEnd: number;
}

interface ResolvedActionZone {
	readonly id: string;
	readonly kind: BlockActionMeta["kind"];
	readonly lang?: string;
	readonly cardWidth: number;
	readonly startRow: number;
	readonly endRow: number;
	readonly actionRow: number;
	readonly buttons: readonly ActionButtonHit[];
}

const markdownCopyTimers = createCopyFeedbackTimerRegistry<{
	__conartiCopiedAction?: string | null;
	__conartiCopyTimer?: unknown;
}>("conarti.pi-ui.markdown-copy-timers.v1", (target) => {
	target.__conartiCopiedAction = null;
});

export function clearMarkdownCopyTimers(): void {
	markdownCopyTimers.clearAll();
}

function isEligibleAssistantMarkdown(self: any): boolean {
	return Boolean(
		self.__conartiAssistantMarkdown &&
			!self.__conartiThinkingMarkdown &&
			!self.__conartiSkipReplyCopy &&
			!self.defaultTextStyle?.bgColor,
	);
}

function isShortUntaggedCode(lang: string, rawCode: string): boolean {
	if (lang.length > 0) return false;
	const lineCount = rawCode.length === 0 ? 0 : rawCode.split(/\r?\n/).length;
	return lineCount <= 2;
}

function renderCodeBodyLines(
	self: any,
	rawCode: string,
	lang: string,
	codeInnerW: number,
): { ansi: string; width: number; gapBefore?: number }[] {
	let highlighted: string[];
	if (typeof self.theme?.highlightCode === "function") {
		const cacheKey = `${lang}\0${rawCode}`;
		highlighted = self.blockHighlightedCode?.get(cacheKey);
		if (!highlighted) {
			highlighted = self.theme.highlightCode(rawCode, lang || undefined);
			self.blockHighlightedCode?.set(cacheKey, highlighted);
		}
	} else {
		highlighted = rawCode.split("\n").map((l: string) => self.theme.codeBlock(l));
	}

	const wrappedOut: { ansi: string; width: number; gapBefore?: number }[] = [];
	for (const hlLine of highlighted) {
		const expandedTabs = hlLine.replace(/\t/g, "  ");
		const source = stripTerminalSequences(expandedTabs);
		let offset = 0;
		for (const [index, ansi] of wrapTextWithAnsi(expandedTabs, codeInnerW).entries()) {
			const text = stripTerminalSequences(ansi);
			const start = source.indexOf(text, offset);
			/* Перенос не выводит пробелы на границе строк; сохраняем их для копирования. */
			const gapBefore = index === 0 ? undefined : Math.max(0, start - offset);
			offset = Math.max(offset, start) + text.length;
			wrappedOut.push({ ansi, width: visibleWidth(text), gapBefore });
		}
	}
	return wrappedOut.length > 0 ? wrappedOut : [{ ansi: "", width: 0 }];
}

function buildCodeFooterRow(
	activeTheme: any,
	palette: ReturnType<typeof getThemeSurfacePalette>,
	cardW: number,
	lang: string,
	state: "rest" | "hover" | "copied",
): { line: string; btnStartInCard: number; btnEndInCard: number } {
	const accentFg = palette.isLight ? palette.accent : palette.accentBright;
	const btnText = t(state === "copied" ? "transcript.action.copied" : "transcript.action.copy");
	const styledBtn =
		state === "copied"
			? themeFgRgb(activeTheme, palette.success, btnText)
			: state === "hover"
				? themeBgRgb(
						activeTheme,
						palette.codeHeaderActiveBg,
						themeFgRgb(activeTheme, accentFg, btnText),
					)
				: themeFgRgb(activeTheme, palette.codeActionMutedFg, btnText);

	const langPart = lang
		? `${themeFgRgb(activeTheme, palette.codeMetaFg, lang)}${themeFgRgb(activeTheme, palette.borderSubtle, " · ")}`
		: "";
	const rightCluster = `${langPart}${styledBtn}  `;
	const rightW = visibleWidth(rightCluster);
	const padLeft = " ".repeat(Math.max(0, cardW - rightW));
	const btnWidth = visibleWidth(btnText);
	const btnEndInCard = Math.max(0, cardW - 2);
	const btnStartInCard = Math.max(0, btnEndInCard - btnWidth);

	return {
		line: paintThemeSurfaceRow(
			activeTheme,
			`${padLeft}${rightCluster}`,
			cardW,
			palette.codeFooterBg,
		),
		btnStartInCard,
		btnEndInCard,
	};
}

function buildInlineActionBarRow(
	activeTheme: any,
	palette: ReturnType<typeof getThemeSurfacePalette>,
	zoneId: string,
	buttons: readonly ActionButtonSpec[],
	padX: number,
	hoveredAction: string | null,
	copiedAction: string | null,
): { row: string; hits: ActionButtonHit[] } {
	const accentFg = palette.isLight ? palette.accent : palette.accentBright;
	const parts: string[] = [];
	const hits: ActionButtonHit[] = [];
	let colCursor = padX;

	for (let i = 0; i < buttons.length; i += 1) {
		const btn = buttons[i]!;
		const actionId = `${zoneId}:${btn.key}`;
		const isCopied = copiedAction === actionId;
		const isHovered = hoveredAction === actionId;
		const text = isCopied ? t("transcript.action.copied") : btn.label;
		const styled = isCopied
			? themeFgRgb(activeTheme, palette.success, text)
			: isHovered
				? themeBgRgb(
						activeTheme,
						palette.badgeHoverBg,
						themeFgRgb(activeTheme, accentFg, text),
					)
				: themeFgRgb(activeTheme, palette.codeActionMutedFg, text);
		const w = visibleWidth(text);
		hits.push({
			id: actionId,
			key: btn.key,
			label: btn.label,
			payload: btn.payload,
			xStart: colCursor,
			xEnd: colCursor + w,
		});
		parts.push(styled);
		colCursor += w;
		if (i < buttons.length - 1) {
			parts.push("  ");
			colCursor += 2;
		}
	}

	return { row: parts.join(""), hits };
}

function spliceActionRowBeforeTrailingBlank(lines: string[], actionRow: string): void {
	if (lines.length > 0 && stripTerminalSequences(lines[lines.length - 1]!).trim() === "") {
		lines.splice(lines.length - 1, 0, actionRow);
	} else {
		lines.push(actionRow);
	}
}

function tagFilePaths(line: string, targets: InspectableLinkTarget[], cwd: string): string {
	if (line.includes("\x1b]8;")) return line;
	const spans = findFilePathSpansInLine(stripTerminalSequences(line), { cwd });
	if (spans.length === 0) return line;
	let out = "";
	let col = 0;
	for (const { xStart, xEnd, target } of spans) {
		out += sliceByColumn(line, col, xStart - col, true);
		const index = targets.push(target) - 1;
		out += `${LINK_OSC8_PREFIX}${index}\x07${sliceByColumn(line, xStart, xEnd - xStart, true)}${LINK_OSC8_CLOSE}`;
		col = xEnd;
	}
	return out + sliceByColumn(line, col, visibleWidth(line) - col, true);
}

function resolveNativeOsc8Href(target: InspectableLinkTarget | undefined): string | undefined {
	if (!target || !getCapabilities().hyperlinks) return undefined;
	if (target.kind === "url") return target.url;
	try {
		return pathToFileURL(target.resolvedPath).href;
	} catch {
		return undefined;
	}
}

function extractLineLinkHits(
	ansiLine: string,
	rowOffset: number,
	pendingLinks: readonly InspectableLinkTarget[],
	cwd: string,
	scanFilePaths: boolean,
): { cleanedLine: string; hits: BlockLinkHitMeta[] } {
	const hits: BlockLinkHitMeta[] = [];
	let cleanedLine = "";
	let col = 0;
	let i = 0;
	let activeSynthetic: { idx: number; startCol: number; emittedOsc8: boolean } | undefined;
	let activeOsc8: { href: string; startCol: number; label: string } | undefined;

	if (ansiLine.includes("\x1b]8;")) {
		while (i < ansiLine.length) {
			const escAt = ansiLine.indexOf("\x1b", i);
			if (escAt === -1) {
				const tail = ansiLine.slice(i);
				cleanedLine += tail;
				if (activeOsc8) activeOsc8.label += tail;
				col += visibleWidth(tail);
				break;
			}
			if (escAt > i) {
				const chunk = ansiLine.slice(i, escAt);
				cleanedLine += chunk;
				if (activeOsc8) activeOsc8.label += chunk;
				col += visibleWidth(chunk);
				i = escAt;
			}

			const synthOpen = /^\x1b\]8;;conarti-link:(\d+)(?:\x07|\x1b\\)/.exec(ansiLine.slice(i));
			if (synthOpen) {
				const idx = Number.parseInt(synthOpen[1]!, 10);
				const osc8Href = resolveNativeOsc8Href(pendingLinks[idx]);
				if (osc8Href) {
					cleanedLine += `\x1b]8;;${osc8Href}\x07`;
				}
				activeSynthetic = { idx, startCol: col, emittedOsc8: Boolean(osc8Href) };
				i += synthOpen[0].length;
				continue;
			}

			const osc8Close = /^\x1b\]8;;(?:\x07|\x1b\\)/.exec(ansiLine.slice(i));
			if (osc8Close) {
				if (activeSynthetic !== undefined) {
					const target = pendingLinks[activeSynthetic.idx];
					if (target && col > activeSynthetic.startCol) {
						hits.push({
							rowOffset,
							xStart: activeSynthetic.startCol,
							xEnd: col,
							fromOsc8: activeSynthetic.emittedOsc8,
							target,
						});
					}
					if (activeSynthetic.emittedOsc8) {
						cleanedLine += LINK_OSC8_CLOSE;
					}
					activeSynthetic = undefined;
					i += osc8Close[0].length;
					continue;
				}
				if (activeOsc8 !== undefined) {
					const target = classifyMarkdownLinkTarget(activeOsc8.href, activeOsc8.label, { cwd });
					if (target && col > activeOsc8.startCol) {
						hits.push({
							rowOffset,
							xStart: activeOsc8.startCol,
							xEnd: col,
							fromOsc8: true,
							target,
						});
					}
					activeOsc8 = undefined;
				}
				cleanedLine += osc8Close[0];
				i += osc8Close[0].length;
				continue;
			}

			const osc8Open = /^\x1b\]8;[^;]*;([^\x07\x1b]+)(?:\x07|\x1b\\)/.exec(ansiLine.slice(i));
			if (osc8Open) {
				activeOsc8 = { href: osc8Open[1]!, startCol: col, label: "" };
				cleanedLine += osc8Open[0];
				i += osc8Open[0].length;
				continue;
			}

			const anyEsc =
				/^\x1b(?:\[[0-9;?]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|_[^\x07\x1b]*(?:\x07|\x1b\\))/.exec(
					ansiLine.slice(i),
				);
			if (anyEsc) {
				cleanedLine += anyEsc[0];
				i += anyEsc[0].length;
				continue;
			}

			const ch = ansiLine[i]!;
			cleanedLine += ch;
			if (activeOsc8) activeOsc8.label += ch;
			col += 1;
			i += 1;
		}
	} else {
		cleanedLine = ansiLine;
	}

	if (scanFilePaths) {
		const plain = stripTerminalSequences(cleanedLine);
		const fileSpans = findFilePathSpansInLine(plain, { cwd });
		for (const span of fileSpans) {
			const overlapsLink = hits.some(
				(existing) => span.xStart < existing.xEnd && span.xEnd > existing.xStart,
			);
			if (!overlapsLink) {
				hits.push({
					rowOffset,
					xStart: span.xStart,
					xEnd: span.xEnd,
					fromOsc8: false,
					target: span.target,
				});
			}
		}
	}

	return { cleanedLine, hits };
}

export function installMarkdownCardsAndHeadings(): void {
	const proto = Markdown.prototype as any;

	hookMethod(
		proto,
		"renderInlineTokens",
		"transcript.renderInlineLinkTags",
		(self, args, original) => {
			const [tokens, styleContext] = args as [any[], any];
			if (
				!Array.isArray(tokens) ||
				!Array.isArray(self.__conartiPendingLinks) ||
				!isEligibleAssistantMarkdown(self)
			) {
				return original.apply(self, args);
			}

			const cwd = getActiveHostRuntime()?.ctx?.cwd ?? process.cwd();
			const targets: InspectableLinkTarget[] = self.__conartiPendingLinks;
			/* До переноса строк связываем весь путь с одной целью, как обычную ссылку OSC 8. */
			const renderPathAware = (slice: any[]) =>
				tagFilePaths(String(original.apply(self, [slice, styleContext]) ?? ""), targets, cwd);
			let out = "";
			let sliceStart = 0;

			for (let idx = 0; idx < tokens.length; idx += 1) {
				const tok = tokens[idx];
				if (tok?.type !== "link") continue;

				if (idx > sliceStart) {
					out += renderPathAware(tokens.slice(sliceStart, idx));
				}

				const renderedLink = String(original.apply(self, [[tok], styleContext]) ?? "");
				const target = classifyMarkdownLinkTarget(String(tok.href ?? ""), String(tok.text ?? ""), {
					cwd,
				});
				if (target && !renderedLink.includes("\x1b]8;")) {
					const linkIdx = self.__conartiPendingLinks.length;
					self.__conartiPendingLinks.push(target);
					out += `${LINK_OSC8_PREFIX}${linkIdx}\x07${renderedLink}${LINK_OSC8_CLOSE}`;
				} else {
					out += renderedLink;
				}
				sliceStart = idx + 1;
			}

			if (sliceStart < tokens.length) {
				out += renderPathAware(tokens.slice(sliceStart));
			}
			return out;
		},
	);

	hookMethod(
		proto,
		"renderToken",
		"transcript.renderToken",
		(self, args, original) => {
			const [token, width, nextTokenType, styleContext] = args as [
				any,
				number,
				string | undefined,
				any,
			];
			const isTopLevel = styleContext === undefined;
			const isStreaming = Boolean(self.__conartiStreaming);

			if (
				token?.type === "heading" &&
				typeof self.renderInlineTokens === "function" &&
				typeof self.getStylePrefix === "function"
			) {
				const depth: number = token.depth ?? 1;
				const activeTheme = getActiveGlobalTheme(self?.theme);
				const palette = getThemeSurfacePalette(activeTheme);
				let headingStyleFn: (text: string) => string;

				if (self.__conartiThinkingMarkdown) {
					headingStyleFn = (text: string) => self.theme.heading(self.theme.bold(text));
				} else if (depth === 1) {
					headingStyleFn = (text: string) =>
						self.theme.heading(self.theme.bold(self.theme.underline(text)));
				} else if (depth === 2) {
					headingStyleFn = (text: string) => self.theme.heading(self.theme.bold(text));
				} else if (depth === 3) {
					headingStyleFn = (text: string) =>
						themeFgRgb(activeTheme, palette.accent, self.theme.bold(text));
				} else {
					headingStyleFn = (text: string) =>
						themeFgRgb(activeTheme, palette.headingSubtle, self.theme.bold(text));
				}

				const headingStyleContext = {
					applyText: headingStyleFn,
					stylePrefix: self.getStylePrefix(headingStyleFn),
				};
				const headingText: string = self.renderInlineTokens(
					token.tokens || [],
					headingStyleContext,
				);
				const out: string[] = [headingText];
				if (nextTokenType && nextTokenType !== "space") out.push("");
				return out;
			}

			if (
				!self.__conartiThinkingMarkdown &&
				token?.type === "code" &&
				!self.defaultTextStyle?.bgColor &&
				width >= 16
			) {
				const lang = String(token.lang || "").trim();
				const rawCode = String(token.text ?? "");
				const activeTheme = getActiveGlobalTheme(self?.theme);
				const palette = getThemeSurfacePalette(activeTheme);
				const cardW = Math.max(12, width);
				const codeInnerW = Math.max(6, cardW - 4);
				const bodyLines = renderCodeBodyLines(self, rawCode, lang, codeInnerW);

				const markCodeRows = getActiveHostRuntime()?.isFullscreen;
				const out = bodyLines.map(({ ansi, width: textWidth, gapBefore }) => {
					const row = paintThemeSurfaceRow(activeTheme, `  ${ansi}`, cardW, palette.codeBodyBg);
					return markCodeRows ? markSelectionCodeRow(row, textWidth, gapBefore) : row;
				});

				/* Нижняя панель codeFooterBg только после завершения стриминга и только для >= 3 строк или с языком */
				if (
					isTopLevel &&
					!isStreaming &&
					isEligibleAssistantMarkdown(self) &&
					!isShortUntaggedCode(lang, rawCode)
				) {
					const footer = buildCodeFooterRow(activeTheme, palette, cardW, lang, "rest");
					out.push(footer.line);
				}

				if (nextTokenType && nextTokenType !== "space") out.push("");
				return out;
			}

			if (
				isTopLevel &&
				!isStreaming &&
				isEligibleAssistantMarkdown(self) &&
				token?.type === "table" &&
				Array.isArray(token.header) &&
				Array.isArray(token.rows) &&
				width >= 24
			) {
				const tableLines: string[] = [...(original.apply(self, args) as string[])];
				const activeTheme = getActiveGlobalTheme(self?.theme);
				const palette = getThemeSurfacePalette(activeTheme);
				const tableToken = token as MarkdownTableToken;
				const { row } = buildInlineActionBarRow(
					activeTheme,
					palette,
					"table",
					tableCopyButtons(tableToken),
					0,
					null,
					null,
				);
				spliceActionRowBeforeTrailingBlank(tableLines, row);
				return tableLines;
			}

			if (
				isTopLevel &&
				!isStreaming &&
				isEligibleAssistantMarkdown(self) &&
				token?.type === "blockquote" &&
				width >= 16
			) {
				const strippedMd = stripBlockquoteMarkers(String(token.raw ?? ""));
				const quoteLines: string[] = [...(original.apply(self, args) as string[])];
				if (strippedMd.length > 0) {
					const activeTheme = getActiveGlobalTheme(self?.theme);
					const palette = getThemeSurfacePalette(activeTheme);
					const { row } = buildInlineActionBarRow(
						activeTheme,
						palette,
						"quote",
						[{ key: "copy", label: t("transcript.action.copy"), payload: strippedMd }],
						0,
						null,
						null,
					);
					spliceActionRowBeforeTrailingBlank(quoteLines, row);
				}
				return quoteLines;
			}

			return original.apply(self, args);
		},
		["pi.grok-ui.hook.chat.renderToken"],
	);

	hookMethod(
		proto,
		"renderBlock",
		"transcript.renderBlock",
		(self, args, original) => {
			const [block, token, _nextTokenType, _width, contentWidth] = args as [
				any,
				any,
				string | undefined,
				number,
				number,
			];
			const pendingLinks: InspectableLinkTarget[] = [];
			self.__conartiPendingLinks = pendingLinks;
			let res: unknown;
			try {
				res = original.apply(self, args);
			} finally {
				self.__conartiPendingLinks = undefined;
			}
			const isStreaming = Boolean(self.__conartiStreaming);
			if (isStreaming || !isEligibleAssistantMarkdown(self) || !Array.isArray(block?.lines)) {
				block.__conartiBlockAction = undefined;
				block.__conartiLinkHits = undefined;
				return res;
			}

			const lines: string[] = block.lines;
			const hasTrailingBlank =
				lines.length > 0 && stripTerminalSequences(lines[lines.length - 1]!).trim() === "";
			const lastContentOffset = hasTrailingBlank ? lines.length - 2 : lines.length - 1;
			const cardWidth = Math.max(12, contentWidth ?? 12);

			if (token?.type === "code" && lastContentOffset >= 0 && cardWidth >= 16) {
				const lang = String(token.lang || "").trim();
				const rawCode = String(token.text ?? "");
				if (isShortUntaggedCode(lang, rawCode)) {
					block.__conartiBlockAction = {
						kind: "code-inline-hover",
						lang: "",
						raw: rawCode,
						cardWidth,
						startOffset: 0,
						endOffset: lastContentOffset,
						actionOffset: 0,
						buttons: [{ key: "copy", label: t("transcript.action.copy"), payload: rawCode }],
					} satisfies BlockActionMeta;
				} else {
					block.__conartiBlockAction = {
						kind: "code-footer",
						lang,
						raw: rawCode,
						cardWidth,
						startOffset: 0,
						endOffset: lastContentOffset,
						actionOffset: lastContentOffset,
						buttons: [{ key: "copy", label: t("transcript.action.copy"), payload: rawCode }],
					} satisfies BlockActionMeta;
				}
			} else if (
				token?.type === "table" &&
				Array.isArray(token.header) &&
				Array.isArray(token.rows) &&
				lastContentOffset >= 0 &&
				cardWidth >= 24
			) {
				const tableToken = token as MarkdownTableToken;
				block.__conartiBlockAction = {
					kind: "table-actions",
					cardWidth,
					startOffset: lastContentOffset,
					endOffset: lastContentOffset,
					actionOffset: lastContentOffset,
					buttons: tableCopyButtons(tableToken),
				} satisfies BlockActionMeta;
			} else if (token?.type === "blockquote" && lastContentOffset >= 0 && cardWidth >= 16) {
				const strippedMd = stripBlockquoteMarkers(String(token.raw ?? ""));
				if (strippedMd.length > 0) {
					block.__conartiBlockAction = {
						kind: "blockquote-copy",
						cardWidth,
						startOffset: lastContentOffset,
						endOffset: lastContentOffset,
						actionOffset: lastContentOffset,
						buttons: [{ key: "copy", label: t("transcript.action.copy"), payload: strippedMd }],
					} satisfies BlockActionMeta;
				} else {
					block.__conartiBlockAction = undefined;
				}
			} else {
				block.__conartiBlockAction = undefined;
			}

			/* Собираем кликабельные ссылки [text](url) и локальные пути path[:line[:col]] на всех не-action строках блока */
			const actionMeta: BlockActionMeta | undefined = block.__conartiBlockAction;
			const actionRowToSkip =
				actionMeta && actionMeta.kind !== "code-inline-hover" ? actionMeta.actionOffset : -1;
			const cwd = getActiveHostRuntime()?.ctx?.cwd ?? process.cwd();
			const blockLinkHits: BlockLinkHitMeta[] = [];
			const scanPathsInBlock = token?.type !== "code";

			for (let rowIdx = 0; rowIdx < lines.length; rowIdx += 1) {
				if (rowIdx === actionRowToSkip) continue;
				const { cleanedLine, hits } = extractLineLinkHits(
					lines[rowIdx]!,
					rowIdx,
					pendingLinks,
					cwd,
					scanPathsInBlock,
				);
				lines[rowIdx] = cleanedLine;
				if (hits.length > 0) {
					blockLinkHits.push(...hits);
				}
			}
			block.__conartiLinkHits = blockLinkHits.length > 0 ? blockLinkHits : undefined;

			return res;
		},
		["pi.grok-ui.hook.chat.renderBlock"],
	);

	hookMethod(
		proto,
		"render",
		"transcript.markdownRender",
		(self, args, original) => {
			const width = args[0] as number;
			const baseLines: string[] = original.apply(self, args);
			if (
				self.__conartiStreaming ||
				!isEligibleAssistantMarkdown(self) ||
				baseLines.length === 0 ||
				width < 16
			) {
				self.__conartiActionZones = [];
				self.__conartiLinkHits = [];
				self.__conartiMarkdownCache = undefined;
				return baseLines;
			}

			const activeTheme = getActiveGlobalTheme(self?.theme);
			const hoveredAction: string | null = self.__conartiHoveredAction ?? null;
			const copiedAction: string | null = self.__conartiCopiedAction ?? null;
			const isFullscreen = Boolean(getActiveHostRuntime()?.isFullscreen);

			type CachedBlockSnapshot = {
				readonly tokenIndex: number;
				readonly rowCursor: number;
				readonly linkHits?: readonly BlockLinkHitMeta[];
				readonly meta?: BlockActionMeta;
			};
			type MarkdownRenderCache = {
				readonly baseLines: string[];
				readonly width: number;
				readonly theme: typeof activeTheme;
				readonly hoveredAction: string | null;
				readonly copiedAction: string | null;
				readonly isFullscreen: boolean;
				readonly blockSnapshots: readonly CachedBlockSnapshot[];
				readonly zones: ResolvedActionZone[];
				readonly linkHits: ResolvedLinkHit[];
				readonly outLines: string[];
			};

			const prevCache = self.__conartiMarkdownCache as MarkdownRenderCache | undefined;
			if (
				prevCache &&
				prevCache.baseLines === baseLines &&
				prevCache.width === width &&
				prevCache.theme === activeTheme &&
				prevCache.hoveredAction === hoveredAction &&
				prevCache.copiedAction === copiedAction &&
				prevCache.isFullscreen === isFullscreen
			) {
				self.__conartiActionZones = prevCache.zones;
				self.__conartiLinkHits = prevCache.linkHits;
				return prevCache.outLines;
			}

			const tokenBundle = self.cachedTokens?.deref?.();
			const blockMap: Map<string, any> | undefined = self.blocks?.deref?.();
			const padX: number = self.paddingX ?? 0;
			const palette = getThemeSurfacePalette(activeTheme);

			let blockSnapshots: CachedBlockSnapshot[];
			if (tokenBundle?.tokens && blockMap) {
				blockSnapshots = [];
				let rowCursor: number = self.paddingY ?? 0;
				for (let i = 0; i < tokenBundle.tokens.length; i += 1) {
					const tok = tokenBundle.tokens[i];
					const blk = blockMap.get(tok.raw);
					if (!blk?.lines) continue;
					const blkLinks: readonly BlockLinkHitMeta[] | undefined = blk.__conartiLinkHits;
					const meta: BlockActionMeta | undefined = blk.__conartiBlockAction;
					if (blkLinks || meta) {
						blockSnapshots.push({
							tokenIndex: i,
							rowCursor,
							linkHits: blkLinks,
							meta,
						});
					}
					rowCursor += blk.lines.length;
				}
			} else if (prevCache && prevCache.baseLines === baseLines && prevCache.width === width) {
				/* Сохраняем зоны кнопок и ссылок, даже если WeakRef cachedTokens уже собран GC */
				blockSnapshots = [...prevCache.blockSnapshots];
			} else {
				blockSnapshots = [];
			}

			const zones: ResolvedActionZone[] = [];
			const linkHits: ResolvedLinkHit[] = [];
			for (const snap of blockSnapshots) {
				if (snap.linkHits) {
					for (const lh of snap.linkHits) {
						linkHits.push({
							y: snap.rowCursor + lh.rowOffset,
							xStart: lh.xStart,
							xEnd: lh.xEnd,
							fromOsc8: lh.fromOsc8,
							target: lh.target,
						});
					}
				}
				const meta = snap.meta;
				if (meta) {
					const zoneId = `${meta.kind}-${snap.tokenIndex}`;
					const actionRow = snap.rowCursor + meta.actionOffset;
					const startRow = snap.rowCursor + meta.startOffset;
					const endRow = snap.rowCursor + meta.endOffset;
					let buttons: ActionButtonHit[] = [];

					if (meta.kind === "code-footer") {
						const actionId = `${zoneId}:copy`;
						const state =
							copiedAction === actionId
								? "copied"
								: hoveredAction === actionId
									? "hover"
									: "rest";
						const footer = buildCodeFooterRow(
							activeTheme,
							palette,
							meta.cardWidth,
							meta.lang ?? "",
							state,
						);
						buttons = [
							{
								id: actionId,
								key: "copy",
								label: t("transcript.action.copy"),
								payload: meta.raw ?? "",
								xStart: Math.max(padX, padX + footer.btnStartInCard - 1),
								xEnd: Math.min(width - 1, padX + footer.btnEndInCard + 1),
							},
						];
					} else if (meta.kind === "code-inline-hover") {
						const actionId = `${zoneId}:copy`;
						const pillText = t(copiedAction === actionId ? "transcript.action.copied" : "transcript.action.copy");
						const pillW = visibleWidth(pillText);
						const btnCol = Math.max(padX + 2, padX + meta.cardWidth - pillW - 2);
						buttons = [
							{
								id: actionId,
								key: "copy",
								label: t("transcript.action.copy"),
								payload: meta.raw ?? "",
								xStart: Math.max(padX, btnCol - 1),
								xEnd: Math.min(width - 1, btnCol + pillW + 1),
							},
						];
					} else {
						const built = buildInlineActionBarRow(
							activeTheme,
							palette,
							zoneId,
							meta.buttons,
							padX,
							hoveredAction,
							copiedAction,
						);
						buttons = built.hits;
					}

					zones.push({
						id: zoneId,
						kind: meta.kind,
						lang: meta.lang,
						cardWidth: meta.cardWidth,
						startRow,
						endRow,
						actionRow,
						buttons,
					});
				}
			}
			self.__conartiActionZones = zones;
			self.__conartiLinkHits = linkHits;

			const commitMarkdownCache = (outLines: string[]): string[] => {
				self.__conartiMarkdownCache = {
					baseLines,
					width,
					theme: activeTheme,
					hoveredAction,
					copiedAction,
					isFullscreen,
					blockSnapshots,
					zones,
					linkHits,
					outLines,
				} satisfies MarkdownRenderCache;
				return outLines;
			};

			const markActionRows = (lines: string[]): string[] => {
				if (isFullscreen) {
					for (const zone of zones) {
						const line = lines[zone.actionRow];
						if (line !== undefined && zone.kind !== "code-inline-hover") {
							lines[zone.actionRow] = markSelectionChrome(line);
						}
					}
				}
				return lines;
			};
			if (!hoveredAction && !copiedAction) {
				if (!isFullscreen || zones.every((z) => z.kind === "code-inline-hover")) {
					return commitMarkdownCache(baseLines);
				}
				return commitMarkdownCache(markActionRows([...baseLines]));
			}

			const out = [...baseLines];
			const leftMargin = " ".repeat(padX);
			const rightMargin = " ".repeat(padX);
			const accentFg = palette.isLight ? palette.accent : palette.accentBright;

			for (const z of zones) {
				if (z.actionRow < 0 || z.actionRow >= out.length) continue;
				const zoneActive = z.buttons.some(
					(b) => b.id === hoveredAction || b.id === copiedAction,
				);
				if (!zoneActive) continue;

				if (z.kind === "code-footer") {
					const btn = z.buttons[0]!;
					const state =
						copiedAction === btn.id ? "copied" : hoveredAction === btn.id ? "hover" : "rest";
					const footer = buildCodeFooterRow(
						activeTheme,
						palette,
						z.cardWidth,
						z.lang ?? "",
						state,
					);
					const full = leftMargin + footer.line + rightMargin;
					out[z.actionRow] = full + " ".repeat(Math.max(0, width - visibleWidth(full)));
				} else if (z.kind === "code-inline-hover") {
					const btn = z.buttons[0]!;
					const isCopied = copiedAction === btn.id;
					const pillText = t(isCopied ? "transcript.action.copied" : "transcript.action.copy");
					const styledPill = isCopied
						? themeBgRgb(
								activeTheme,
								palette.badgeCopiedBg,
								themeFgRgb(activeTheme, palette.success, pillText),
							)
						: themeBgRgb(
								activeTheme,
								palette.codeHeaderActiveBg,
								themeFgRgb(activeTheme, accentFg, pillText),
							);
					const pillW = visibleWidth(pillText);
					const targetCol = Math.max(padX + 2, padX + z.cardWidth - pillW - 2);
					const baseRow = out[z.actionRow] ?? "";
					const leftSlice = sliceByColumn(baseRow, 0, targetCol, true);
					const padBefore = " ".repeat(Math.max(0, targetCol - visibleWidth(leftSlice)));
					const trailing = paintThemeSurfaceRow(activeTheme, "  ", 2, palette.codeBodyBg);
					const patched = `${leftSlice}${padBefore}${styledPill}${trailing}${rightMargin}`;
					out[z.actionRow] = patched + " ".repeat(Math.max(0, width - visibleWidth(patched)));
				} else {
					const specs: ActionButtonSpec[] = z.buttons.map((b) => ({
						key: b.key,
						label: b.label,
						payload: b.payload,
					}));
					const built = buildInlineActionBarRow(
						activeTheme,
						palette,
						z.id,
						specs,
						padX,
						hoveredAction,
						copiedAction,
					);
					const full = leftMargin + built.row + rightMargin;
					out[z.actionRow] = full + " ".repeat(Math.max(0, width - visibleWidth(full)));
				}
			}

			return commitMarkdownCache(markActionRows(out));
		},
		["pi.grok-ui.hook.chat.markdownRender"],
	);

	hookMethod(
		proto,
		"handleMouse",
		"transcript.markdownMouse",
		(self, args) => {
			const event = args[0] as TuiMouseEvent;
			if (self.__conartiStreaming || !isEligibleAssistantMarkdown(self)) {
				return undefined;
			}

			const zones: ResolvedActionZone[] = self.__conartiActionZones ?? [];

			if (event.type === "move") {
				let nextAction: string | null = null;
				for (const z of zones) {
					if (z.kind === "code-inline-hover") {
						if (event.y >= z.startRow && event.y <= z.endRow) {
							nextAction = z.buttons[0]?.id ?? null;
							break;
						}
					} else if (event.y === z.actionRow) {
						const btn = z.buttons.find((b) => event.x >= b.xStart && event.x <= b.xEnd);
						if (btn) {
							nextAction = btn.id;
							break;
						}
					}
				}

				if (nextAction) {
					claimHover(self, () => {
						if (self.__conartiHoveredAction) {
							self.__conartiHoveredAction = null;
							requestRender();
						}
					});
				}

				if (nextAction !== (self.__conartiHoveredAction ?? null)) {
					self.__conartiHoveredAction = nextAction;
					return { handled: true, render: true };
				}
				return undefined;
			}

			let matchedButton: ActionButtonHit | undefined;
			for (const z of zones) {
				if (event.y !== z.actionRow) continue;
				const btn = z.buttons.find((b) => event.x >= b.xStart && event.x <= b.xEnd);
				if (btn) {
					if (z.kind === "code-inline-hover") {
						/* Короткий 1-2 строчный блок кликабелен только когда [Copy] показан при наведении */
						if (self.__conartiHoveredAction !== btn.id && self.__conartiCopiedAction !== btn.id) {
							continue;
						}
					}
					matchedButton = btn;
					break;
				}
			}

			if (event.type === "press" && event.button === "left") {
				if (matchedButton) {
					return { handled: true, render: false };
				}
				const linkHits: readonly ResolvedLinkHit[] = self.__conartiLinkHits ?? [];
				const matchedLink = linkHits.find(
					(lh) => event.y === lh.y && event.x >= lh.xStart && event.x < lh.xEnd,
				);
				/* Перехватываем press на ссылках и локальных путях, чтобы хост не открывал URL напрямую и не ломал повторный клик двойным выделением */
				if (matchedLink) {
					return { handled: true, render: false };
				}
				return undefined;
			}

			if (event.type === "click" && event.button === "left") {
				if (matchedButton) {
					copyToClipboard(matchedButton.payload);
					const actionId = matchedButton.id;
					self.__conartiCopiedAction = actionId;
					requestRender();
					markdownCopyTimers.arm(self, (target) => {
						if (target.__conartiCopiedAction === actionId) {
							target.__conartiCopiedAction = null;
							requestRender();
						}
					});
					return { handled: true, render: true };
				}

				const linkHits: readonly ResolvedLinkHit[] = self.__conartiLinkHits ?? [];
				const matchedLink = linkHits.find(
					(lh) => event.y === lh.y && event.x >= lh.xStart && event.x < lh.xEnd,
				);
				if (matchedLink) {
					const extEvent = event as TuiMouseEvent & { super?: boolean; meta?: boolean };
					if (event.alt || event.ctrl || extEvent.super || extEvent.meta) {
						openInspectableLinkTarget(matchedLink.target);
						return { handled: true, render: true };
					}
					toggleLinkTargetPopup(matchedLink.target, event.screenX, event.screenY);
					return { handled: true, render: true };
				}
			}

			return undefined;
		},
		["pi.grok-ui.hook.chat.markdownMouse"],
	);
}
