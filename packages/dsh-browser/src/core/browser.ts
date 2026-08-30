/**
 * Stateful browsing service — V1.1 (Level 2).
 *
 * One {@link BrowserSession} per agent session (keyed by `SessionId`),
 * navigated via browser_open / read / click / back / forward / reload / wait.
 *
 * Navigation is plain HTTP through the **URL Security Gate** (SSRF, every
 * redirect hop) + wait/retry in {@link fetchResource}. All page content is
 * surfaced as **external/untrusted** (`untrusted: true` on the view) — the
 * model must never treat page text/title/links as instructions; it is data
 * from an untrusted source. Prompt-injection policy is NOT implemented here
 * (governance stays with Agent/Agent OS).
 *
 * @module dsh-browser/core/browser
 */
import { fetchResource, isHtmlContentType, type FetchResourceOptions } from './fetch.ts';
import { parseHtml } from './html.ts';
import type { BrowserPage, BrowserServiceOptions, BrowserSession, BrowserView } from '../types/browser.ts';
import { assertSafeHttpUrl, BrowserError, type BrowserErrorKind } from './security.ts';
/** Agent-session key: the calling agent's `SessionId`. */
function sessionKey(agentId: string | undefined): string {
    return agentId ?? 'default';
}

export class BrowserStateError extends Error {
    constructor(message: string) {
        super(`browser: ${message}`);
        this.name = 'BrowserStateError';
    }
}

/** Structure for a wait/waitFor result to the model. */
export interface BrowserWaitResult {
    readonly ok: boolean;
    readonly waitedMs: number;
    readonly reason: string;
}

export class BrowserService {
    private readonly sessions = new Map<string, BrowserSession>();
    private readonly fetchOptions: FetchResourceOptions;

    constructor(public readonly options: BrowserServiceOptions) {
        this.fetchOptions = {
            timeoutMs: options.timeoutMs,
            maxBodyBytes: options.maxBodyBytes,
            userAgent: options.userAgent,
            allowLoopback: options.allowLoopback ?? false,
        };
    }

    hasSession(agentId?: string): boolean {
        return this.sessions.get(sessionKey(agentId))?.currentPage != null;
    }

    private ensureSession(agentId?: string): BrowserSession {
        const key = sessionKey(agentId);
        let session = this.sessions.get(key);
        if (!session) {
            session = { currentUrl: '', currentPage: null, history: [], forwardHistory: [] };
            this.sessions.set(key, session);
        }
        return session;
    }

    private async navigate(session: BrowserSession, url: string, signal?: AbortSignal): Promise<BrowserView> {
        // URL Security Gate runs first (throws SSRF_BLOCKED / UNSUPPORTED_SCHEME / INVALID_URL).
        const safe = assertSafeHttpUrl(url, this.options.allowLoopback ?? false);
        const fetched = await fetchResource(safe, { ...this.fetchOptions, signal });
        const page = this.buildPage(fetched);
        session.currentUrl = page.url;
        session.currentPage = page;
        return this.toView(session);
    }

    private buildPage(fetched: Awaited<ReturnType<typeof fetchResource>>): BrowserPage {
        if (isHtmlContentType(fetched.contentType)) {
            const parsed = parseHtml(fetched.body, fetched.url, {
                maxTextChars: this.options.maxTextChars,
                maxLinks: this.options.maxLinks,
            });
            return {
                url: fetched.url,
                title: parsed.title,
                text: parsed.text,
                links: parsed.links.map((link, index) => ({ id: String(index + 1), text: link.text, url: link.href })),
                statusCode: fetched.statusCode,
                truncated: fetched.bodyTruncated || parsed.truncated,
                untrusted: true,
            };
        }
        const text = fetched.body.slice(0, this.options.maxTextChars);
        return {
            url: fetched.url,
            title: '',
            text,
            links: [],
            statusCode: fetched.statusCode,
            truncated: fetched.bodyTruncated || text.length > this.options.maxTextChars,
            untrusted: true,
        };
    }

    private toView(session: BrowserSession): BrowserView {
        const page = session.currentPage;
        if (!page) throw new BrowserStateError('no page is open; call browser_open first');
        return {
            url: page.url,
            title: page.title,
            text: page.text,
            links: page.links,
            statusCode: page.statusCode,
            truncated: page.truncated,
            historySize: session.history.length,
            forwardSize: session.forwardHistory.length,
            untrusted: page.untrusted,
        };
    }

    /** Open a URL; current page (if any) pushes onto back-history. */
    async open(agentId: string | undefined, url: string, signal?: AbortSignal): Promise<BrowserView> {
        const session = this.ensureSession(agentId);
        if (session.currentPage) session.history.push(session.currentUrl);
        session.forwardHistory = [];
        return this.navigate(session, url, signal);
    }

    read(agentId: string | undefined): BrowserView {
        return this.toView(this.ensureSession(agentId));
    }

