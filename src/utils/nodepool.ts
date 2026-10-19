/**
 * Utility: the sticky egress pool fed by xc-p.
 *
 * Behaviour, in one paragraph: every `refreshMs` (6 minutes) the node list is
 * pulled again; the best node is chosen by its reported health and *kept* for
 * every request until it breaks. A request that comes back 429, or that
 * cannot be dialled at all, retires that node and switches to the next one,
 * and a node whose exit IP was already rate limited today is never chosen —
 * see `ratelimit.ts` for the daily record and the 08:00 reset.
 *
 * Sticky rather than per-conversation (`EGRESS_STRATEGY=stable`) on purpose:
 * the pool exists to survive a rate limit, so the exit IP has to change when
 * opencode says so and *only* then. Rotating per conversation would spread
 * the load across IPs but also burn the whole pool in minutes.
 *
 * Selection is by status, because xc-p actually measures it: its detection
 * state machine keeps `up` / `degraded` / `down` / `quarantined` / `unknown`
 * per node, with the observed delay and exit IP. `up` nodes win, then
 * `degraded`, then never-checked `unknown`; `down` and `quarantined` are
 * never offered. Failures are still handled locally on top of that: a node
 * that fails to connect is parked for `failureCooldownMs`, and xc-p's own
 * detection will demote it on the next pass.
 */

import { RateLimitLedger } from "./ratelimit";
import { XcpClient, hopFor, isUsableState, type XcpNodeState } from "./xcp";
import type { EgressEvent, EgressPicker, EgressProxy } from "./egress";

export interface NodePoolConfig {
	/** Base URL of the xc-p panel / service API. */
	host: string;
	/** Service API key, needs the `read` and `credentials` scopes. */
	apiKey: string;
	/** How often the node list is re-read. */
	refreshMs: number;
	/** Where the daily rate-limit record lives. */
	statePath: string;
	/** Hour the rate-limit record rolls over (08:00 by default). */
	resetHour: number;
	/** How long a node stays out after a connection failure. */
	failureCooldownMs?: number;
	/** Static `PROXIES` pool, used when xc-p yields no usable node. */
	fallback?: EgressPicker;
}

/** One node, plus the gateway hop that reaches it. */
interface PoolNode {
	proxy: EgressProxy;
	id: string;
	name: string;
	/** Ledger key: the xc-p node id. */
	key: string;
	/** Exit IP measured by xc-p's detection, when it ran. */
	ip?: string;
	state: XcpNodeState;
}

/** Default park time for a node that failed to connect. */
const DEFAULT_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

export class NodePool implements EgressPicker {
	private readonly client: XcpClient;
	private readonly ledger: RateLimitLedger;
	private readonly failureCooldownMs: number;
	private readonly fallback?: EgressPicker;

	private nodes: PoolNode[] = [];
	private current?: PoolNode;
	/** key -> timestamp the node may be used again after a failure. */
	private readonly failures = new Map<string, number>();

	private timer?: ReturnType<typeof setInterval>;
	private refreshing = false;
	/** Timestamp of the last successful refresh. */
	private lastRefreshAt = 0;
	/** Timestamp of the last attempt, successful or not (throttles retries). */
	private lastAttemptAt = 0;
	private lastError?: string;
	private lastPoolSize = -1;

	constructor(private readonly config: NodePoolConfig) {
		this.client = new XcpClient(config.host, config.apiKey);
		this.ledger = new RateLimitLedger(config.statePath, config.resetHour);
		this.failureCooldownMs =
			config.failureCooldownMs ?? DEFAULT_FAILURE_COOLDOWN_MS;
		this.fallback = config.fallback;
	}

	/** Loads the persisted rate-limit record and starts the refresh timer. */
	start(): void {
		this.ledger.load();
		if (this.ledger.size > 0)
			this.log(`${this.ledger.size} IP(s) still rate limited today`);
		if (this.timer) return;
		void this.refresh();
		this.timer = setInterval(() => void this.refresh(), this.config.refreshMs);
		// Do not keep the process alive for the poller alone.
		this.timer.unref?.();
	}

