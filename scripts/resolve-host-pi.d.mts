export declare const HOST_PEER_PACKAGES: readonly string[];

export declare function findHostPiCodingAgentDir(): string;

export declare function resolveHostPiPeers(): {
	codingAgentDir: string;
	packages: Record<string, string>;
};

export declare function buildHostPeerAliases(): Array<{
	find: string | RegExp;
	replacement: string;
}>;
