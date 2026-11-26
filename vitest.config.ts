import { defineConfig } from "vitest/config";
import { buildHostPeerAliases } from "./scripts/resolve-host-pi.mjs";

export default defineConfig({
	resolve: {
		alias: buildHostPeerAliases(),
	},
	test: {
		environment: "node",
		include: ["tests/**/*.test.ts"],
		// Real InteractiveMode sessions share CPU across workers on hosted CI runners.
		testTimeout: process.env.CI ? 20_000 : 5_000,
		env: {
			FORCE_COLOR: "3",
		},
	},
});
