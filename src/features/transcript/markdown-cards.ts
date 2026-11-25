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
import { getPrototypeVariant, isPrototypeActive } from "./prototype-state.ts";

type CodeActionLayout = "legacy-header" | "footer" | "smart-header" | "inline-hover" | "corner";

interface CachedBlockCodeMeta {
	readonly lang: string;
	readonly raw: string;
	readonly layout: CodeActionLayout;
	readonly actionOffset: number;
	readonly totalRows: number;
	readonly rightGuard: number;
	readonly cardWidth: number;
}

interface CodeZone {
	readonly id: string;
	readonly lang: string;
	readonly raw: string;
	readonly layout: CodeActionLayout;
	readonly startRow: number;
	readonly endRow: number;
	readonly actionRow: number;
	readonly btnStart: number;
	readonly btnEnd: number;
	readonly cardWidth: number;
	readonly rightGuard: number;
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

function renderCodeBodyLines(
	self: any,
	rawCode: string,
	lang: string,
	codeInnerW: number,
): string[] {
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

	const wrappedOut: string[] = [];
	for (const hlLine of highlighted) {
		const expandedTabs = hlLine.replace(/\t/g, "  ");
		const wrapped = wrapTextWithAnsi(expandedTabs, codeInnerW);
		for (const wLine of wrapped.length > 0 ? wrapped : [""]) {
			wrappedOut.push(wLine);
		}
	}
	return wrappedOut.length > 0 ? wrappedOut : [""];
}

function buildFooterActionRow(
	activeTheme: any,
	palette: ReturnType<typeof getThemeSurfacePalette>,
	cardW: number,
	lang: string,
	state: "rest" | "hover" | "copied",
): { line: string; btnWidth: number } {
	const copyText = state === "copied" ? "✓ Copied" : "Copy";
	const styledBtn =
		state === "copied"
			? themeFgRgb(activeTheme, palette.success, copyText)
			: state === "hover"
				? themeBgRgb(
						activeTheme,
						palette.codeHeaderActiveBg,
						themeFgRgb(
							activeTheme,
							palette.isLight ? palette.accent : palette.accentBright,
							` ${copyText} `,
						),
					)
				: themeFgRgb(activeTheme, palette.codeActionMutedFg, `[${copyText}]`);
	const langPart = lang
		? `${themeFgRgb(activeTheme, palette.codeMetaFg, lang)}${themeFgRgb(activeTheme, palette.borderSubtle, " · ")}`
		: "";
	const rightCluster = `${langPart}${styledBtn} `;
	const padLeft = " ".repeat(Math.max(0, cardW - visibleWidth(rightCluster)));
	return {
		line: paintThemeSurfaceRow(
			activeTheme,
			`${padLeft}${rightCluster}`,
			cardW,
			palette.codeFooterBg,
		),
		btnWidth: visibleWidth(styledBtn) + 2,
	};
}

function buildSmartHeaderRow(
	activeTheme: any,
	palette: ReturnType<typeof getThemeSurfacePalette>,
	cardW: number,
	lang: string,
	state: "rest" | "hover" | "copied",
): { line: string; btnWidth: number } {
	const leftLabel = lang || "snippet";
	const leftHdr = `  ${themeFgRgb(activeTheme, palette.codeMetaFg, leftLabel)}`;
	const copyText = state === "copied" ? "✓ Copied" : "Copy";
	const badge =
		state === "copied"
			? themeFgRgb(activeTheme, palette.success, `${copyText}  `)
			: state === "hover"
				? `${themeBgRgb(
						activeTheme,
						palette.codeHeaderActiveBg,
						themeFgRgb(
							activeTheme,
							palette.isLight ? palette.accent : palette.accentBright,
							` ${copyText} `,
						),
					)} `
				: themeFgRgb(activeTheme, palette.codeActionMutedFg, `${copyText}  `);
	const gap = " ".repeat(Math.max(1, cardW - visibleWidth(leftHdr) - visibleWidth(badge)));
	return {
		line: paintThemeSurfaceRow(
			activeTheme,
			`${leftHdr}${gap}${badge}`,
			cardW,
			palette.codeHeaderBg,
		),
		btnWidth: visibleWidth(badge) + 2,
	};
}

function buildCornerPillBadge(
	activeTheme: any,
	palette: ReturnType<typeof getThemeSurfacePalette>,
	lang: string,
	state: "rest" | "hover" | "copied",
): { pill: string; copyHitWidth: number } {
	const copyText = state === "copied" ? "✓ Copied" : "Copy";
	const bg = state === "hover" ? palette.codeHeaderActiveBg : palette.codeHeaderBg;
	const copyStyled =
		state === "copied"
			? themeFgRgb(activeTheme, palette.success, copyText)
			: state === "hover"
				? themeFgRgb(
						activeTheme,
						palette.isLight ? palette.accent : palette.accentBright,
						copyText,
					)
				: themeFgRgb(activeTheme, palette.codeMetaActiveFg, copyText);
	const inner = lang
		? ` ${themeFgRgb(activeTheme, palette.codeMetaFg, lang)}${themeFgRgb(activeTheme, palette.borderSubtle, " · ")}${copyStyled} `
		: ` ${copyStyled} `;
	return {
		pill: themeBgRgb(activeTheme, bg, inner),
		copyHitWidth: visibleWidth(copyText) + 3,
	};
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
				const variant = getPrototypeVariant();
				const lang = String(token.lang || "").trim();
				const rawCode = String(token.text ?? "");
				const activeTheme = getActiveGlobalTheme(self?.theme);
				const palette = getThemeSurfacePalette(activeTheme);

				/* Legacy baseline rendering when prototype is off */
				if (variant === "off") {
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
					const bodyLines = renderCodeBodyLines(self, rawCode, lang, codeInnerW);
					const rail = themeFgRgb(activeTheme, palette.codeRailFg, "▎");
					for (const wLine of bodyLines) {
						out.push(
							paintThemeSurfaceRow(
								activeTheme,
								`${rail} ${wLine}`,
								cardW,
								palette.codeBodyBg,
							),
						);
					}
					self.__conartiLastCodeMeta = {
						lang: langLabel,
						raw: rawCode,
						layout: "legacy-header",
						actionOffset: 0,
						totalRows: out.length,
						rightGuard: 0,
						cardWidth: cardW,
					} satisfies CachedBlockCodeMeta;
					if (nextTokenType && nextTokenType !== "space") out.push("");
					return out;
				}

				/* Unified prototype two-tone code block:
				   recessed codeBodyBg with clean 2-space indent (zero ▎ rail polluting selection)
				   + calm bottom footer affordance (`lang · [Copy]` or `[Copy]`). */
				const padX = Number(self.paddingX ?? 0);
				const rightGuard = width >= 56 ? Math.max(0, 4 - padX) : 0;
				const cardW = Math.max(12, width - rightGuard);
				const codeInnerW = Math.max(6, cardW - 4);
				const bodyLines = renderCodeBodyLines(self, rawCode, lang, codeInnerW);
				const out: string[] = [];

				for (const wLine of bodyLines) {
					out.push(
						paintThemeSurfaceRow(
							activeTheme,
							`  ${wLine}`,
							cardW,
							palette.codeBodyBg,
						),
					);
				}
				const footer = buildFooterActionRow(activeTheme, palette, cardW, lang, "rest");
				const actionOffset = out.length;
				out.push(footer.line);
				self.__conartiLastCodeMeta = {
					lang,
					raw: rawCode,
					layout: "footer",
					actionOffset,
					totalRows: out.length,
					rightGuard,
					cardWidth: cardW,
				} satisfies CachedBlockCodeMeta;

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
			self.__conartiLastCodeMeta = undefined;
			const res = original.apply(self, args);
			if (
				!self.__conartiThinkingMarkdown &&
				!self.__conartiSkipReplyCopy &&
				token?.type === "code" &&
				!self.defaultTextStyle?.bgColor &&
				self.__conartiLastCodeMeta
			) {
				block.__conartiCode = self.__conartiLastCodeMeta;
			} else {
				block.__conartiCode = undefined;
			}
			self.__conartiLastCodeMeta = undefined;
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

			const activeTheme = getActiveGlobalTheme(self?.theme);
			const palette = getThemeSurfacePalette(activeTheme);
			const padX: number = self.paddingX ?? 0;

			const tokenBundle = self.cachedTokens?.deref?.();
			const blockMap: Map<string, any> | undefined = self.blocks?.deref?.();
			if (tokenBundle?.tokens && blockMap) {
				const zones: CodeZone[] = [];
				let rowCursor: number = self.paddingY ?? 0;

				for (let i = 0; i < tokenBundle.tokens.length; i++) {
					const tok = tokenBundle.tokens[i];
					const blk = blockMap.get(tok.raw);
					if (!blk?.lines) continue;
					const meta = blk.__conartiCode as CachedBlockCodeMeta | undefined;
					if (meta) {
						const actionRow = rowCursor + meta.actionOffset;
						const btnEnd = padX + meta.cardWidth;
						const btnWidth =
							meta.layout === "corner"
								? buildCornerPillBadge(activeTheme, palette, meta.lang, "rest").copyHitWidth
								: 11;
						const btnStart = Math.max(padX, btnEnd - btnWidth);
						zones.push({
							id: `code-${i}`,
							lang: meta.lang,
							raw: meta.raw,
							layout: meta.layout,
							startRow: rowCursor,
							endRow: rowCursor + Math.max(0, meta.totalRows - 1),
							actionRow,
							btnStart,
							btnEnd,
							cardWidth: meta.cardWidth,
							rightGuard: meta.rightGuard,
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
			const leftMargin = " ".repeat(padX);
			const copyAccentFg = palette.isLight ? palette.accent : palette.accentBright;

			for (const z of zones) {
				const isCopied = copiedZone === z.id;
				const isHovered = hoveredZone === z.id;
				if (!isCopied && !isHovered) continue;
				if (z.actionRow < 0 || z.actionRow >= out.length) continue;
				const state: "hover" | "copied" = isCopied ? "copied" : "hover";

				if (z.layout === "legacy-header") {
					const leftHdr = `  ${themeFgRgb(activeTheme, palette.codeMetaActiveFg, z.lang || "code")}`;
					const badge = isCopied
						? themeFgRgb(activeTheme, palette.success, "✓ Copied  ")
						: themeFgRgb(activeTheme, copyAccentFg, "Copy  ");
					const gap = " ".repeat(
						Math.max(1, z.cardWidth - visibleWidth(leftHdr) - visibleWidth(badge)),
					);
					const hdrCard = paintThemeSurfaceRow(
						activeTheme,
						`${leftHdr}${gap}${badge}`,
						z.cardWidth,
						palette.codeHeaderActiveBg,
					);
					const full = leftMargin + hdrCard;
					out[z.actionRow] = full + " ".repeat(Math.max(0, width - visibleWidth(full)));
				} else if (z.layout === "footer") {
					const footer = buildFooterActionRow(activeTheme, palette, z.cardWidth, z.lang, state);
					const full = leftMargin + footer.line;
					out[z.actionRow] = full + " ".repeat(Math.max(0, width - visibleWidth(full)));
				} else if (z.layout === "smart-header") {
					const hdr = buildSmartHeaderRow(activeTheme, palette, z.cardWidth, z.lang, state);
					const full = leftMargin + hdr.line;
					out[z.actionRow] = full + " ".repeat(Math.max(0, width - visibleWidth(full)));
				} else if (z.layout === "inline-hover") {
					const copyText = isCopied ? " ✓ Copied " : " Copy ";
					const pill = isCopied
						? themeBgRgb(
								activeTheme,
								palette.badgeCopiedBg,
								themeFgRgb(activeTheme, palette.success, copyText),
							)
						: themeBgRgb(
								activeTheme,
								palette.codeHeaderActiveBg,
								themeFgRgb(activeTheme, copyAccentFg, copyText),
							);
					const pillW = visibleWidth(pill);
					const targetCol = Math.max(padX + 4, padX + z.cardWidth - pillW - 1);
					const baseRow = out[z.actionRow] ?? "";
					const leftSlice = sliceByColumn(baseRow, 0, targetCol, true);
					const trailing = paintThemeSurfaceRow(activeTheme, " ", 1, palette.codeBodyBg);
					const patched = `${leftSlice}${pill}${trailing}`;
					out[z.actionRow] = patched + " ".repeat(Math.max(0, width - visibleWidth(patched)));
				} else if (z.layout === "corner") {
					const corner = buildCornerPillBadge(activeTheme, palette, z.lang, state);
					const pillW = visibleWidth(corner.pill);
					const targetCol = Math.max(padX, padX + z.cardWidth - pillW);
					const baseRow = out[z.actionRow] ?? "";
					const leftSlice = sliceByColumn(baseRow, 0, targetCol, true);
					const patched = `${leftSlice}${corner.pill}`;
					out[z.actionRow] = patched + " ".repeat(Math.max(0, width - visibleWidth(patched)));
				}
			}

			if (
				!isPrototypeActive() &&
				(hoveredZone === "reply" || copiedZone === "reply") &&
				!zones.some((z) => z.actionRow === 0)
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
			const protoActive = isPrototypeActive();

			if (event.type === "move") {
				let nextZone: string | null = null;
				for (const z of zones) {
					if (protoActive && z.layout !== "inline-hover") {
						/* Highlight only when hovering the action row/button so prose/code scanning stays calm */
						if (event.y === z.actionRow && event.x >= z.btnStart - 2 && event.x <= z.btnEnd) {
							nextZone = z.id;
							break;
						}
					} else if (event.y >= z.startRow && event.y <= z.endRow) {
						nextZone = z.id;
						break;
					}
				}
				if (
					!protoActive &&
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
				(z) => event.y === z.actionRow && event.x >= z.btnStart && event.x <= z.btnEnd,
			);
			const replyBtn = self.__conartiReplyBtn as { xStart: number; xEnd: number } | undefined;
			const hitReply = Boolean(
				!protoActive &&
					event.y === 0 &&
					replyBtn &&
					event.x >= replyBtn.xStart &&
					event.x <= replyBtn.xEnd,
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
