import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHostPiPeers } from "./resolve-host-pi.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { packages } = resolveHostPiPeers();

const cacheDir = join(rootDir, "node_modules", ".cache", "conarti-pi-ui");
mkdirSync(cacheDir, { recursive: true });

const generatedConfigPath = join(cacheDir, "tsconfig.host.json");

const hostConfig = {
	extends: join(rootDir, "tsconfig.json"),
	compilerOptions: {
		paths: {
			"@earendil-works/pi-coding-agent": [
				join(packages["@earendil-works/pi-coding-agent"], "dist/index.d.ts"),
			],
			"@earendil-works/pi-coding-agent/*": [
				join(packages["@earendil-works/pi-coding-agent"], "dist/*"),
			],
			"@earendil-works/pi-tui": [
				join(packages["@earendil-works/pi-tui"], "dist/index.d.ts"),
			],
			"@earendil-works/pi-tui/*": [
				join(packages["@earendil-works/pi-tui"], "dist/*"),
			],
			"@earendil-works/pi-ai": [
				join(packages["@earendil-works/pi-ai"], "dist/index.d.ts"),
			],
			"@earendil-works/pi-ai/*": [
				join(packages["@earendil-works/pi-ai"], "dist/*"),
			],
			"@earendil-works/pi-agent-core": [
				join(packages["@earendil-works/pi-agent-core"], "dist/index.d.ts"),
			],
			"@earendil-works/pi-agent-core/*": [
				join(packages["@earendil-works/pi-agent-core"], "dist/*"),
			],
			typebox: [join(packages.typebox, "build/index.d.mts")],
			"typebox/*": [join(packages.typebox, "build/*/index.d.mts")],
		},
	},
	include: [
		join(rootDir, "src/**/*.ts"),
		join(rootDir, "tests/**/*.ts"),
		join(rootDir, "vitest.config.ts"),
	],
};

writeFileSync(generatedConfigPath, `${JSON.stringify(hostConfig, null, 2)}\n`, "utf8");

const tscBin = join(
	rootDir,
	"node_modules",
	".bin",
	process.platform === "win32" ? "tsc.cmd" : "tsc",
);

const result = spawnSync(tscBin, ["-p", generatedConfigPath, "--noEmit"], {
	cwd: rootDir,
	stdio: "inherit",
});

process.exit(result.status ?? 1);
