/**
 * Utility: egress proxy pool.
 *
 * The proxy hides the server's own IP by sending upstream traffic through a
 * separate hop. Which hop is used is chosen per conversation, so a single
 * conversation keeps one exit IP for its lifetime (a stable identity is
 * less suspicious than one that moves between turns).
 *
 * Only HTTP/HTTPS proxies are supported: Bun's fetch rejects
 * `socks5://` and `socks5h://` URLs with `UnsupportedProxyProtocol`.
 */

export interface EgressProxy {
	/** Passed straight to `fetch({ proxy })`. Must be http:// or https://. */
	url: string;
	/** Label for logs. Defaults to the URL. */
	label?: string;
}

export type EgressStrategy = "stable" | "round-robin" | "random";

export interface EgressPool {
	proxies: EgressProxy[];
	strategy: EgressStrategy;
}

/**
 * Parses `PROXIES` env values. Supports a comma or newline separated list of
 * URLs, where each entry may be `url` or `url#label`.
 */
export function parseProxies(raw: string): EgressProxy[] {
	return raw
		.split(/[\n,]/)
		.map((entry) => entry.trim())
		.filter(Boolean)
		.map((entry) => {
			const [url, label] = entry.split("#");
			return { url: url.trim(), label: label?.trim() };
		})
		.filter((proxy) => {
			if (!/^https?:\/\//i.test(proxy.url)) {
				throw new Error(
					`Unsupported egress proxy "${proxy.url}": only http:// and https:// are supported by Bun fetch (socks5/socks5h are not).`,
				);
			}
			return true;
		});
}

/**
 * Picks a proxy for a conversation seed. Returns undefined when the pool is
 * empty, which means "connect directly".
 */
export class EgressSelector {
	private cursor = 0;

	constructor(private readonly pool: EgressPool) {}

	get size(): number {
		return this.pool.proxies.length;
	}

	/** Returns the proxy bound to this seed, or undefined for direct egress. */
	pick(seed: string): EgressProxy | undefined {
		const { proxies, strategy } = this.pool;
		if (proxies.length === 0) return undefined;

		switch (strategy) {
			case "round-robin":
				return proxies[this.cursor++ % proxies.length];
			case "random":
				return proxies[Math.floor(Math.random() * proxies.length)];
			case "stable":
			default: {
				// Same seed -> same proxy, so a conversation keeps one exit.
				const digest = new Bun.CryptoHasher("sha256")
					.update(`egress:${seed}`)
					.digest();
				let n = 0n;
				for (const byte of digest.subarray(0, 8)) n = (n << 8n) | BigInt(byte);
				return proxies[Number(n % BigInt(proxies.length))];
			}
		}
	}
}

