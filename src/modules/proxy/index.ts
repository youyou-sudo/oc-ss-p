import { Elysia } from "elysia";

import { ProxyService } from "./service";
import { EgressSelector } from "../../utils/egress";
import { sessionModeOf } from "../../utils/session";

// Controller: one Elysia instance routes and validates HTTP concerns only.
const config = ProxyService.config();
const egress = new EgressSelector({
	proxies: config.proxies,
	strategy: config.egressStrategy as "stable" | "round-robin" | "random",
});

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

