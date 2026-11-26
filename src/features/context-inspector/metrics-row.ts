import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	visibleWidth,
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { fgRgb, getActiveGlobalTheme, getThemeSurfacePalette, isLightTheme, themeFgRgb } from "../../shared/ansi.ts";
import { computeOuterCanvasMargin } from "../../shared/fullscreen-layout.ts";
import { getActiveHostRuntime } from "../../shared/host-runtime.ts";
import { t } from "../../shared/i18n.ts";
import { getPiUiConfigVersion, loadPiUiUserConfig } from "../../shared/pi-ui-config.ts";
import { claimHover } from "../../shared/runtime-hooks.ts";
import { markSelectionChrome } from "../../shared/selection-copy.ts";
import { requestRender } from "../../shared/ui-action-bridge.ts";
import {
	computeStepMetrics,
	formatCompletionTimestamp,
	formatMetricsDuration,
	formatMetricsRate,
	isPositiveCount,
	isValidMs,
	type ResponseMetricsData,
} from "./telemetry.ts";

const EMPTY_LINES: string[] = [];

export class ResponseMetricsRowComponent implements Component {
	private hovered = false;
	private leftHitStart = -1;
	private leftHitEnd = -1;
	private themeRef: Theme;
	private turnTtftResolved = false;
	private cachedTurnTtft: number | undefined;
	private renderCache?: {
		width: number;
		theme: Theme;
		light: boolean;
		hovered: boolean;
		isFullscreen: boolean;
		configVersion: number;
		lines: string[];
		leftHitStart: number;
		leftHitEnd: number;
	};

	constructor(
		private readonly data: ResponseMetricsData,
		themeRef: Theme,
		private readonly onOpenSessionUsage: () => void,
		private readonly getTurnTtft: () => number | undefined,
	) {
		this.themeRef = themeRef;
	}

	setTheme(theme: Theme): void {
		if (this.themeRef !== theme) {
			this.themeRef = theme;
			this.renderCache = undefined;
		}
	}

	invalidate(): void {
		this.renderCache = undefined;
	}

	private resolveCachedTurnTtft(): number | undefined {
		if (!this.turnTtftResolved) {
			this.cachedTurnTtft = this.getTurnTtft();
			this.turnTtftResolved = true;
		}
		return this.cachedTurnTtft;
	}