    /**
     * Follow a target on the current page. Accepts:
     *  - an id (`link_id`, e.g. "3") from the page's links list
     *  - an `href` (absolute or relative URL)
     *  - link `text` (exact-ish anchor text)
     *  - `index` (0-based position in the links list)
     * Rejects unsafe click targets (`javascript:`, `data:`, `file:`, ...).
     */
    async click(
        agentId: string | undefined,
        target:
            | { linkId: string }
            | { href: string }
            | { index: number }
            | { text: string },
        signal?: AbortSignal,
    ): Promise<BrowserView> {
        const session = this.ensureSession(agentId);
        const page = session.currentPage;
        if (!page) throw new BrowserStateError('no page is open; call browser_open first');
        let url: string | undefined;
        if ('linkId' in target) {
            const link = page.links.find((candidate) => candidate.id === target.linkId);
            if (!link) throw new BrowserStateError(`link id "${target.linkId}" not found (${page.links.length} link(s) available)`);
            url = link.url;
        } else if ('href' in target) {
            url = target.href;
        } else if ('index' in target) {
            const link = page.links[target.index];
            if (link === undefined) throw new BrowserStateError(`no link at index ${target.index}`);
            url = link.url;
        } else {
            // text (case-insensitive contains; prefer exact, else first contains)
            const needle = target.text.toLowerCase();
            const byText = page.links.find((l) => l.text.toLowerCase() === needle)
                ?? page.links.find((l) => l.text.toLowerCase().includes(needle));
            if (byText === undefined) throw new BrowserStateError(`no link with text "${target.text}"`);
            url = byText.url;
        }
        // Reject unsafe click schemes explicitly.
        const scheme = (url.split(':')[0] ?? '').toLowerCase();
        if (scheme === 'javascript' || scheme === 'data' || scheme === 'file' || scheme === 'blob' || scheme === 'vbscript') {
            throw new BrowserError('UNSUPPORTED_SCHEME', `refusing click target scheme "${scheme}"`);
        }
        const absolute = new URL(url, page.url).toString();
        session.history.push(session.currentUrl);
        session.forwardHistory = [];
        return this.navigate(session, absolute, signal);
    }

    async back(agentId: string | undefined, signal?: AbortSignal): Promise<BrowserView> {
        const session = this.ensureSession(agentId);
        const previous = session.history.pop();
        if (previous === undefined) throw new BrowserStateError('no previous page in history');
        const cur = session.currentUrl;
        session.forwardHistory.push(cur);
        return this.navigate(session, previous, signal);
    }

    async forward(agentId: string | undefined, signal?: AbortSignal): Promise<BrowserView> {
        const session = this.ensureSession(agentId);
        const next = session.forwardHistory.pop();
        if (next === undefined) throw new BrowserStateError('no forward page in history');
        session.history.push(session.currentUrl);
        return this.navigate(session, next, signal);
    }

    async reload(agentId: string | undefined, signal?: AbortSignal): Promise<BrowserView> {
        const session = this.ensureSession(agentId);
        if (session.currentUrl === '') throw new BrowserStateError('no page to reload; call browser_open first');
        // Reload keeps the current URL; do not push history.
        return this.navigate(session, session.currentUrl, signal);
    }

    /**
     * Wait. Supports:
     *  - `ms`: sleep a fixed duration.
     *  - `until: 'text'` / `'title'` with `text:` — poll the current page (no
     *    refetch) until the substring appears, bounded by `maxWaitMs`.
     *  - `until: 'navigation'` with `url:` — poll until the session's URL
     *    contains/looks the target (a lightweight navigation wait).
     * timeout bounded by `options.waitTimeoutMs` (default 15000).
     */
    async wait(
        agentId: string | undefined,
        input: { ms?: number; until?: 'text' | 'title' | 'navigation'; text?: string; url?: string; maxWaitMs?: number },
        signal?: AbortSignal,
    ): Promise<BrowserWaitResult> {
        const session = this.ensureSession(agentId);
        if (input.ms !== undefined) {
            const limit = Math.min(input.ms ?? 0, this.options.waitTimeoutMs ?? 15000);
            await this.sleepOrAbort(limit, signal);
            return { ok: true, waitedMs: limit, reason: `waited ${limit}ms` };
        }
        const until = input.until ?? 'text';
        const page = session.currentPage;
        if (page === null) throw new BrowserStateError('no page is open; call browser_open first');
        const cap = this.options.waitTimeoutMs ?? 15000;
        const deadline = Date.now() + Math.min(input.maxWaitMs ?? cap, cap);
        const start = Date.now();
        for (;;) {
            const current = this.toView(session);
            if (until === 'text') {
                if (input.text !== undefined && current.text.includes(input.text)) {
                    return { ok: true, waitedMs: Date.now() - start, reason: `found text "${input.text}"` };
                }
            } else if (until === 'title') {
                if (input.text !== undefined && current.title.includes(input.text)) {
                    return { ok: true, waitedMs: Date.now() - start, reason: `found title "${input.text}"` };
                }
            } else if (until === 'navigation') {
                if (input.url !== undefined && (current.url === input.url || current.url.includes(input.url))) {
                    return { ok: true, waitedMs: Date.now() - start, reason: `navigated to ${current.url}` };
                }
            }
            if (Date.now() >= deadline) {
                return { ok: false, waitedMs: Date.now() - start, reason: `timed out after ${this.options.waitTimeoutMs}ms waiting` };
            }
            await this.sleepOrAbort(200, signal);
        }
    }

    private sleepOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
        return new Promise((resolve) => {
            const timer = setTimeout(resolve, ms);
            signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
        });
    }

    dispose(agentId?: string): void {
        if (agentId === undefined) {
            this.sessions.clear();
            return;
        }
        this.sessions.delete(sessionKey(agentId));
    }
}
