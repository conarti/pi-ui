import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EXPECTED_PI_HOST_VERSION = "1.6.1";

export const HOST_PEER_PACKAGES = [
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-tui",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-agent-core",
	"typebox",
];

function readPkgName(dir) {
	const pkgPath = join(dir, "package.json");
	if (!existsSync(pkgPath)) return undefined;
	try {
		return JSON.parse(readFileSync(pkgPath, "utf8")).name;
	} catch {
		return undefined;
	}
}

function walkUpToPackage(startDir, targetName) {
	let cur = resolve(startDir);
	while (true) {
		if (readPkgName(cur) === targetName) return cur;
		const parent = dirname(cur);
		if (parent === cur) return undefined;
		cur = parent;
	}
}

function findInstalledPackage(startDir, pkgName) {
	if (readPkgName(startDir) === pkgName) return startDir;
	let cur = resolve(startDir);
	while (true) {
		const candidate = join(cur, "node_modules", ...pkgName.split("/"));
		if (readPkgName(candidate) === pkgName) return candidate;
		const parent = dirname(cur);
		if (parent === cur) return undefined;
		cur = parent;
	}
}

export function findHostPiCodingAgentDir() {
	const envDir = process.env.PI_HOST_PKG_DIR?.trim();
	if (envDir) {
		const resolved = realpathSync(envDir);
		const found = walkUpToPackage(resolved, "@earendil-works/pi-coding-agent");
		if (found) return found;
		throw new Error(
			`PI_HOST_PKG_DIR (${envDir}) does not point to @earendil-works/pi-coding-agent`,
		);
	}

	const whichCmd = process.platform === "win32" ? "where" : "which";
	let binPath;
	try {
		binPath = execFileSync(whichCmd, ["pi"], { encoding: "utf8" })
			.split(/\r?\n/)
			.map((s) => s.trim())
			.find(Boolean);
	} catch {
		throw new Error(
			"Could not find 'pi' on PATH. Install Pi or set PI_HOST_PKG_DIR to the @earendil-works/pi-coding-agent directory.",
		);
	}

	if (!binPath) {
		throw new Error(
			"Could not resolve 'pi' binary path. Install Pi or set PI_HOST_PKG_DIR.",
		);
	}

	const realBin = realpathSync(binPath);
	const found = walkUpToPackage(dirname(realBin), "@earendil-works/pi-coding-agent");
	if (!found) {
		throw new Error(
			`Resolved 'pi' binary at ${realBin}, but could not locate @earendil-works/pi-coding-agent package root.`,
		);
	}
	return found;
}

export function resolveHostPiPeers() {
	const codingAgentDir = findHostPiCodingAgentDir();
	/** @type {Record<string, string>} */
	const packages = {};
	for (const pkgName of HOST_PEER_PACKAGES) {
		const dir = findInstalledPackage(codingAgentDir, pkgName);
		if (!dir) {
			throw new Error(
				`Could not locate host peer package '${pkgName}' from ${codingAgentDir}.`,
			);
		}
		packages[pkgName] = dir;
	}
	return { codingAgentDir, packages };
}

export function readHostPiVersion(codingAgentDir = findHostPiCodingAgentDir()) {
	const pkg = JSON.parse(readFileSync(join(codingAgentDir, "package.json"), "utf8"));
	return String(pkg.version ?? "");
}

export function compareSemver(a, b) {
	const parse = (v) =>
		String(v)
			.replace(/^v/, "")
			.split("-")[0]
			.split(".")
			.map((n) => Number.parseInt(n, 10) || 0);
	const pa = parse(a);
	const pb = parse(b);
	for (let i = 0; i < 3; i += 1) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

function pickExportTarget(target) {
	if (typeof target === "string") return target;
	if (target && typeof target === "object") {
		return pickExportTarget(target.import ?? target.default ?? target.node);
	}
	return undefined;
}

export function buildHostPeerAliases() {
	const { packages } = resolveHostPiPeers();
	/** @type {Array<{ find: string | RegExp; replacement: string }>} */
	const aliases = [];

	for (const [pkgName, pkgDir] of Object.entries(packages)) {
		const pkgJson = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
		const exportsField = pkgJson.exports;
		if (exportsField && typeof exportsField === "object") {
			for (const [subpath, target] of Object.entries(exportsField)) {
				if (subpath === ".") continue;
				const rel = pickExportTarget(target);
				if (!rel) continue;
				if (subpath.includes("*")) {
					const prefix = `${pkgName}/${subpath.replace(/^\.\//, "").replace(/\*.*$/, "")}`;
					const suffix = subpath.slice(subpath.indexOf("*") + 1);
					const relPrefix = rel.replace(/^\.\//, "").replace(/\*.*$/, "");
					const relSuffix = rel.slice(rel.indexOf("*") + 1);
					const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
					const escapedSuffix = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
					aliases.push({
						find: new RegExp(`^${escapedPrefix}(.+)${escapedSuffix}$`),
						replacement: `${join(pkgDir, relPrefix)}$1${relSuffix}`,
					});
				} else {
					aliases.push({
						find: `${pkgName}/${subpath.replace(/^\.\//, "")}`,
						replacement: join(pkgDir, rel),
					});
				}
			}
		}

		const rootTarget =
			(exportsField && typeof exportsField === "object"
				? pickExportTarget(exportsField["."])
				: undefined) ??
			pkgJson.module ??
			pkgJson.main ??
			"index.js";

		aliases.push({
			find: pkgName,
			replacement: join(pkgDir, rootTarget),
		});
	}

	return aliases;
}

const isMain =
	process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
	const arg = process.argv[2];
	if (arg === "--print-expected-version") {
		console.log(EXPECTED_PI_HOST_VERSION);
	} else if (arg === "--print-installed-version") {
		console.log(readHostPiVersion());
	} else {
		const { codingAgentDir, packages } = resolveHostPiPeers();
		if (arg === "--print-dir") {
			console.log(codingAgentDir);
		} else {
			console.log(JSON.stringify({ expectedVersion: EXPECTED_PI_HOST_VERSION, installedVersion: readHostPiVersion(codingAgentDir), packages }, null, 2));
		}
	}
}
