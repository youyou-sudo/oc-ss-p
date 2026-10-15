import { Elysia } from "elysia";

import { proxy, proxyConfig } from "./modules/proxy";
import { sessionModeOf } from "./utils/session";

/**
 * Self-contained healthcheck used by the container HEALTHCHECK (the distroless
 * runtime image ships no curl/wget, so the probe has to live inside the
 * binary) and by the release smoke test. `server healthcheck` GETs /health on
 * the local listener and exits 0 only when the server reports ok.
 */
async function healthcheck(): Promise<number> {
	const host = proxyConfig.host === "0.0.0.0" ? "127.0.0.1" : proxyConfig.host;
	const url = `http://${host}:${proxyConfig.port}/health`;
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(4_000) });
		const body = (await response.json()) as { ok?: boolean };
		if (!response.ok || body.ok !== true) {
			console.error(`healthcheck failed: ${response.status} ${await response.text()}`);
			return 1;
		}
		return 0;
	} catch (error) {
		console.error(`healthcheck failed: ${(error as Error).message}`);
		return 1;
	}
}

// Subcommand mode: probe the running server instead of starting another one.
if (process.argv[2] === "healthcheck") {
	process.exit(await healthcheck());
}

const app = new Elysia()
	.use(proxy)
	.listen({ hostname: proxyConfig.host, port: proxyConfig.port });

console.log(
	`🦊 opencode-session-proxy on http://${app.server?.hostname}:${app.server?.port} -> ${proxyConfig.upstream}`,
);
if (proxyConfig.proxies.length > 0)
	console.log(
		`   egress via ${proxyConfig.proxies.length} prox${proxyConfig.proxies.length === 1 ? "y" : "ies"} (${proxyConfig.egressStrategy})`,
	);
else console.log("   egress direct (set PROXIES to route through an upstream proxy)");
if (!proxyConfig.userAgent || !proxyConfig.client)
	console.log("   fingerprint: per-conversation user-agent + client tag");
const sessionMode = sessionModeOf(proxyConfig);
console.log(
	sessionMode === "fixed"
		? `   session prefix ${proxyConfig.sessionPrefix} (fixed)`
		: sessionMode === "per-request"
			? `   session prefix minted per request (counter = ${proxyConfig.sessionCounter})`
			: `   session prefix minted per conversation (counter = ${proxyConfig.sessionCounter})`,
);
if (proxyConfig.canonicalizePaths)
	console.log("   paths canonicalized (e.g. /inference/v1/chat/completions -> /inference/openai/v1/chat/completions)");
