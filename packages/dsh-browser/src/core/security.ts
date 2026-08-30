/**
 * DSH Browser Plugin — URL Security Gate (SSRF prevention, fail-closed).
 *
 * Every navigation URL (open / click / forward / reload and each redirect
 * hop) runs through {@link assertSafeHttpUrl}. Policy:
 * - schemes allowed: `http`, `https`; everything else (`file:`, `javascript:`,
 *   `data:`, `blob:`, `ftp:`, ...) rejected.
 * - hosts rejected (fail-closed): localhost, loopback (`127.0.0.0/8`),
 *   `0.0.0.0`, `::1/::`, RFC1918 private (`10/8`, `172.16/12`, `192.168/16`),
 *   link-local (`169.254/16`, `fe80::/10`), IPv4-mapped IPv6, and common
 *   cloud metadata endpoints (e.g. `169.254.169.254`).
 * - `file://`, embedded credentials, malformed URLs, non-http(s) rejected.
 *
 * NOTE: this is a best-effort static gate. Defense in depth against DNS
 * rebinding (resolving a hostname that later resolves to a private address)
 * requires a real fetch client that re-validates the post-resolution address;
 * the plugin's plain `fetch` cannot pin a resolved IP, so this gate blocks
 * the well-known literal/private hosts and is applied on EVERY redirect hop
 * (the redirect target is validated before following).
 *
 * @module dsh-browser/core/security
 */

/** Stable, caller-parseable error classification (not just strings). */
export type BrowserErrorKind =
    | 'INVALID_URL'
    | 'UNSUPPORTED_SCHEME'
    | 'SSRF_BLOCKED'
    | 'NETWORK_ERROR'
    | 'TIMEOUT'
    | 'HTTP_ERROR'
    | 'REDIRECT_BLOCKED'
    | 'RATE_LIMITED'
    | 'PARSE_ERROR'
    | 'NOT_FOUND';

/** Typed browser error for stable programmatic handling. */
export class BrowserError extends Error {
    readonly kind: BrowserErrorKind;
    readonly status?: number;
    readonly retryAfterMs?: number;
    constructor(kind: BrowserErrorKind, message: string, opts: { status?: number; retryAfterMs?: number } = {}) {
        super(`browser: [${kind}] ${message}`);
        this.name = 'BrowserError';
        this.kind = kind;
        this.status = opts.status;
        this.retryAfterMs = opts.retryAfterMs;
    }
}

/** Express the browser error as an object the model can read without string parsing. */
export interface BrowserErrorView {
    readonly kind: BrowserErrorKind;
    readonly ok: false;
    readonly message: string;
    readonly status?: number;
    readonly retryAfterMs?: number;
}

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

/** Well-known forwarded/private host literals (lowercased, without port/brackets). */
const BLOCKED_HOSTS = new Set([
    'localhost',
    'localhost.localdomain',
    '0.0.0.0',
    'metadata.google.internal',
    'metadata',
    'kubernetes.default.svc',
]);

/**
 * Resolve the hostname of an IPv4 string to reject private/loopback/link-local
 * ranges. Returns true when the IPv4 is private/loopback/link-local/metadata.
 */
function isBlockedIpv4(host: string): boolean {
    // Extract the IP (host may be bare IP or domain; only IP literals checked here).
    const parts = host.split('.');
    if (parts.length !== 4) return false;
    const octets = parts.map((p) => {
        if (!/^\d{1,3}$/.test(p)) return NaN;
        const n = Number(p);
        return n >= 0 && n <= 255 ? n : NaN;
    });
    if (octets.some((o) => Number.isNaN(o))) return false;
    const a = octets[0];
    const b = octets[1];
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
    return false;
}

/** Resolve an IPv6 literal (may carry zone `%` and brackets) to reject loopback/link-local/mapped. */
function isBlockedIpv6(host: string): boolean {
    let h = host;
    if (h.startsWith('[')) h = h.slice(1, h.indexOf(']') === -1 ? h.length : h.indexOf(']'));
    // strip zone id (fe80::1%eth0)
    const zone = h.indexOf('%');
    if (zone !== -1) h = h.slice(0, zone);
    const lower = h.toLowerCase();
    // loopback ::1 and ::
    if (lower === '::1' || lower === '::') return true;
    // link-local fe80::/10
    if (lower.startsWith('fe80') || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true;
    // IPv4-mapped IPv6 ::ffff:a.b.c.d
    const mapped = lower.match(/^::ffff:(.+)$/);
    if (mapped !== null && mapped[1] !== undefined) return isBlockedIpv4(mapped[1]);
    return false;
}

/**
 * Validate a URL and assert it is a safe HTTP(S) URL that does not target a
 * blocked host. Throws a typed {@link BrowserError} with classification.
 *
 * When `allowLoopback` is true, loopback/private hosts used by the LOCAL stub
 * server are permitted (intended for tests/trusted downstream only). All other
 * blocked hosts (metadata, link-local, private ranges) remain denied.
 * @returns the normalized URL (stripped of embedded credentials).
 */
export function assertSafeHttpUrl(rawUrl: string, allowLoopback = false): string {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new BrowserError('INVALID_URL', 'malformed URL');
    }
    if (!ALLOWED_SCHEMES.has(url.protocol)) {
        throw new BrowserError('UNSUPPORTED_SCHEME', `scheme ${url.protocol} is not allowed`);
    }
    if (url.username !== '' || url.password !== '') {
        throw new BrowserError('SSRF_BLOCKED', 'URL with embedded credentials is not allowed');
    }
    const host = url.hostname.toLowerCase();
    const isLoopbackLiteral = host === '127.0.0.1' || host === '::1' || host === 'localhost' || host === '0.0.0.0';
    if (allowLoopback && isLoopbackLiteral) return url.toString();
    if (BLOCKED_HOSTS.has(host)) {
        throw new BrowserError('SSRF_BLOCKED', `host "${host}" is not allowed`);
    }
    const hasColon = host.includes(':');
    const blocked = hasColon || /^[0-9.]+$/.test(host)
        ? (hasColon ? isBlockedIpv6(host) : isBlockedIpv4(host))
        : false;
    if (blocked) {
        throw new BrowserError('SSRF_BLOCKED', `IP target "${host}" is not allowed`);
    }
    url.username = '';
    url.password = '';
    return url.toString();
}

/** Whether the URL is a plain language `javascript:` / `data:` / `file:` target (for click-target guards). */
export function isUnsafeClickScheme(rawUrl: string): boolean {
    const scheme = rawUrl.split(':')[0]?.toLowerCase() ?? '';
    return scheme === 'javascript' || scheme === 'data' || scheme === 'file' || scheme === 'blob' || scheme === 'vbscript';
}

/** Map an HTTP status to a {@link BrowserErrorKind}. */
export function statusToErrorKind(status: number): BrowserErrorKind {
    if (status === 404) return 'NOT_FOUND';
    if (status === 429) return 'RATE_LIMITED';
    if (status >= 500) return 'HTTP_ERROR';
    if (status >= 400) return 'HTTP_ERROR';
    return 'HTTP_ERROR';
}
