// Service: business logic, decoupled from the Elysia controller.
import { Value } from "@sinclair/typebox/value";
import { env, status } from "elysia";

import { ProxyModel } from "./model";
import {
	conversationPrefixFor,
	conversationSeedOf,
	sessionFor,
	sessionModeOf,
} from "../../utils/session";
import { EgressSelector, parseProxies } from "../../utils/egress";
import {
	clientFromUserAgent,
	fingerprintFor,
	projectFor,
	sessionPrefixFor,
	userAgentFor,
} from "../../utils/fingerprint";
import { canonicalPath } from "../../utils/upstream";

/** Per-conversation identity chosen for one request. */
interface Identity {
	seed: string;
	session: string;
	project: string;
	userAgent: string;
	client: string;
}

/**
 * Parses and validates configuration from environment variables.
 * env values are strings, so this normalises them into the parsed shape
 * declared by ProxyModel.config.
 */
export abstract class ProxyService {
	/** Loads and validates config once at boot. Throws on invalid input. */
	static config(): ProxyModel["config"] {
		const raw: Record<string, string> = {};
		for (const key of [
			"PORT",
			"HOST",
			"UPSTREAM",
			"PROXIES",
			"EGRESS_STRATEGY",
			"SESSION_COUNTER",
			"SESSION_PREFIX",
			"ROTATE_SESSION_PREFIX",
			"USER_AGENT",
			"CLIENT",
			"CANONICALIZE_PATHS",
			"VERBOSE",
		] as const) {
			const value = env[key];
			if (value !== undefined && value !== "") raw[key] = value;
		}

		if (!Value.Check(ProxyModel.rawEnv, raw)) {
			const issues = [...Value.Errors(ProxyModel.rawEnv, raw)].map(
				(error) => `${error.path || "/"}: ${error.message}`,
			);
			throw new Error(`Invalid proxy environment: ${issues.join("; ")}`);
		}

		const config: ProxyModel["config"] = {
			upstream: (raw.UPSTREAM ?? "https://opencode.ai").replace(/\/+$/, ""),
			port: Number(raw.PORT ?? 8787),
			host: raw.HOST ?? "127.0.0.1",
			// Pinning a prefix is opt-in. Otherwise one is minted: per
			// conversation by default, per request under ROTATE_SESSION_PREFIX.
			sessionPrefix: raw.SESSION_PREFIX ?? null,
			// 1 is what a freshly started client embeds for its first id in a
			// millisecond; the counter occupies 12 bits, so 4095 is the ceiling.
			sessionCounter: Number(raw.SESSION_COUNTER ?? 1),
			rotateSessionPrefix:
				raw.ROTATE_SESSION_PREFIX === "1" ||
				raw.ROTATE_SESSION_PREFIX === "true",
			userAgent: raw.USER_AGENT ?? null,
			client: raw.CLIENT ?? null,
			proxies: raw.PROXIES ? parseProxies(raw.PROXIES) : [],
			egressStrategy: raw.EGRESS_STRATEGY ?? "stable",
			// On by default: it is a no-op for callers that already send a
			// family-scoped path, and it keeps legacy callers working.
			canonicalizePaths:
				raw.CANONICALIZE_PATHS !== "0" && raw.CANONICALIZE_PATHS !== "false",
			verbose: raw.VERBOSE === "1" || raw.VERBOSE === "true",
		};

		// Re-check the coerced numbers/bools against the parsed shape.
		if (!Value.Check(ProxyModel.config, config)) {
			const issues = [...Value.Errors(ProxyModel.config, config)].map(
				(error) => `${error.path || "/"}: ${error.message}`,
			);
			throw new Error(`Invalid proxy environment: ${issues.join("; ")}`);
		}

		return config;
	}