	render(width: number): string[] {
		const activeTheme = getActiveGlobalTheme(this.themeRef);
		const light = isLightTheme(activeTheme);
		const isFullscreen = Boolean(getActiveHostRuntime()?.isFullscreen);
		const configVersion = getPiUiConfigVersion();

		const prev = this.renderCache;
		if (
			prev &&
			prev.width === width &&
			prev.theme === activeTheme &&
			prev.light === light &&
			prev.hovered === this.hovered &&
			prev.isFullscreen === isFullscreen &&
			prev.configVersion === configVersion
		) {
			this.leftHitStart = prev.leftHitStart;
			this.leftHitEnd = prev.leftHitEnd;
			return prev.lines;
		}

		this.leftHitStart = -1;
		this.leftHitEnd = -1;

		const commitLines = (lines: string[]): string[] => {
			this.renderCache = {
				width,
				theme: activeTheme,
				light,
				hovered: this.hovered,
				isFullscreen,
				configVersion,
				lines,
				leftHitStart: this.leftHitStart,
				leftHitEnd: this.leftHitEnd,
			};
			return lines;
		};

		if (width < 12) {
			return commitLines(EMPTY_LINES);
		}

		const config = loadPiUiUserConfig();
		const isToolStep = this.data.stopReason === "toolUse";
		if (isToolStep) {
			if (!config.responseMetrics || !isPositiveCount(this.data.outputTokens)) {
				return commitLines(EMPTY_LINES);
			}
		}

		const showMetrics = config.responseMetrics;
		const formattedTime = isToolStep
			? ""
			: formatCompletionTimestamp(this.data.completedAt, config.timestamps);

		if (!showMetrics && !formattedTime) {
			return commitLines(EMPTY_LINES);
		}

		const computed = computeStepMetrics(this.data);
		if (showMetrics && !computed && !formattedTime) {
			return commitLines(EMPTY_LINES);
		}

		const outerPad = computeOuterCanvasMargin(width);
		const innerInset = outerPad > 0 ? 2 : 0;
		const leftStart = outerPad + innerInset;
		const rightPad = outerPad + innerInset;
		const palette = getThemeSurfacePalette(activeTheme);

		const timeText = formattedTime;
		const timeWidth = visibleWidth(timeText);
		const timeStyled = timeText ? themeFgRgb(activeTheme, palette.codeMetaFg, timeText) : "";

		const availableLeftWidth = Math.max(
			0,
			width - leftStart - rightPad - (timeWidth > 0 ? timeWidth + 2 : 0),
		);

		let leftStyled = "";
		let leftRenderedWidth = 0;

		if (showMetrics && computed && availableLeftWidth > 0) {
			const parts: string[] = [];
			let primaryText = "";

			if (!isToolStep) {
				const elapsedMs = isValidMs(this.data.timeSinceUserMs)
					? this.data.timeSinceUserMs
					: computed.totalMs;
				primaryText = t("metrics.workedFor", { duration: formatMetricsDuration(elapsedMs) });
				parts.push(primaryText);
			}

			const stepTtft = computed.ttftMs ?? (!isToolStep ? this.resolveCachedTurnTtft() : undefined);
			if (stepTtft !== undefined) {
				parts.push(t("metrics.ttftPart", { duration: formatMetricsDuration(stepTtft) }));
			}

			const rate = computed.streamTps ?? computed.effectiveTps;
			if (rate !== undefined) {
				parts.push(t("metrics.ratePart", { rate: formatMetricsRate(rate) }));
			}

			if (parts.length === 0 && !formattedTime) {
				return commitLines(EMPTY_LINES);
			}

			const fullLeftPlain = parts.join(" · ");
			const clippedLeft = truncateToWidth(fullLeftPlain, availableLeftWidth, "…");
			leftRenderedWidth = visibleWidth(clippedLeft);

			if (leftRenderedWidth > 0) {
				if (this.hovered) {
					const leadPlain = primaryText || parts[0] || clippedLeft;
					const leadClipped = truncateToWidth(leadPlain, availableLeftWidth, "…");
					const leadW = visibleWidth(leadClipped);
					const hoverAccent = light
						? fgRgb(37, 99, 235, leadClipped)
						: fgRgb(192, 202, 245, leadClipped);
					if (clippedLeft.length > leadClipped.length && availableLeftWidth > leadW) {
						const suffixPlain = clippedLeft.slice(leadClipped.length);
						const suffixStyled = light
							? fgRgb(100, 116, 139, suffixPlain)
							: fgRgb(126, 142, 168, suffixPlain);
						leftStyled = `${hoverAccent}${suffixStyled}`;
					} else {
						leftStyled = hoverAccent;
					}
				} else {
					leftStyled = light
						? fgRgb(120, 134, 156, clippedLeft)
						: fgRgb(104, 118, 142, clippedLeft);
				}

				this.leftHitStart = leftStart;
				this.leftHitEnd = leftStart + Math.max(0, leftRenderedWidth - 1);
			}
		}

		const gapWidth = Math.max(0, width - leftStart - leftRenderedWidth - timeWidth - rightPad);
		const row = `${" ".repeat(leftStart)}${leftStyled}${" ".repeat(gapWidth)}${timeStyled}${" ".repeat(rightPad)}`;
		const finalPad = Math.max(0, width - visibleWidth(row));
		const padded = `${row}${" ".repeat(finalPad)}`;
		return commitLines([isFullscreen ? markSelectionChrome(padded) : padded]);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (!loadPiUiUserConfig().responseMetrics) {
			return undefined;
		}
		if (this.data.stopReason === "toolUse" && !isPositiveCount(this.data.outputTokens)) {
			return undefined;
		}

		const onRow = event.y === 0;
		const inHitRange =
			onRow &&
			this.leftHitStart >= 0 &&
			event.x >= this.leftHitStart &&
			event.x <= this.leftHitEnd;

		if (event.type === "move") {
			if (inHitRange) {
				claimHover(this, () => {
					if (this.hovered) {
						this.hovered = false;
						requestRender();
					}
				});
			}
			if (inHitRange !== this.hovered) {
				this.hovered = inHitRange;
				return { handled: true, render: true };
			}
			return inHitRange ? { handled: true, render: false } : undefined;
		}

		if (event.button === "left" && inHitRange) {
			if (event.type === "press") {
				return { handled: true, render: false };
			}
			if (event.type === "click") {
				this.onOpenSessionUsage();
				return { handled: true, render: true };
			}
		}

		return undefined;
	}
}
