/**
 * Utility: per-conversation client fingerprints.
 *
 * Every conversation behind one proxy used to share the same three signals:
 * a constant session prefix, a constant user-agent and a constant client
 * tag. That is a far stronger "this is an automated cluster" signal than a
 * single shared exit IP, so each signal is derived per conversation instead
 * of being hard-coded.
 *
 * OpenCode spells one identity across two headers, and the two have to
 * agree (`packages/core/src/app.ts` `useragent()` and
 * `packages/core/src/session/model-request.ts` in anomalyco/opencode):
 *
 *     user-agent:        opencode/<channel>/<version>/<name>
 *     x-opencode-client: <name>
 *
 * Deriving the two independently is what produced impossible pairs such as
 * `opencode/latest/2.0.22/cli-darwin` next to `x-opencode-client: desktop`
 * — OpenCode never appends a platform suffix to the app name.
 */

/** Recent OpenCode releases; an old version is a staleness signal of its own. */
export const CLIENT_VERSIONS = [
	"1.19.0",
	"1.18.1",
	"1.18.0",
] as const;

/**
 * OpenCode's own user-agent tail (1.19.0, captured from the real client):
 * Zen's free tier turns away anything older than 1.18.0 with 426, and the
 * gateway reads the ai-sdk and runtime segments too.
 */
export const CLIENT_AGENT_TAIL =
	"ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14" as const;

/** App names OpenCode reports in `x-opencode-client` and in the UA tail. */
export const CLIENT_TAGS = ["cli", "cli", "cli", "cli", "desktop"] as const;

const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Stable 0..n-1 bucket for a seed, so the same conversation keeps its fp. */
function bucket(seed: string, length: number): number {
	const digest = new Bun.CryptoHasher("sha256").update(seed).digest();
	// Use 8 bytes -> BigInt so we stay well inside the safe integer range.
	let n = 0n;
	for (const byte of digest.subarray(0, 8)) n = (n << 8n) | BigInt(byte);
	return Number(n % BigInt(length));
}

export interface Fingerprint {
	/** 14 base62 chars appended to the session prefix. */
	sessionSuffix: string;
	/** Version segment of the user-agent. */
	version: string;
	/** Value for `user-agent`. */
	userAgent: string;
	/** Value for `x-opencode-client`. */
	client: string;
}

/**
 * Derives a stable fingerprint for a conversation seed. The same seed
 * always yields the same fingerprint, so a conversation keeps one identity
 * across turns while different conversations look unrelated.
 */
export function fingerprintFor(seed: string): Fingerprint {
	const version = CLIENT_VERSIONS[bucket(`ver:${seed}`, CLIENT_VERSIONS.length)];
	const client = CLIENT_TAGS[bucket(`cli:${seed}`, CLIENT_TAGS.length)];

	return {
		// Reuse the same hash primitive as the session suffix so the two
		// stay internally consistent without a second hashing scheme.
		sessionSuffix: suffixFromSeed(`fp:${seed}`),
		version,
		userAgent: userAgentFor(version, client),
		client,
	};
}

/**
 * Builds the user-agent OpenCode pairs with `x-opencode-client: <client>`.
 * The real client spells it `opencode/<version> <ai-sdk tail>`, so the
 * version carries the app name the way OpenCode 1.19.0 sends it.
 */
export function userAgentFor(version: string, client: string): string {
	return `opencode/${version}/${client} ${CLIENT_AGENT_TAIL}`;
}

/**
 * Reads the app name back out of an OpenCode user-agent, so a pinned or
 * pass-through user-agent still yields an `x-opencode-client` that matches
 * it. Returns undefined for anything that is not an OpenCode user-agent.
 */
export function clientFromUserAgent(
	userAgent: string | null | undefined,
): string | undefined {
	const match = /^opencode\/[^/\s]+\/([^/\s]+)/.exec(
		(userAgent ?? "").trim(),
	);
	return match?.[1];
}

/**
 * Project ids are client-owned: a git root commit, `host/path`, or
 * `"global"`. A stable 40-hex value keeps the header present in a shape
 * OpenCode already sends instead of inventing a new one.
 */
export function projectFor(seed: string): string {
	return Array.from(new Bun.CryptoHasher("sha256").update(`prj:${seed}`).digest())
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("")
		.slice(0, 40);
}

/**
 * 14 base62 chars from a seed: 62^14 > 2^83, so 10 hash bytes are plenty.
 */
function suffixFromSeed(seed: string): string {
	const digest = new Bun.CryptoHasher("sha256").update(seed).digest();
	let n = 0n;
	for (const byte of digest.subarray(0, 10)) n = (n << 8n) | BigInt(byte);
	let out = "";
	for (let i = 0; i < 14; i++) {
		out = B62[Number(n % 62n)] + out;
		n /= 62n;
	}
	return out;
}

const MASK_48 = (1n << 48n) - 1n;

/**
 * Mints a session prefix exactly the way OpenCode does.
 *
 * `packages/schema/src/identifier.ts` builds every id as
 *
 *     current = Date.now() * 4096 + counter      (counter: per-ms increment)
 *     value   = ~current                         (descending: newest first)
 *
 * and prints the low 48 bits of `value` as 12 hex chars. Two consequences
 * matter here:
 *
 * - The id is the *complement* of the clock. Writing the clock straight into
 *   the hex (what this proxy used to do) mints ids whose bits are inverted:
 *   decoding one yields the counter `4096 - counter` and a clock years away
 *   from now, which a gateway that decodes the prefix to check the session
 *   rejects.
 * - Only the low 48 bits survive, so a decoded id carries
 *   `Date.now() mod 2^36` — a rolling window of roughly 795 days.
 *
 * BigInt is required: 48 bits exceeds the 32-bit range of Number bitwise
 * operators.
 */
export function sessionPrefixFor(counter: number, now = Date.now()): string {
	const clamped = Math.min(
		MAX_COUNTER,
		Math.max(MIN_COUNTER, Math.trunc(counter)),
	);
	const value = ~(BigInt(now) * 0x1000n + BigInt(clamped));
	return "ses_" + (value & MASK_48).toString(16).padStart(12, "0");
}

/** The counter occupies 12 bits: the per-millisecond id increment. */
export const MAX_COUNTER = 4095;
export const MIN_COUNTER = 1;