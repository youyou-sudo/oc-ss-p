/**
 * Utility: the xc-p service API (`/v1`), as this proxy needs it.
 *
 * xc-p (Xray node pool panel) publishes its pool through a **single-port
 * gateway** that speaks HTTP proxy and SOCKS5 on one listener and selects the
 * node from the **proxy credentials**: the username is the node id and the
 * password is that node's credential. So every node has the same
 * `host:port`, and the hop is the whole `http://user:pass@host:port` URL.
 *
 * Three calls are enough to build the pool:
 *
 * - `GET /v1/nodes` — per-node health: `status.state`
 *   (`up | degraded | down | quarantined | unknown`), `delayMs` and the
 *   measured `exitIp`. This is what "choose by status" means.
 * - `GET /v1/endpoints` — the enabled nodes' `username`/`password`, which
 *   is the only bulk source of credentials.
 * - `GET /v1/gateway` — the gateway port (and whether it is enabled).
 *
 * `/v1` is the API-key surface (Bearer token, no cookie session), so the key
 * needs the `read` and `credentials` scopes. The panel API (`/api`) is
 * deliberately not used: a service integration must not depend on an
 * interactive admin login.
 */

import type { EgressProxy } from "./egress";

/** Node health state, from xc-p's detection state machine. */
export type XcpNodeState =
	| "up"
	| "degraded"
	| "down"
	| "quarantined"
	| "unknown";

/** One node of `GET /v1/nodes`, flattened to what selection needs. */
export interface XcpNode {
	id: string;
	name: string;
	countryCode: string;
	protocol: string;
	state: XcpNodeState;
	/** Measured round-trip in ms, 0 when never measured. */
	delayMs: number;
	/** Exit IP confirmed by detection, empty when unknown. */
	exitIp: string;
}

/** One node of `GET /v1/endpoints`. */
export interface XcpEndpoint {
	nodeId: string;
	name: string;
	username: string;
	password: string;
}

/** The subset of `GET /v1/gateway` this proxy reads. */
export interface XcpGateway {
	/** Host xc-p advertises; not used for dialling (see `XcpClient.gatewayHost`). */
	host: string;
	port: number;
	enabled: boolean;
	/** `username-only` gateways accept any password. */
	authMode: "strict" | "username-only";
}

const PAGE_LIMIT = 200;
const MAX_PAGES = 25;

/**
 * Reads the xc-p service API.
 *
 * Every call is bounded by a timeout: the pool refreshes on a timer, and one
 * unresponsive control plane must not pile requests up behind it.
 */
export class XcpClient {
	private readonly base: string;

	constructor(
		host: string,
		private readonly apiKey = "",
		private readonly timeoutMs = 10_000,
	) {
		// Keep any sub-path (a reverse-proxied install) by resolving relative
		// to a base that always ends in "/".
		this.base = host.replace(/\/+$/, "") + "/";
	}

	/** The host the gateway is reachable on: the API host itself. */
	get gatewayHost(): string {
		try {
			return new URL(this.base).hostname;
		} catch {
			return "127.0.0.1";
		}
	}

	/**
	 * Every enabled, supported node with its health state, best first
	 * (`up`, then `degraded`, then never-checked `unknown`, then by delay).
	 */
	async nodes(): Promise<XcpNode[]> {
		const nodes: XcpNode[] = [];
		let cursor = 0;
		for (let page = 0; page < MAX_PAGES; page++) {
			const body = (await this.request(
				`v1/nodes?enabled=true&supported=true&limit=${PAGE_LIMIT}&cursor=${cursor}`,
			)) as { items?: unknown; nextCursor?: unknown };
			if (!Array.isArray(body.items))
				throw new Error("xc-p v1/nodes: response has no items[]");
			for (const raw of body.items) nodes.push(normaliseNode(raw));
			const next = body.nextCursor;
			if (typeof next !== "number" || next <= cursor) break;
			cursor = next;
		}
		return nodes.sort(compareNodes);
	}

	/** Enabled nodes with their gateway credentials. */
	async endpoints(): Promise<XcpEndpoint[]> {
		const body = (await this.request("v1/endpoints?limit=1000")) as {
			items?: unknown;
		};
		if (!Array.isArray(body.items))
			throw new Error("xc-p v1/endpoints: response has no items[]");
		return body.items.map(normaliseEndpoint).filter((endpoint) => endpoint.nodeId);
	}