	/**
	 * Resolves the identity for one conversation: session id, project id,
	 * user-agent and client tag.
	 *
	 * A pinned USER_AGENT and a pinned CLIENT are kept consistent with each
	 * other, and a caller that already sends an OpenCode user-agent keeps it —
	 * with the client tag read back out of it, so the pair can never disagree.
	 * Everything left unset falls back to the per-conversation fingerprint.
	 */
	static identity(
		headers: Record<string, string | undefined>,
		rawBody: string,
		config: ProxyModel["config"],
	): Identity {
		const seed = conversationSeedOf(headers, rawBody);
		const fingerprint = fingerprintFor(seed);

		const callerAgent = (headers["user-agent"] ?? "").trim();
		const callerClient = /^opencode\//.test(callerAgent)
			? clientFromUserAgent(callerAgent)
			: undefined;
		const client =
			config.client ??
			clientFromUserAgent(config.userAgent) ??
			callerClient ??
			fingerprint.client;

		const mode = sessionModeOf(config);
		const prefix =
			mode === "fixed"
				? (config.sessionPrefix as string)
				: mode === "per-request"
					? sessionPrefixFor(config.sessionCounter)
					: conversationPrefixFor(
							fingerprint.sessionSuffix,
							config.sessionCounter,
						);

		return {
			seed,
			session: sessionFor(prefix, fingerprint.sessionSuffix),
			project: projectFor(fingerprint.sessionSuffix),
			userAgent:
				config.userAgent ??
				(callerClient ? callerAgent : userAgentFor(fingerprint.version, client)),
			client,
		};
	}

	/**
	 * Forwards a request to the upstream, injecting the identity headers an
	 * OpenCode client sends plus a canonical request path.
	 *
	 * Returns the upstream Response untouched (minus hop-by-hop and
	 * content-encoding headers) so status, streaming, and SSE all pass
	 * through transparently.
	 */
	static async forward(
		request: Request,
		config: ProxyModel["config"],
		egress: EgressSelector,
	): Promise<Response> {
		const hasBody =
			request.method !== "GET" && request.method !== "HEAD";
		const rawBody = hasBody
			? Buffer.from(await request.arrayBuffer())
			: undefined;

		const headers = new Headers(request.headers);
		// Hop-by-hop and entity headers Bun/fetch recompute for us.
		for (const name of [
			"host",
			"connection",
			"keep-alive",
			"proxy-authenticate",
			"proxy-authorization",
			"te",
			"trailer",
			"transfer-encoding",
			"upgrade",
			"content-length",
		]) {
			headers.delete(name);
		}

		const identity = ProxyService.identity(
			Object.fromEntries(headers.entries()),
			rawBody?.toString("utf8") ?? "",
			config,
		);
		const { session } = identity;
		// Spell the session the way the OpenCode client spells it:
		// `x-opencode-session` and `x-session-affinity` carry the session
		// affinity used for routing and prompt-cache keys, `x-opencode-session-id`
		// carries the session itself, and `X-Session-Id` mirrors it for the
		// providers that read that name.
		headers.set("x-opencode-session", session);
		headers.set("x-opencode-session-id", session);
		headers.set("x-session-affinity", session);
		headers.set("X-Session-Id", session);
		headers.set("x-opencode-client", identity.client);
		// Project ids belong to the caller (a git root commit, `host/path`, or
		// `"global"`), so only supply one when the caller sent none.
		if (!headers.has("x-opencode-project"))
			headers.set("x-opencode-project", identity.project);
		if (!/^opencode\//.test(headers.get("user-agent") ?? ""))
			headers.set("user-agent", identity.userAgent);

		const url = new URL(request.url);
		const target = canonicalPath(url.pathname, config.canonicalizePaths);
		const hop = egress.pick(identity.seed);
		if (config.verbose)
			console.log(
				`${request.method} ${url.pathname}${target.rewrittenFrom ? ` -> ${target.path}` : ""} -> ${session} via ${hop?.label ?? hop?.url ?? "direct"}`,
			);

		let upstream: Response;
		try {
			upstream = await fetch(config.upstream + target.path + url.search, {
				method: request.method,
				headers,
				body: rawBody,
				redirect: "manual",
				...(hop ? { proxy: hop.url } : {}),
			});
		} catch (error) {
			const message = `session proxy: upstream unreachable: ${(error as Error).message}`;
			throw status(502, message satisfies ProxyModel["upstreamUnreachable"]);
		}

		const responseHeaders = new Headers(upstream.headers);
		// Bun transparently decompresses the upstream body, so forwarding the
		// original content-encoding/content-length would mislabel the bytes.
		for (const name of ["content-encoding", "content-length"]) {
			responseHeaders.delete(name);
		}

		return new Response(upstream.body, {
			status: upstream.status,
			headers: responseHeaders,
		});
	}
}
