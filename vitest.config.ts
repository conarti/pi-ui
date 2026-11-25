import { defineConfig } from "vitest/config";
import { buildHostPeerAliases } from "./scripts/resolve-host-pi.mjs";

export default defineConfig({
	resolve: {
		alias: buildHostPeerAliases(),
	},
	test: {
		environment: "node",
		include: ["tests/**/*.test.ts"],
		env: {
			FORCE_COLOR: "3",
		},
	},
});