	/** Stops refreshing (used by tests and by a clean shutdown). */
	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = undefined;
	}

	/**
	 * The hop for this request. The seed is ignored: the pool is sticky by
	 * design, not per conversation.
	 */
	pick(seed: string): EgressProxy | undefined {
		// Self-heal a pool that started while xc-p was unreachable, but never
		// more often than one attempt per refresh interval: otherwise every
		// request during an outage would fire another one.
		if (
			this.nodes.length === 0 &&
			!this.refreshing &&
			Date.now() - this.lastAttemptAt >= this.config.refreshMs
		)
			void this.refresh();

		const current = this.current;
		if (!current || !this.selectable(current)) {
			this.current = this.choose();
			if (this.current)
				this.log(`using ${this.current.name} (${describe(this.current)})`);
		}
		const node = this.current;
		if (node) return node.proxy;
		return this.fallback?.pick(seed);
	}

	/**
	 * Reacts to a 429 or an unreachable node: retires the node and moves on.
	 * Returns true only when it landed on a *different* node, which is the
	 * signal the service uses to retry the request once.
	 */
	report(proxy: EgressProxy | undefined, event: EgressEvent): boolean {
		if (!proxy) return false;
		const node = this.nodes.find((candidate) => candidate.proxy.url === proxy.url);
		if (!node) return false;
		const name = node.name || node.id;

		if (event.type === "rate-limited") {
			const first = this.ledger.mark(node.key, {
				tag: node.id,
				name: node.name,
				ip: node.ip,
				reason: "rate-limited",
			});
			if (first)
				this.log(
					`${name} (${describe(node)}) rate limited (${event.status}); retiring it for today`,
				);
		} else {
			this.failures.set(node.key, Date.now() + this.failureCooldownMs);
			this.log(`${name} (${describe(node)}) unreachable: ${event.error}`);
		}

		const next = this.choose(node);
		this.current = next;
		if (!next) {
			this.log(
				this.fallback
					? "no usable node left; falling back to the static PROXIES pool"
					: "no usable node left; going direct",
			);
			return false;
		}
		this.log(`switching to ${next.name} (${describe(next)})`);
		return true;
	}

	/** Re-reads the node list. Keeps the previous list when the call fails. */
	async refresh(): Promise<void> {
		if (this.refreshing) return;
		this.refreshing = true;
		try {
			const [nodes, endpoints, gateway] = await Promise.all([
				this.client.nodes(),
				this.client.endpoints(),
				this.client.gateway(),
			]);

			// Credentials come from /v1/endpoints, health from /v1/nodes: one
			// node needs both to be a hop, so join on the node id. Walk the
			// *health* list because the client already ranked it (state, then
			// delay) — iterating the credential list instead would pick in
			// node-id order and throw that ranking away.
			const credentials = new Map(
				endpoints.map((endpoint) => [endpoint.nodeId, endpoint]),
			);
			const pool: PoolNode[] = [];
			for (const node of nodes) {
				const endpoint = credentials.get(node.id);
				if (!endpoint || !isUsableState(node.state)) continue;
				const proxy = hopFor(
					node,
					endpoint,
					gateway,
					this.client.gatewayHost,
				);
				if (!proxy) continue;
				pool.push({
					proxy,
					id: node.id,
					name: node.name || node.id,
					key: proxy.key ?? `node:${node.id}`,
					ip: proxy.ip,
					state: node.state,
				});
			}

			this.nodes = pool;
			this.lastRefreshAt = Date.now();
			this.lastError = undefined;
			this.notePoolChange(pool);

			// The 08:00 boundary may have passed since the last tick; this is
			// what actually clears the record for a long-running process.
			if (this.ledger.prune()) this.log("rate-limit records cleared for the new day");

			// Re-bind the sticky node to this refresh's object, and move on if
			// xc-p dropped or demoted it (disabled, unpublished, quarantined).
			const current = this.current;
			if (current) {
				const rebound = pool.find((node) => node.key === current.key);
				if (rebound) this.current = rebound;
				else {
					this.log(`${current.name} left the pool; switching`);
					this.current = this.choose();
				}
			}
			// Choosing is part of the refresh ("pull the list, pick one, keep
			// using it"), so the pool has a node before the first request.
			if (!this.current) {
				this.current = this.choose();
				if (this.current)
					this.log(`using ${this.current.name} (${describe(this.current)})`);
			}
		} catch (error) {
			// Keep the last known list: a control plane that is briefly
			// unreachable must not drop every exit IP at once.
			const message = (error as Error).message;
			if (message !== this.lastError) {
				this.lastError = message;
				console.warn(`[xc-p] refresh failed: ${message}`);
			}
		} finally {
			this.refreshing = false;
			this.lastAttemptAt = Date.now();
		}
	}

	/** Machine-readable state for `GET /`. */
	status(): {
		host: string;
		refreshMs: number;
		nodes: number;
		states: Record<string, number>;
		current: { id: string; name: string; key: string; state: string; ip: string | null; url: string } | null;
		rateLimitedToday: number;
		lastRefreshAt: string | null;
		lastError: string | null;
	} {
		const current = this.current;
		const states: Record<string, number> = {};
		for (const node of this.nodes)
			states[node.state] = (states[node.state] ?? 0) + 1;
		return {
			host: this.config.host,
			refreshMs: this.config.refreshMs,
			nodes: this.nodes.length,
			states,
			current: current
				? {
						id: current.id,
						name: current.name,
						key: current.key,
						state: current.state,
						ip: current.ip ?? null,
						url: current.proxy.url,
					}
				: null,
			rateLimitedToday: this.ledger.size,
			lastRefreshAt: this.lastRefreshAt
				? new Date(this.lastRefreshAt).toISOString()
				: null,
			lastError: this.lastError ?? null,
		};
	}

	/** True when the node is in the list, allowed by state, and not parked. */
	private selectable(node: PoolNode): boolean {
		if (!this.nodes.includes(node)) return false;
		// Two checks on purpose: the node id catches the node itself coming
		// back, the exit IP catches the same exit under a different node.
		if (this.ledger.has(node.key) || this.ledger.hasIp(node.ip)) return false;
		const until = this.failures.get(node.key);
		return until === undefined || until <= Date.now();
	}

	/** Best-ranked usable node; the list is already ordered best-first. */
	private choose(exclude?: PoolNode): PoolNode | undefined {
		return this.nodes.find(
			(node) => node !== exclude && this.selectable(node),
		);
	}

	/** Reports a pool that appeared, emptied, or changed size. */
	private notePoolChange(pool: PoolNode[]): void {
		if (pool.length === this.lastPoolSize) return;
		this.lastPoolSize = pool.length;
		if (pool.length === 0) {
			console.warn("[xc-p] no usable node in the pool; not proxying");
			return;
		}
		this.log(`${pool.length} usable node(s) in the pool`);
	}

	private log(message: string): void {
		console.log(`[xc-p] ${message}`);
	}
}

/** Log-friendly node identity: name, state, and the exit IP when known. */
function describe(node: PoolNode): string {
	const parts = [`state ${node.state}`];
	if (node.ip) parts.push(`exit ${node.ip}`);
	parts.push(node.key);
	return parts.join(", ");
}
