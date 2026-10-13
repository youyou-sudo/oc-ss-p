// Service: business logic, decoupled from the Elysia controller.
import { Value } from "@sinclair/typebox/value";
import { env, status } from "elysia";

import { ProxyModel } from "./model";
import {
	conversationSeedOf,
	DEFAULT_SESSION_PREFIX,
	sessionFor,
} from "../../utils/session";
import { EgressSelector, parseProxies } from "../../utils/egress";
import { fingerprintFor, sessionPrefixFor } from "../../utils/fingerprint";

/** Per-conversation identity chosen for one request. */
interface Identity {
	seed: string;
	session: string;
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
			// Rotating prefixes and per-conversation fingerprints are opt-out,
			// so an existing SESSION_PREFIX/USER_AGENT/CLIENT setup keeps working.
			sessionPrefix:
				raw.SESSION_PREFIX ??
				(raw.ROTATE_SESSION_PREFIX === "1" ||
				raw.ROTATE_SESSION_PREFIX === "true"
					? null
					: DEFAULT_SESSION_PREFIX),
			sessionCounter: Number(raw.SESSION_COUNTER ?? 7),
			rotateSessionPrefix:
				raw.ROTATE_SESSION_PREFIX === "1" ||
				raw.ROTATE_SESSION_PREFIX === "true",
			userAgent: raw.USER_AGENT ?? null,
			client: raw.CLIENT ?? null,
			proxies: raw.PROXIES ? parseProxies(raw.PROXIES) : [],
			egressStrategy: raw.EGRESS_STRATEGY ?? "stable",
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
	 * Resolves the identity for one conversation: session id, user-agent and
	 * client tag. Any signal left unset falls back to a per-conversation
	 * fingerprint so users stop sharing one constant UA/client/session prefix.
	 */
	static identity(
		headers: Record<string, string | undefined>,
		rawBody: string,
		config: ProxyModel["config"],
	): Identity {
		const seed = conversationSeedOf(headers, rawBody);
		const fingerprint = fingerprintFor(seed);

		const prefix = config.rotateSessionPrefix
			? sessionPrefixFor(config.sessionCounter)
			: (config.sessionPrefix ?? sessionPrefixFor(config.sessionCounter));

		return {
			seed,
			session: sessionFor(prefix, fingerprint.sessionSuffix),
			userAgent: config.userAgent ?? fingerprint.userAgent,
			client: config.client ?? fingerprint.client,
		};
	}

	/**
 * Forwards a request to the upstream, injecting a structurally valid
	 * `x-opencode-session` header plus OpenCode client fallbacks.
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
		headers.set("x-opencode-session", session);
		headers.set("x-opencode-client", identity.client);
		if (!/^opencode\//.test(headers.get("user-agent") ?? ""))
			headers.set("user-agent", identity.userAgent);

		const hop = egress.pick(identity.seed);
		if (config.verbose)
			console.log(
				`${request.method} ${new URL(request.url).pathname} -> ${session} via ${hop?.label ?? hop?.url ?? "direct"}`,
			);

		let upstream: Response;
		try {
			upstream = await fetch(
				config.upstream + new URL(request.url).pathname + new URL(request.url).search,
				{
					method: request.method,
					headers,
					body: rawBody,
					redirect: "manual",
					...(hop ? { proxy: hop.url } : {}),
				},
			);
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

