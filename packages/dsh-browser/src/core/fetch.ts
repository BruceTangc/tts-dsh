/**
 * Plain-HTTP retrieval for the browser plugin, hardened for V1.1.
 *
 * - Redirects are followed MANUALLY (up to `maxRedirects`) so that EVERY hop
 *   passes through the {@link assertSafeHttpUrl} SSRF gate (prevents
 *   redirect→localhost / redirect→private / redirect→metadata).
 * - Retry policy: transient network/timeout/5xx may be retried up to
 *   `maxRetries`; 429 honors `Retry-After` or a bounded backoff; 4xx are NOT
 *   blindly retried. No infinite retries.
 * - Stable error classification via {@link BrowserError}.
 *
 * @module dsh-browser/core/fetch
 */
import { isUnsafeClickScheme, statusToErrorKind, assertSafeHttpUrl, BrowserError, type BrowserErrorKind, type BrowserErrorView } from './security.ts';

export interface FetchedResource {
    readonly url: string;
    readonly statusCode: number;
    readonly contentType: string;
    readonly body: string;
    readonly bodyTruncated: boolean;
    /** Final status after following redirect hops (not a redirect). */
    readonly final: boolean;
}

export interface FetchResourceOptions {
    readonly timeoutMs: number;
    readonly maxBodyBytes: number;
    readonly userAgent: string;
    readonly signal?: AbortSignal;
    /** Max redirect hops (per-request). Default 10. */
    readonly maxRedirects?: number;
    /** Max retries for transient errors (network/timeout/5xx). Default 2. */
    readonly maxRetries?: number;
    /** Base backoff ms between retries (jittered). Default 250. */
    readonly retryBaseMs?: number;
    /** Whether a 429 should be retried (yes by default, honoring Retry-After). */
    readonly retryOnRateLimit?: boolean;
    /** Permit loopback/private local stub hosts (tests/trusted downstream only). Default false. */
    readonly allowLoopback?: boolean;
}

export const DEFAULT_USER_AGENT =
    'Mozilla/5.0 (compatible; DSH-Browser/0.1; +https://github.com/deepseek-ai/DeepSeek-Harness)';

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
    });
}

async function readBodyCapped(response: Response, maxBodyBytes: number): Promise<{ text: string; truncated: boolean }> {
    if (!response.body) return { text: '', truncated: false };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (total + value.length > maxBodyBytes) {
                chunks.push(value.subarray(0, maxBodyBytes - total));
                truncated = true;
                break;
            }
            chunks.push(value);
            total += value.length;
        }
    } finally {
        reader.releaseLock();
    }
    return { text: Buffer.concat(chunks).toString('utf8'), truncated };
}

function retryAfterMs(response: Response): number | undefined {
    const header = response.headers.get('retry-after');
    if (header === undefined || header === null) return undefined;
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    // HTTP-date form is rare; ignore for the fallback backoff.
    return undefined;
}

