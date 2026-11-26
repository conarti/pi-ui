export declare const EXPECTED_PI_HOST_VERSION: string;
export declare const HOST_PEER_PACKAGES: readonly string[];

export declare function findHostPiCodingAgentDir(): string;

export declare function resolveHostPiPeers(): {
	codingAgentDir: string;
	packages: Record<string, string>;
};

export declare function readHostPiVersion(codingAgentDir?: string): string;

export declare function compareSemver(a: string, b: string): number;

export declare function buildHostPeerAliases(): Array<{
	find: string | RegExp;
	replacement: string;
}>;
