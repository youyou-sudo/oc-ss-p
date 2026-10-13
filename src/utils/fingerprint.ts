/**
 * Utility: per-conversation client fingerprints.
 *
 * Every user behind one proxy previously shared the same three signals:
 * a constant session prefix, a constant user-agent, and a constant client
 * tag. That is a far stronger "this is an automated cluster" signal than a
 * single shared exit IP, so each signal is derived per conversation
 * instead of being hard-coded.
 */

/** Plausible OpenCode CLI versions. Kept close to real releases. */
export const CLIENT_VERSIONS = [
	"2.0.23",
	"2.0.22",
	"2.0.21",
	"2.0.19",
	"2.0.17",
] as const;

/** Client tags OpenCode sends in `x-opencode-client`. */
export const CLIENT_TAGS = ["cli", "cli", "cli", "server", "desktop"] as const;

/** Platform-ish suffixes seen on OpenCode's other transports. */
const CLIENT_FLAVOURS = ["", "", "", "-darwin", "-linux"] as const;

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
	const flavour =
		CLIENT_FLAVOURS[bucket(`flav:${seed}`, CLIENT_FLAVOURS.length)];

	return {
		// Reuse the same hash primitive as the session suffix so the two
		// stay internally consistent without a second hashing scheme.
		sessionSuffix: suffixFromSeed(`fp:${seed}`),
		userAgent: `opencode/latest/${version}/cli${flavour}`,
		client,
	};
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

// 48 bits of budget in the 12 hex chars: 6 for the counter, 42 for the clock.
const COUNTER_SHIFT = 6n;
const TS_MASK = (1n << 42n) - 1n;

/**
 * Mints a session prefix whose counter is always a legal 1..63.
 *
 * The upstream format is `ses_ + 12 hex`, where the value is roughly
 * `Date.now() * 4096 + counter`. That product needs 53 bits and cannot fit
 * in 12 hex (48 bits), so the timestamp is kept to its low 42 bits and the
 * counter occupies the low 6. BigInt is required: 48 bits exceeds the
 * 32-bit range of Number bitwise operators.
 */
export function sessionPrefixFor(counter: number): string {
	const clamped = Math.min(63, Math.max(1, Math.trunc(counter)));
	const clock = BigInt(Date.now()) & TS_MASK;
	const value = (clock << COUNTER_SHIFT) + BigInt(clamped);
	return "ses_" + value.toString(16).padStart(12, "0");
}

export const MAX_COUNTER = 63;
export const MIN_COUNTER = 1;