/** One raw fetch with local abort + timeout, throwing typed BrowserError on network/timeout. */
async function rawFetch(url: string, options: FetchResourceOptions, signal: AbortSignal | undefined, didTimeoutRef: { timedOut: boolean }): Promise<Response> {
    const controller = new AbortController();
    const forward = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', forward, { once: true });
    const timer = setTimeout(() => {
        didTimeoutRef.timedOut = true;
        controller.abort(new BrowserError('TIMEOUT', `request timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    try {
        return await fetch(url, {
            redirect: 'manual', // manual so we re-validate each hop
            signal: controller.signal,
            headers: {
                'user-agent': options.userAgent,
                accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
                'accept-language': 'en,zh-CN;q=0.8',
            },
        });
    } catch (error) {
        if (didTimeoutRef.timedOut) {
            throw new BrowserError('TIMEOUT', `request timed out after ${options.timeoutMs}ms`);
        }
        if (signal?.aborted) {
            // Cooperative cancellation by the agent/tool layer: propagate as an abort.
            throw error;
        }
        throw new BrowserError('NETWORK_ERROR', `network error: ${String(error)}`);
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', forward);
    }
}

export async function fetchResource(url: string, options: FetchResourceOptions): Promise<FetchedResource> {
    const maxRedirects = options.maxRedirects ?? 10;
    const maxRetries = options.maxRetries ?? 2;
    const retryBaseMs = options.retryBaseMs ?? 250;
    const retryOnRateLimit = options.retryOnRateLimit ?? true;
    let current = assertSafeHttpUrl(url, options.allowLoopback); // first URL gate
    let hops = 0;
    outer:
    for (;;) {
        const attempts = maxRetries + 1;
        let lastError: unknown;
        for (let attempt = 0; attempt < attempts; attempt += 1) {
            if (hops > 0) current = assertSafeHttpUrl(current, options.allowLoopback); // re-gate hop
            try {
                const response = await rawFetch(current, options, options.signal, { timedOut: false });
                const status = response.status;

                // Redirect: validate the Location target through the SSRF gate before following.
                if (status >= 300 && status < 400 && status !== 304 && status !== 305) {
                    const location = response.headers.get('location');
                    // Release the redirect body (if any) so the connection can be reused.
                    const bodyCancel = response.body?.cancel?.();
                    if (bodyCancel instanceof Promise) await bodyCancel.catch(() => {});
                    if (location === null || location === undefined || location === '') {
                        return {
                            url: current,
                            statusCode: status,
                            contentType: response.headers.get('content-type') ?? '',
                            body: '',
                            bodyTruncated: false,
                            final: true,
                        };
                    }
                    if (hops >= maxRedirects) {
                        throw new BrowserError('REDIRECT_BLOCKED', `too many redirects (limit ${maxRedirects})`);
                    }
                    let next: string;
                    try {
                        next = new URL(location, current).toString();
                    } catch {
                        throw new BrowserError('INVALID_URL', `invalid redirect Location "${location}"`);
                    }
                    // SSRF gate on the redirect target BEFORE hopping (same
                    // allowLoopback so same-host relative redirects work; private /
                    // link-local / metadata are always denied by the gate).
                    assertSafeHttpUrl(next, options.allowLoopback);
                    current = next;
                    hops += 1;
                    continue outer; // perform the next hop immediately, no retry of a 3xx
                }

                // Final response: retry transient status / 429, else return.
                const retryable = (status === 429 && retryOnRateLimit)
                    || (status >= 500 && status < 600 && attempt < maxRetries);
                if (retryable && attempt < attempts - 1) {
                    const wait = status === 429 ? (retryAfterMs(response) ?? retryBaseMs * 2 ** attempt)
                        : retryBaseMs * 2 ** attempt;
                    await sleep(wait, options.signal);
                    lastError = new BrowserError(status === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR', `retrying after ${status} (attempt ${attempt + 1})`);
                    continue;
                }
                const body = await readBodyCapped(response, options.maxBodyBytes);
                return {
                    url: current,
                    statusCode: status,
                    contentType: response.headers.get('content-type') ?? '',
                    body: body.text,
                    bodyTruncated: body.truncated,
                    final: true,
                };
            } catch (error) {
                if (error instanceof BrowserError && options.signal?.aborted) throw error;
                const retryableErr = error instanceof BrowserError
                    && (error.kind === 'NETWORK_ERROR' || error.kind === 'TIMEOUT')
                    && attempt < maxRetries;
                if (retryableErr) {
                    const wait = retryBaseMs * 2 ** attempt;
                    await sleep(wait, options.signal);
                    lastError = error;
                    continue;
                }
                throw error;
            }
        }
        // Should not reach here in normal flow (each iteration returns/continue/throws);
        // guard against an infinite loop.
        throw new BrowserError('NETWORK_ERROR', `request failed after retries: ${lastError === undefined ? 'no error recorded' : String(lastError)}`);
    }
}

export { isUnsafeClickScheme, statusToErrorKind, assertSafeHttpUrl, BrowserError } from './security.ts';
export type { BrowserErrorKind, BrowserErrorView } from './security.ts';

/** Whether a Content-Type header denotes an HTML document. */
export function isHtmlContentType(contentType: string): boolean {
    const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
    return type === 'text/html' || type === 'application/xhtml+xml';
}
