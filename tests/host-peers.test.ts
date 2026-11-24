import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { UserMessageComponent, VERSION } from "@earendil-works/pi-coding-agent";
import { Container, HStack, ScrollView, VStack, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { HOST_PEER_PACKAGES, resolveHostPiPeers } from "../scripts/resolve-host-pi.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("host-provided Pi peer package invariant", () => {
	it("never duplicates @earendil-works or typebox inside local node_modules", () => {
		expect(existsSync(join(REPO_ROOT, "node_modules", "@earendil-works"))).toBe(false);
		expect(existsSync(join(REPO_ROOT, "node_modules", "typebox"))).toBe(false);
	});

	it("keeps all host packages in peerDependencies ('*') and out of dependencies/devDependencies", () => {
		const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
			peerDependencies?: Record<string, string>;
		};

		for (const peer of HOST_PEER_PACKAGES) {
			expect(pkg.peerDependencies?.[peer]).toBe("*");
			expect(pkg.dependencies?.[peer]).toBeUndefined();
			expect(pkg.devDependencies?.[peer]).toBeUndefined();
		}
	});

	it("suppresses peer auto-installation via .npmrc", () => {
		const npmrc = readFileSync(join(REPO_ROOT, ".npmrc"), "utf8");
		expect(npmrc).toMatch(/^\s*legacy-peer-deps\s*=\s*true\s*$/m);
		expect(npmrc).toMatch(/^\s*auto-install-peers\s*=\s*false\s*$/m);
	});

	it("resolves host Pi peer packages and TypeBox cleanly in Vitest", () => {
		const { codingAgentDir, packages } = resolveHostPiPeers();
		expect(existsSync(codingAgentDir)).toBe(true);
		for (const peer of HOST_PEER_PACKAGES) {
			expect(existsSync(packages[peer])).toBe(true);
		}

		expect(typeof VERSION).toBe("string");
		expect(typeof UserMessageComponent).toBe("function");
		expect(typeof ScrollView).toBe("function");
		expect(typeof VStack).toBe("function");
		expect(typeof HStack).toBe("function");
		expect(typeof Container).toBe("function");
		expect(visibleWidth("hello")).toBe(5);

		const schema = Type.Object({ name: Type.String() });
		expect(Check(schema, { name: "pi-ui" })).toBe(true);
		expect(Check(schema, { name: 42 })).toBe(false);
	});
});
