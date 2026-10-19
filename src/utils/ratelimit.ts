/**
 * Utility: the daily record of exit IPs opencode has rate limited.
 *
 * A 429 means the *exit IP* has burned its quota, not the node that carried
 * the request, and opencode keeps answering 429 for that IP for the rest of
 * the day. So when the pool switches away from a limited node it must not
 * switch onto an IP it already burned, which means the fact has to outlive
 * the request that discovered it.
 *
 * The record is one small JSON file rather than a database or a new
 * dependency: the whole state is a handful of `key -> timestamp` pairs, and
 * the proxy is meant to be a single binary dropped next to a .env.
 *
 * A "day" starts at the reset hour (08:00 by default) rather than midnight:
 * an entry recorded before the current day's boundary is stale the first time
 * the ledger is touched after it. Nothing has to fire at 08:00 for the reset
 * to happen — a process that was asleep, restarted, or blocked simply drops
 * the stale entries on its next read.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** What is known about one limited key. */
export interface RateLimitEntry {
	/** ISO timestamp of the 429 that put the key here. */
	at: string;
	/** Node tag that carried the request, for the logs and the JSON file. */
	tag?: string;
	/** Human-readable node name, so the file is readable without the API. */
	name?: string;
	/** The exit IP itself, which is what "rate-limited IP" refers to. */
	ip?: string;
	/** Why the key was recorded. Only "rate-limited" is persisted today. */
	reason: string;
}

/** On-disk shape. Kept versioned so a future change can migrate it. */
export interface RateLimitState {
	version: number;
	entries: Record<string, RateLimitEntry>;
}

const STATE_VERSION = 1;

/**
 * Start of the "day" that `now` belongs to, as an epoch timestamp.
 *
 * Before the reset hour the current day is still yesterday's: at 07:00 on the
 * 17th, a 429 recorded at 09:00 on the 16th belongs to the current record and
 * stays. At 08:00 on the 17th the boundary moves and that entry is stale.
 * Built through the Date constructor (not by subtracting 24h) so month ends
 * and DST shifts land on the right local hour.
 */
export function quotaDayStart(now: number, resetHour: number): number {
	const at = new Date(now);
	const today = new Date(
		at.getFullYear(),
		at.getMonth(),
		at.getDate(),
		resetHour,
		0,
		0,
		0,
	).getTime();
	if (now >= today) return today;
	return new Date(
		at.getFullYear(),
		at.getMonth(),
		at.getDate() - 1,
		resetHour,
		0,
		0,
		0,
	).getTime();
}

/**
 * The nodes limited in the current day.
 *
 * Entries are filed under the node's identity in the pool's control plane
 * and carry the exit IP that was limited, so the same exit is recognised
 * both when that node comes back and when it returns under a new id, or as
 * another node dialling the same IP (`hasIp`).
 */
export class RateLimitLedger {
	private entries = new Map<string, RateLimitEntry>();

	constructor(
		private readonly path: string,
		private readonly resetHour: number,
		private readonly now: () => number = Date.now,
	) {}

	/** Reads the file if it exists; a missing or corrupt file starts empty. */
	load(): void {
		let parsed: Partial<RateLimitState>;
		try {
			parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<RateLimitState>;
		} catch {
			// No state yet (first run) or unreadable/corrupt state: an empty
			// ledger is always safe, it only costs a possible extra 429.
			this.entries = new Map();
			return;
		}
		const entries = new Map<string, RateLimitEntry>();
		for (const [key, entry] of Object.entries(parsed.entries ?? {})) {
			if (entry && typeof entry.at === "string") entries.set(key, entry);
		}
		this.entries = entries;
		this.prune();
	}

	/** Number of keys still limited (after pruning). */
	get size(): number {
		this.prune();
		return this.entries.size;
	}

	/** Whether `key` was rate limited in the current day. */
	has(key: string): boolean {
		this.prune();
		return this.entries.has(key);
	}

	/**
	 * Whether this exit IP is recorded today, whatever node it was filed
	 * under. Two nodes behind the same IP are one exit, so the second must
	 * not be used either.
	 */
	hasIp(ip: string | undefined): boolean {
		if (!ip) return false;
		this.prune();
		for (const entry of this.entries.values()) if (entry.ip === ip) return true;
		return false;
	}

	/** Keys limited in the current day, for logs and `GET /`. */
	keys(): string[] {
		this.prune();
		return [...this.entries.keys()];
	}

	/**
	 * Records a key. Returns false when it was already recorded today, so a
	 * caller can keep the "switched" signal honest on repeated 429s.
	 */
	mark(
		key: string,
		meta: { tag?: string; name?: string; ip?: string; reason: string },
	): boolean {
		this.prune();
		if (this.entries.has(key)) return false;
		this.entries.set(key, {
			at: new Date(this.now()).toISOString(),
			tag: meta.tag,
			name: meta.name,
			ip: meta.ip,
			reason: meta.reason,
		});
		this.save();
		return true;
	}

	/**
	 * Drops entries older than the current day's start. Returns true when
	 * anything was dropped, so the caller can persist the cleared file.
	 */
	prune(): boolean {
		const start = quotaDayStart(this.now(), this.resetHour);
		let dropped = false;
		for (const [key, entry] of this.entries) {
			const at = Date.parse(entry.at);
			if (Number.isNaN(at) || at < start) {
				this.entries.delete(key);
				dropped = true;
			}
		}
		if (dropped) this.save();
		return dropped;
	}

	/** Writes the ledger; a write failure never breaks an in-flight request. */
	save(): void {
		const state: RateLimitState = {
			version: STATE_VERSION,
			entries: Object.fromEntries(this.entries),
		};
		try {
			mkdirSync(dirname(this.path), { recursive: true });
			writeFileSync(this.path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
		} catch (error) {
			// Read-only container filesystem, unwritable cwd, ...: the ledger
			// still works for this process, it just does not survive a restart.
			console.warn(
				`[rate-limit] could not write ${this.path}: ${(error as Error).message}`,
			);
		}
	}
}
