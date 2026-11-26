import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	visibleWidth,
	type Component,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { fgRgb, getThemeSurfacePalette, isLightTheme, themeFgRgb } from "../../shared/ansi.ts";
import { computeOuterCanvasMargin } from "../../shared/fullscreen-layout.ts";
import { getActiveHostRuntime } from "../../shared/host-runtime.ts";
import { t } from "../../shared/i18n.ts";
import { loadPiUiUserConfig } from "../../shared/pi-ui-config.ts";
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

export class ResponseMetricsRowComponent implements Component {
	private hovered = false;
	private leftHitStart = -1;
	private leftHitEnd = -1;

	constructor(
		private readonly data: ResponseMetricsData,
		private readonly themeRef: Theme,
		private readonly onOpenSessionUsage: () => void,
		private readonly getTurnTtft: () => number | undefined,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		this.leftHitStart = -1;
		this.leftHitEnd = -1;

		if (width < 12) {
			return [];
		}

		const config = loadPiUiUserConfig();
		const isToolStep = this.data.stopReason === "toolUse";
		if (isToolStep) {
			if (!config.responseMetrics || !isPositiveCount(this.data.outputTokens)) {
				return [];
			}
		}

		const showMetrics = config.responseMetrics;
		const formattedTime = isToolStep
			? ""
			: formatCompletionTimestamp(this.data.completedAt, config.timestamps);

		if (!showMetrics && !formattedTime) {
			return [];
		}

		const computed = computeStepMetrics(this.data);
		if (showMetrics && !computed && !formattedTime) {
			return [];
		}

		const outerPad = computeOuterCanvasMargin(width);
		const leftStart = outerPad + 2;
		const rightPad = outerPad;
		const light = isLightTheme(this.themeRef);
		const palette = getThemeSurfacePalette(this.themeRef);

		const timeText = formattedTime;
		const timeWidth = visibleWidth(timeText);
		const timeStyled = timeText ? themeFgRgb(this.themeRef, palette.codeMetaFg, timeText) : "";

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

			const stepTtft = computed.ttftMs ?? (!isToolStep ? this.getTurnTtft() : undefined);
			if (stepTtft !== undefined) {
				parts.push(t("metrics.ttftPart", { duration: formatMetricsDuration(stepTtft) }));
			}

			const rate = computed.streamTps ?? computed.effectiveTps;
			if (rate !== undefined) {
				parts.push(t("metrics.ratePart", { rate: formatMetricsRate(rate) }));
			}

			if (parts.length === 0 && !formattedTime) {
				return [];
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
		return [getActiveHostRuntime()?.isFullscreen ? markSelectionChrome(padded) : padded];
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
