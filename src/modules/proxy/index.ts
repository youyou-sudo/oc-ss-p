import { Elysia } from "elysia";

import { ProxyService } from "./service";
import { EgressSelector, type EgressPicker } from "../../utils/egress";
import { NodePool } from "../../utils/nodepool";
import { sessionModeOf } from "../../utils/session";

// Controller: one Elysia instance routes and validates HTTP concerns only.
const config = ProxyService.config();

// The static pool is always built: it is the fallback when xc-p is down,
// empty, or fully rate limited, and a curated PROXIES list still beats
// quietly going out from this host's own IP.
const staticPool = new EgressSelector({
	proxies: config.proxies,
	strategy: config.egressStrategy as "stable" | "round-robin" | "random",
});

/** The xc-p-backed pool, present only when XCP_HOST is set. */
const nodePool = config.xcp
	? new NodePool({
			host: config.xcp.host,
			apiKey: config.xcp.apiKey,
			refreshMs: config.xcp.refreshMs,
			statePath: config.xcp.statePath,
			resetHour: config.xcp.resetHour,
			fallback: config.proxies.length > 0 ? staticPool : undefined,
		})
	: undefined;
nodePool?.start();

const egress: EgressPicker = nodePool ?? staticPool;

/** Validated config, exposed for the server entrypoint. */
export const proxyConfig = config;

export const proxy = new Elysia()
	/**
	 * Machine-readable liveness probe. Kept separate from `/` so container
	 * health checks and the release smoke test can assert one boolean without
	 * depending on the descriptive payload below.
	 */
	.get("/health", () => ({ ok: true }))
	/**
	 * Health check so you can confirm the proxy is up before pointing an
	 * upstream channel at it.
	 */
	.get("/", () => ({
		service: "opencode-session-proxy",
		upstream: config.upstream,
		session: {
			mode: sessionModeOf(config),
			prefix: config.sessionPrefix,
		},
		paths: {
			canonicalize: config.canonicalizePaths,
		},
		egress: {
			proxies: config.proxies.length,
			strategy: config.egressStrategy,
			// Live sticky-pool state: which node is in use, how many are left,
			// and which IPs are burned until the next 08:00 reset.
			...(nodePool ? { xcp: nodePool.status() } : {}),
		},
		fingerprint: {
			userAgent: config.userAgent ?? "per-conversation",
			client: config.client ?? "per-conversation",
		},
	}))
	/**
	 * Catch-all reverse proxy. `parse: "none"` keeps the raw body intact so
	 * it can be forwarded byte-for-byte and hashed for the session seed.
	 */
	.all(
		"/*",
		async ({ request }) => ProxyService.forward(request, config, egress),
		{
			parse: "none",
		},
	);