	/** Gateway listener state: the port every hop dials. */
	async gateway(): Promise<XcpGateway> {
		const body = (await this.request("v1/gateway")) as Record<string, unknown>;
		return {
			host: stringOf(body.host),
			port: numberOf(body.port),
			enabled: body.enabled !== false,
			authMode: body.authMode === "username-only" ? "username-only" : "strict",
		};
	}

	private async request(path: string): Promise<unknown> {
		const headers: Record<string, string> = { accept: "application/json" };
		if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
		const response = await fetch(new URL(path, this.base), {
			headers,
			signal: AbortSignal.timeout(this.timeoutMs),
		});
		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			throw new Error(
				`xc-p ${path.split("?")[0]}: ${response.status}${detail ? ` ${detail.trim()}` : ""}`,
			);
		}
		return response.json();
	}
}

/**
 * Builds the gateway hop for one node.
 *
 * The credentials are the node's identity at the gateway, so the URL is the
 * whole selection: two nodes differ only by `user:pass`. The host is the
 * control-plane host rather than `gateway.host`, because xc-p advertises
 * `panel.baseUrl` there — a display name that may not resolve from here.
 */
export function hopFor(
	node: XcpNode,
	endpoint: XcpEndpoint,
	gateway: XcpGateway,
	gatewayHost: string,
): EgressProxy | undefined {
	if (!gateway.enabled || gateway.port <= 0) return undefined;
	const user = encodeURIComponent(endpoint.username);
	const pass =
		gateway.authMode === "username-only" || !endpoint.password
			? ""
			: `:${encodeURIComponent(endpoint.password)}`;
	return {
		url: `http://${user}${pass}@${gatewayHost}:${gateway.port}`,
		label: node.name || node.id,
		key: `node:${node.id}`,
		ip: node.exitIp || undefined,
	};
}

/**
 * How good a node's state is, lowest first.
 *
 * `down` and `quarantined` are known-bad and never offered; `unknown` (never
 * checked yet) is kept as a last resort so a freshly imported pool still
 * serves traffic instead of falling back to a direct connection.
 */
export function stateRank(state: XcpNodeState): number {
	switch (state) {
		case "up":
			return 0;
		case "degraded":
			return 1;
		case "unknown":
			return 2;
		default:
			return 3;
	}
}

/** True when a node in this state may carry traffic. */
export function isUsableState(state: XcpNodeState): boolean {
	return stateRank(state) < 3;
}

/** Best state first, then lowest measured delay. */
function compareNodes(a: XcpNode, b: XcpNode): number {
	return (
		stateRank(a.state) - stateRank(b.state) ||
		(a.delayMs > 0 ? a.delayMs : Number.MAX_SAFE_INTEGER) -
			(b.delayMs > 0 ? b.delayMs : Number.MAX_SAFE_INTEGER)
	);
}

function normaliseNode(raw: unknown): XcpNode {
	const node = (raw ?? {}) as Record<string, unknown>;
	const status = (node.status ?? {}) as Record<string, unknown>;
	return {
		id: stringOf(node.id),
		name: stringOf(node.displayName),
		countryCode: stringOf(node.countryCode),
		protocol: stringOf(node.protocol),
		state: stateOf(status.state),
		delayMs: numberOf(status.delayMs),
		exitIp: stringOf(status.exitIp),
	};
}

function normaliseEndpoint(raw: unknown): XcpEndpoint {
	const endpoint = (raw ?? {}) as Record<string, unknown>;
	return {
		nodeId: stringOf(endpoint.nodeId),
		name: stringOf(endpoint.name),
		username: stringOf(endpoint.username),
		password: stringOf(endpoint.password),
	};
}

/** Unknown wire values fall back to `unknown` rather than to `up`. */
function stateOf(value: unknown): XcpNodeState {
	switch (value) {
		case "up":
		case "degraded":
		case "down":
		case "quarantined":
			return value;
		default:
			return "unknown";
	}
}

function stringOf(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function numberOf(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
