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
import { parseProxies, type EgressPicker } from "../../utils/egress";
import {
	clientFromUserAgent,
	fingerprintFor,
	sessionPrefixFor,
	userAgentFor,
} from "../../utils/fingerprint";
import { canonicalPath } from "../../utils/upstream";
import {
	isZenFreeModel,
	zenFreePath,
	zenFreeRequestBody,
	zenFreeStreamFilter,
	ZEN_TOOL_SCHEMAS,
	ZEN_TOOL_STUB_DESCRIPTION,
	ZEN_TOOLS,
} from "../../utils/zen";

/** Node list is re-read every 6 minutes unless XCP_REFRESH_MS says otherwise. */
const DEFAULT_REFRESH_MS = 6 * 60 * 1000;
/** Daily rate-limit record; relative paths resolve against the working directory. */
const DEFAULT_STATE_PATH = ".oc-ss-p/rate-limited.json";

/** Per-conversation identity chosen for one request. */
interface Identity {
	seed: string;
	session: string;
	request: string;
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
			"XCP_HOST",
			"XCP_API_KEY",
			"XCP_REFRESH_MS",
			"XCP_RETRIES",
			"XCP_STATE",
			"XCP_RESET_HOUR",
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
			// Opt-in: an install that never sets XCP_HOST behaves exactly as
			// before, static PROXIES or direct.
			xcp: raw.XCP_HOST
				? {
						host: raw.XCP_HOST.replace(/\/+$/, ""),
						apiKey: raw.XCP_API_KEY ?? "",
						refreshMs: Number(raw.XCP_REFRESH_MS ?? DEFAULT_REFRESH_MS),
						statePath: raw.XCP_STATE ?? DEFAULT_STATE_PATH,
						resetHour: Number(raw.XCP_RESET_HOUR ?? 8),
					}
				: null,
			egressRetries: Number(raw.XCP_RETRIES ?? 1),
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
	 * Resolves the identity for one conversation: session id, request id,
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
			// One per request, as the client does: `msg_` + an ascending
			// clock id (magpie, provider.openCodeNewID).
			request: turnRequestID(),
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
	 * A request to one of OpenCode Zen's free models goes out as OpenCode
	 * itself sends one (magpie's gateway/zenfree.go): at the inference API's
	 * URL, streamed, offering tools named bash and read, and with the
	 * model's calls of the client's own tools renamed back on the way
	 * through.
	 *
	 * Returns the upstream Response untouched (minus hop-by-hop and
	 * content-encoding headers) so status, streaming, and SSE all pass
	 * through transparently.
	 */
	static async forward(
		request: Request,
		config: ProxyModel["config"],
		egress: EgressPicker,
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

		const bodyText = rawBody?.toString("utf8") ?? "";
		const identity = ProxyService.identity(
			Object.fromEntries(headers.entries()),
			bodyText,
			config,
		);
		const { session } = identity;

		// A request to one of Zen's free models is translated.
		let model = "";
		try {
			model = String(
				(JSON.parse(bodyText) as { model?: unknown }).model ?? "",
			);
		} catch {
			// Not JSON, or no model: not a free-model request.
		}
		const free = isZenFreeModel(model);

		// Spell the identity the way the OpenCode client spells it (magpie,
		// provider.OpenCodeClient): the session in x-opencode-session and
		// x-opencode-session-id, the turn in x-opencode-request. OpenCode
		// 1.19.0 sends Zen neither x-session-affinity nor X-Session-Id, and
		// since mid-October 2026 Zen's free tier answers 403 FreeTierError to
		// a request carrying x-session-affinity, so neither goes.
		headers.set("x-opencode-session", session);
		headers.set("x-opencode-session-id", session);
		headers.set("x-opencode-request", identity.request);
		headers.delete("x-session-affinity");
		headers.delete("X-Session-Id");
		headers.set("x-opencode-client", identity.client);
		// OpenCode's project outside a git repository is `global`, and Zen
		// reads the project as OpenCode lays one out.
		headers.set("x-opencode-project", "global");
		if (!/^opencode\//.test(headers.get("user-agent") ?? ""))
			headers.set("user-agent", identity.userAgent);

		const url = new URL(request.url);
		const canonical = canonicalPath(url.pathname, config.canonicalizePaths);
		// Zen's free tier answers at the inference API's URL alone (magpie,
		// provider.OpenCodeFreeURL): /zen/... -> /inference/....
		const zen = free ? zenFreePath(canonical.path) : { path: canonical.path };
		const target = {
			path: zen.path,
			rewrittenFrom: zen.rewrittenFrom ?? canonical.rewrittenFrom,
		};
		const payload = hasBody
			? Buffer.from(free ? zenFreeRequestBody(bodyText) : bodyText, "utf8")
			: undefined;

		// A 429 or a dead hop is reported back to the picker, which retires
		// that node and moves to another one. Neither failure ever reached
		// opencode, so replaying the request is free of side effects; the
		// retry budget is what keeps a fully rate-limited pool from looping.
		const attempts = 1 + config.egressRetries;
		let upstream: Response;
		for (let attempt = 0; ; attempt++) {
			const hop = egress.pick(identity.seed);
			if (config.verbose)
				console.log(
					`${request.method} ${url.pathname}${target.rewrittenFrom ? ` -> ${target.path}` : ""} -> ${session} via ${hop?.label ?? hop?.url ?? "direct"}${free ? " (zen free)" : ""}${attempt > 0 ? ` (attempt ${attempt + 1})` : ""}`,
				);

			try {
				upstream = await fetch(config.upstream + target.path + url.search, {
					method: request.method,
					headers,
					body: payload,
					redirect: "manual",
					...(hop ? { proxy: hop.url } : {}),
				});
			} catch (error) {
				// A node that cannot carry the request shows up here, not as a
				// status code: an https upstream tunnels through CONNECT, and a
				// hop that cannot reach it either refuses the tunnel (407/502)
				// or accepts it and then drops the socket — Bun throws either
				// way, which is why the pool keys on the throw. An http
				// upstream would instead forward the hop's bare 5xx.
				const message = (error as Error).message;
				const switched =
					egress.report?.(hop, { type: "unreachable", error: message }) ?? false;
				if (switched && attempt < attempts - 1) continue;
				throw status(
					502,
					`session proxy: upstream unreachable: ${message}` satisfies ProxyModel["upstreamUnreachable"],
				);
			}

			if (upstream.status !== 429) break;
			// opencode limits the exit IP, not this proxy: retire the node for
			// the rest of the day and try once more from another one.
			const switched =
				egress.report?.(hop, { type: "rate-limited", status: upstream.status }) ??
				false;
			if (!switched || attempt >= attempts - 1) break;
			await upstream.body?.cancel().catch(() => {});
		}

		const responseHeaders = new Headers(upstream.headers);
		// Bun transparently decompresses the upstream body, so forwarding the
		// original content-encoding/content-length would mislabel the bytes.
		for (const name of ["content-encoding", "content-length"]) {
			responseHeaders.delete(name);
		}

		if (!free || !upstream.body) {
			return new Response(upstream.body, {
				status: upstream.status,
				headers: responseHeaders,
			});
		}

		// The reply comes back in the free tier's vocabulary: tool-call names
		// go back under the client's own, calls of an injected stub are
		// dropped, and a turn that called nothing but a stub ends on a stop.
		const { back, stubs } = zenFreeBookkeeping(bodyText);
		if (back.size === 0 && stubs.size === 0) {
			return new Response(upstream.body, {
				status: upstream.status,
				headers: responseHeaders,
			});
		}
		const filter = zenFreeStreamFilter(back, stubs);
		const stream = upstream.body
			.pipeThrough(new TextDecoderStream())
			.pipeThrough(sseTransform(filter))
			.pipeThrough(new TextEncoderStream());
		return new Response(stream, {
			status: upstream.status,
			headers: responseHeaders,
		});
	}
}

/**
 * Reads which of the client's tools the free tier saw under a renamed or
 * stubbed name, from the request as the client sent it (before
 * zenFreeRequestBody translated it): a name offered under the lowercase
 * one maps back to the client's, and the injected stubs are named here.
 */
function zenFreeBookkeeping(rawBody: string): {
	back: Map<string, string>;
	stubs: Set<string>;
} {
	const back = new Map<string, string>();
	const stubs = new Set<string>();
	let tools: unknown[];
	try {
		const parsed = JSON.parse(rawBody) as { tools?: unknown };
		if (!Array.isArray(parsed.tools)) return { back, stubs };
		tools = parsed.tools;
	} catch {
		return { back, stubs };
	}
	const seen = new Set(
		tools
			.map((t) => (t as { function?: { name?: unknown }; name?: unknown }))
			.map((t) =>
				typeof t?.name === "string"
					? t.name
					: typeof t?.function?.name === "string"
						? t.function.name
						: "",
			)
			.filter(Boolean),
	);
	for (const need of ZEN_TOOLS) {
		if (seen.has(need)) continue;
		const folded = [...seen].find((n) => n.toLowerCase() === need);
		if (folded) back.set(need, folded);
		else stubs.add(need);
	}
	return { back, stubs };
}

/**
 * An SSE transform that runs chunkFilter over each `data:` payload. The
 * upstream sends one event per write, so line-oriented splitting keeps the
 * stream intact for anything this does not rewrite.
 */
function sseTransform(
	chunkFilter: (chunk: Record<string, unknown>) => Record<string, unknown> | null,
): TransformStream<string, string> {
	let buffer = "";
	return new TransformStream<string, string>({
		transform(part, controller) {
			buffer += part;
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) controller.enqueue(rewriteLine(line, chunkFilter));
		},
		flush(controller) {
			if (buffer) controller.enqueue(rewriteLine(buffer, chunkFilter));
		},
	});
}

function rewriteLine(
	line: string,
	chunkFilter: (chunk: Record<string, unknown>) => Record<string, unknown> | null,
): string {
	const trimmed = line.trim();
	if (!trimmed.startsWith("data:")) return line;
	const data = trimmed.slice(5).trim();
	if (!data || data === "[DONE]") return line;
	try {
		const chunk = JSON.parse(data) as Record<string, unknown>;
		return `data: ${JSON.stringify(chunkFilter(chunk))}\n`;
	} catch {
		return line;
	}
}

/** Builds the per-turn `msg_` id OpenCode sends as x-opencode-request. */
function turnRequestID(): string {
	const now = Date.now();
	const value = BigInt(now) * 0x1000n + 1n;
	const hex = (value & ((1n << 48n) - 1n)).toString(16).padStart(12, "0");
	const B62 =
		"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
	let suffix = "";
	for (let i = 0; i < 14; i++)
		suffix += B62[Math.floor(Math.random() * B62.length)];
	return `msg_${hex}${suffix}`;
}

// Re-exported so the stub schemas stay reachable from tests.
export { ZEN_TOOL_SCHEMAS, ZEN_TOOL_STUB_DESCRIPTION, ZEN_TOOLS };