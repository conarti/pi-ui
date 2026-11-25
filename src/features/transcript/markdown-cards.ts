import {
	Markdown,
	sliceByColumn,
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
import {
	claimHover,
	copyToClipboard,
	createCopyFeedbackTimerRegistry,
	hookMethod,
} from "../../shared/runtime-hooks.ts";
import { requestRender } from "../../shared/ui-action-bridge.ts";
import { isPrototypeActive } from "./prototype-state.ts";

interface CodeZone {
	id: string;
	lang: string;
	raw: string;
	headerRow: number;
	btnStart: number;
	btnEnd: number;
}

const markdownCopyTimers = createCopyFeedbackTimerRegistry<{
	__conartiCopiedZone?: string | null;
	__conartiCopyTimer?: unknown;
}>("conarti.pi-ui.markdown-copy-timers.v1", (target) => {
	target.__conartiCopiedZone = null;
});

export function clearMarkdownCopyTimers(): void {
	markdownCopyTimers.clearAll();
}

export function installMarkdownCardsAndHeadings(): void {
	const proto = Markdown.prototype as any;

	hookMethod(
		proto,
		"renderToken",
		"transcript.renderToken",
		(self, args, original) => {
			const [token, width, nextTokenType] = args as [any, number, string | undefined, any];

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

				const langLabel = lang || "code";
				const leftHdr = `  ${themeFgRgb(activeTheme, palette.codeMetaFg, langLabel)}`;
				const copyLabel = themeFgRgb(activeTheme, palette.codeActionMutedFg, "Copy  ");
				const gapHdr = " ".repeat(
					Math.max(1, cardW - visibleWidth(leftHdr) - visibleWidth(copyLabel)),
				);
				const headerLine = paintThemeSurfaceRow(
					activeTheme,
					`${leftHdr}${gapHdr}${copyLabel}`,
					cardW,
					palette.codeHeaderBg,
				);

				const out: string[] = [headerLine];

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

				const rail = themeFgRgb(activeTheme, palette.codeRailFg, "▎");
				for (const hlLine of highlighted) {
					const expandedTabs = hlLine.replace(/\t/g, "  ");
					const wrapped = wrapTextWithAnsi(expandedTabs, codeInnerW);
					for (const wLine of wrapped.length > 0 ? wrapped : [""]) {
						out.push(
							paintThemeSurfaceRow(
								activeTheme,
								`${rail} ${wLine}`,
								cardW,
								palette.codeBodyBg,
							),
						);
					}
				}

				if (nextTokenType && nextTokenType !== "space") out.push("");
				return out;
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
			const [block, token] = args as [any, any];
			const res = original.apply(self, args);
			if (
				!self.__conartiThinkingMarkdown &&
				!self.__conartiSkipReplyCopy &&
				token?.type === "code" &&
				!self.defaultTextStyle?.bgColor
			) {
				block.__conartiCode = {
					lang: String(token.lang || "").trim() || "code",
					raw: String(token.text ?? ""),
				};
			} else {
				block.__conartiCode = undefined;
			}
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
				self.__conartiSkipReplyCopy ||
				self.__conartiThinkingMarkdown ||
				self.defaultTextStyle?.bgColor ||
				baseLines.length === 0 ||
				width < 20
			) {
				self.__conartiCodeZones = [];
				return baseLines;
			}

			const tokenBundle = self.cachedTokens?.deref?.();
			const blockMap: Map<string, any> | undefined = self.blocks?.deref?.();
			if (tokenBundle?.tokens && blockMap) {
				const zones: CodeZone[] = [];
				let rowCursor: number = self.paddingY ?? 0;
				const padX: number = self.paddingX ?? 0;
				const contentWidth = Math.max(1, width - padX * 2);

				for (let i = 0; i < tokenBundle.tokens.length; i++) {
					const tok = tokenBundle.tokens[i];
					const blk = blockMap.get(tok.raw);
					if (!blk?.lines) continue;
					if (blk.__conartiCode) {
						const btnEnd = padX + contentWidth;
						const btnStart = Math.max(padX, btnEnd - 11);
						zones.push({
							id: `code-${i}`,
							lang: blk.__conartiCode.lang,
							raw: blk.__conartiCode.raw,
							headerRow: rowCursor,
							btnStart,
							btnEnd,
						});
					}
					rowCursor += blk.lines.length;
				}
				self.__conartiCodeZones = zones;
			}

			const hoveredZone: string | null = self.__conartiHoveredZone ?? null;
			const copiedZone: string | null = self.__conartiCopiedZone ?? null;
			if (!hoveredZone && !copiedZone) return baseLines;

			const zones: CodeZone[] = self.__conartiCodeZones ?? [];
			const out = [...baseLines];
			const padX: number = self.paddingX ?? 0;
			const contentWidth = Math.max(1, width - padX * 2);
			const leftMargin = " ".repeat(padX);
			const rightMargin = " ".repeat(padX);
			const activeTheme = getActiveGlobalTheme(self?.theme);
			const palette = getThemeSurfacePalette(activeTheme);
			const copyAccentFg = palette.isLight ? palette.accent : palette.accentBright;

			for (const z of zones) {
				const isCopied = copiedZone === z.id;
				const isHovered = hoveredZone === z.id;
				if (!isCopied && !isHovered) continue;
				if (z.headerRow < 0 || z.headerRow >= out.length) continue;

				const leftHdr = `  ${themeFgRgb(activeTheme, palette.codeMetaActiveFg, z.lang)}`;
				const badge = isCopied
					? themeFgRgb(activeTheme, palette.success, "✓ Copied  ")
					: themeFgRgb(activeTheme, copyAccentFg, "Copy  ");
				const gap = " ".repeat(
					Math.max(1, contentWidth - visibleWidth(leftHdr) - visibleWidth(badge)),
				);
				const hdrCard = paintThemeSurfaceRow(
					activeTheme,
					`${leftHdr}${gap}${badge}`,
					contentWidth,
					palette.codeHeaderActiveBg,
				);
				const full = leftMargin + hdrCard + rightMargin;
				out[z.headerRow] = full + " ".repeat(Math.max(0, width - visibleWidth(full)));
			}

			if (
				!isPrototypeActive() &&
				(hoveredZone === "reply" || copiedZone === "reply") &&
				!zones.some((z) => z.headerRow === 0)
			) {
				const row0 = out[0] ?? "";
				const badge =
					copiedZone === "reply"
						? themeBgRgb(
								activeTheme,
								palette.badgeCopiedBg,
								themeFgRgb(activeTheme, palette.success, " ✓ Copied "),
							)
						: themeBgRgb(
								activeTheme,
								palette.badgeHoverBg,
								themeFgRgb(activeTheme, copyAccentFg, " Copy "),
							);
				const badgeW = visibleWidth(badge);
				if (width > badgeW + 12) {
					const targetCol = width - badgeW - padX;
					const leftSlice = sliceByColumn(row0, 0, targetCol, true);
					const gap = " ".repeat(Math.max(0, targetCol - visibleWidth(leftSlice)));
					out[0] = `${leftSlice}${gap}${badge}${" ".repeat(padX)}`;
					self.__conartiReplyBtn = { xStart: targetCol, xEnd: targetCol + badgeW };
				}
			}

			return out;
		},
		["pi.grok-ui.hook.chat.markdownRender"],
	);

	hookMethod(
		proto,
		"handleMouse",
		"transcript.markdownMouse",
		(self, args) => {
			const event = args[0] as TuiMouseEvent;
			if (
				self.__conartiSkipReplyCopy ||
				self.__conartiThinkingMarkdown ||
				self.defaultTextStyle?.bgColor
			) {
				return undefined;
			}

			const zones: CodeZone[] = self.__conartiCodeZones ?? [];

			if (event.type === "move") {
				let nextZone: string | null = null;
				for (const z of zones) {
					const nextCodeStart =
						zones.find((other) => other.headerRow > z.headerRow)?.headerRow ?? Infinity;
					if (event.y >= z.headerRow && event.y < nextCodeStart) {
						const rawLinesCount = z.raw.split("\n").length + 2;
						if (event.y <= z.headerRow + rawLinesCount + 4) {
							nextZone = z.id;
							break;
						}
					}
				}
				if (
					!isPrototypeActive() &&
					!nextZone &&
					event.y === 0 &&
					String(self.text ?? "").trim().length > 0
				) {
					nextZone = "reply";
				}

				if (nextZone) {
					claimHover(self, () => {
						if (self.__conartiHoveredZone) {
							self.__conartiHoveredZone = null;
							requestRender();
						}
					});
				}

				if (nextZone !== (self.__conartiHoveredZone ?? null)) {
					self.__conartiHoveredZone = nextZone;
					return { handled: true, render: true };
				}
				return undefined;
			}

			const hitCode = zones.find(
				(z) => event.y === z.headerRow && event.x >= z.btnStart && event.x <= z.btnEnd,
			);
			const replyBtn = self.__conartiReplyBtn as { xStart: number; xEnd: number } | undefined;
			const hitReply = Boolean(
				event.y === 0 && replyBtn && event.x >= replyBtn.xStart && event.x <= replyBtn.xEnd,
			);

			if (event.type === "press" && event.button === "left" && (hitCode || hitReply)) {
				return { handled: true, render: false };
			}

			const armCopiedReset = (zoneId: string) => {
				self.__conartiCopiedZone = zoneId;
				requestRender();
				markdownCopyTimers.arm(self, (target) => {
					if (target.__conartiCopiedZone === zoneId) {
						target.__conartiCopiedZone = null;
						requestRender();
					}
				});
			};

			if (event.type === "click" && event.button === "left") {
				if (hitCode) {
					copyToClipboard(hitCode.raw);
					armCopiedReset(hitCode.id);
					return { handled: true, render: true };
				}

				if (hitReply) {
					copyToClipboard(String(self.text ?? "").trim());
					armCopiedReset("reply");
					return { handled: true, render: true };
				}
			}

			return undefined;
		},
		["pi.grok-ui.hook.chat.markdownMouse"],
	);
}
