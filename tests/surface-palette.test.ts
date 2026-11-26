import { DefaultResourceLoader, type Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	clampHueOutsideForbiddenBands,
	computePopupSurfaceBg,
	getThemeSurfacePalette,
	parseAnsiColorRgb,
	rgbHueDegrees,
	type RgbTuple,
} from "../src/shared/ansi.ts";
import { DEFAULT_THEMES_DIR, loadPackageThemes, REPO_ROOT } from "./harness/index.ts";

function luminance([r, g, b]: RgbTuple): number {
	return 0.299 * r + 0.587 * g + 0.114 * b;
}

function isForbiddenHue(rgb: RgbTuple): boolean {
	const info = rgbHueDegrees(rgb);
	if (info.saturation <= 0.05) return false;
	return (
		(info.hue >= 255 && info.hue <= 320) ||
		(info.hue >= 165 && info.hue <= 198)
	);
}

async function loadAllPackageThemes(): Promise<Theme[]> {
	const loader = new DefaultResourceLoader({
		cwd: REPO_ROOT,
		agentDir: REPO_ROOT,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
		noThemes: true,
		additionalThemePaths: [DEFAULT_THEMES_DIR],
	});
	await loader.reload();
	return loader.getThemes().themes;
}

describe("Elevated popupSurfaceBg and hue clamping (pure seam over real themes)", () => {
	it("clamps purple (255-320 deg) and turquoise (165-198 deg) hues into clean blue tones while leaving valid hues untouched", () => {
		const purple: RgbTuple = [160, 80, 230];
		expect(rgbHueDegrees(purple).hue).toBeGreaterThanOrEqual(255);
		expect(rgbHueDegrees(purple).hue).toBeLessThanOrEqual(320);
		expect(isForbiddenHue(clampHueOutsideForbiddenBands(purple))).toBe(false);

		const turquoise: RgbTuple = [86, 182, 194];
		expect(rgbHueDegrees(turquoise).hue).toBeGreaterThanOrEqual(165);
		expect(rgbHueDegrees(turquoise).hue).toBeLessThanOrEqual(198);
		expect(isForbiddenHue(clampHueOutsideForbiddenBands(turquoise))).toBe(false);

		const cobalt: RgbTuple = [97, 175, 239];
		expect(clampHueOutsideForbiddenBands(cobalt)).toEqual(cobalt);
	});

	it("computes elevated popupSurfaceBg from card/selectedBg tokens rather than recessed toolPendingBg across all package themes", async () => {
		const themes = await loadAllPackageThemes();
		expect(themes.length).toBeGreaterThanOrEqual(4);

		for (const theme of themes) {
			const palette = getThemeSurfacePalette(theme);
			const pendingBg = parseAnsiColorRgb(theme.getBgAnsi("toolPendingBg"));
			const cardBg = parseAnsiColorRgb(theme.getBgAnsi("userMessageBg"));
			const selectedBg = parseAnsiColorRgb(theme.getBgAnsi("selectedBg"));

			expect(palette.popupSurfaceBg).toEqual(computePopupSurfaceBg(theme));
			expect(isForbiddenHue(palette.popupSurfaceBg), `${theme.name} popupSurfaceBg hue`).toBe(false);
			expect(isForbiddenHue(palette.info), `${theme.name} info hue`).toBe(false);
			expect(isForbiddenHue(palette.accent), `${theme.name} accent hue`).toBe(false);
			expect(isForbiddenHue(palette.border), `${theme.name} border hue`).toBe(false);

			if (pendingBg) {
				expect(palette.popupSurfaceBg).not.toEqual(pendingBg);
				expect(luminance(palette.popupSurfaceBg)).toBeGreaterThan(luminance(pendingBg));
			}
			expect(palette.popupSurfaceBg).not.toEqual(palette.codeBodyBg);

			if (!palette.isLight && cardBg && selectedBg) {
				expect(luminance(palette.popupSurfaceBg)).toBeGreaterThanOrEqual(luminance(cardBg));
				expect(luminance(palette.popupSurfaceBg)).toBeLessThanOrEqual(luminance(selectedBg) + 1);
			}
		}
	});

	it("works cleanly for both 256color and truecolor theme modes without forbidden hues", async () => {
		const themes256 = await loadPackageThemes({ trueColor: false });
		for (const theme of [themes256.dark, themes256.light]) {
			const palette = getThemeSurfacePalette(theme);
			expect(isForbiddenHue(palette.popupSurfaceBg)).toBe(false);
		}
	});
});
