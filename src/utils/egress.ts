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
	/**
	 * Stable identity of the node behind this hop, used to remember which
	 * nodes opencode has rate limited. Only a dynamic pool sets it; static
	 * entries fall back to their URL.
	 */
	key?: string;
	/**
	 * Exit IP the node presents, when the pool's control plane has measured
	 * it. A rate limit is per exit IP, so this is what lets the pool avoid an
	 * IP even after it comes back under a different node.
	 */
	ip?: string;
}

export type EgressStrategy = "stable" | "round-robin" | "random";

export interface EgressPool {
	proxies: EgressProxy[];
	strategy: EgressStrategy;
}

/**
 * Feedback about a request, so a dynamic pool can react to a hop that just
 * failed. Both variants are reported only after `fetch` has returned (or
 * thrown): the request itself is never replayed here.
 */
export type EgressEvent =
	/**
	 * The upstream answered 429. opencode limits the *exit IP*, not the hop,
	 * so the pool should retire the node for the rest of the day.
	 */
	| { type: "rate-limited"; status: number }
	/** The hop could not be reached at all (connect refused, TLS, timeout). */
	| { type: "unreachable"; error: string };

/**
 * Chooses the hop a request goes out through.
 *
 * `report` is optional: a static list has nothing to learn from a failure
 * and simply leaves it unimplemented, which also means the service never
 * retries a request for it.
 */
export interface EgressPicker {
	/** Returns the hop for this conversation seed, or undefined for direct. */
	pick(seed: string): EgressProxy | undefined;
	/**
	 * Tells the picker how a request ended. Returns true when it moved to a
	 * *different* hop, which is what makes a retry worth attempting.
	 */
	report?(proxy: EgressProxy | undefined, event: EgressEvent): boolean;
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
export class EgressSelector implements EgressPicker {
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

