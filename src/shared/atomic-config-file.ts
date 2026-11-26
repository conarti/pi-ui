import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export function resolveConfigWritePath(filePath: string): string {
	const seen = new Set<string>();
	let path = resolve(filePath);
	while (!seen.has(path)) {
		seen.add(path);
		try {
			const target = readlinkSync(path);
			path = resolve(realpathSync(dirname(path)), target);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EINVAL" || code === "ENOENT") return path;
			throw error;
		}
	}
	throw new Error(`Symlink cycle in configuration path: ${path}`);
}

export function writeConfigJsonAtomically(targetPath: string, data: Record<string, unknown>, mode: number): void {
	const parent = dirname(targetPath);
	mkdirSync(parent, { recursive: true });
	const temporary = join(parent, `.${basename(targetPath)}-${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		chmodSync(temporary, mode);
		renameSync(temporary, targetPath);
	} finally {
		rmSync(temporary, { force: true });
	}
}
