/**
 * Canonical model-facing types for the DSH browser plugin.
 *
 * The browser is a **stateful** counterpart to the stateless `web_search`
 * (discovery) and `web_fetch` (one-shot read) tools: it keeps one
 * {@link BrowserSession} per agent session (keyed by the calling agent's
 * `SessionId`) and navigates it with `browser_open` / `browser_read` /
 * `browser_click` / `browser_back`.
 *
 * @module dsh-browser/types
 */

/** One link on the current page, addressable by a stable `id` in `browser_click`. */
export interface BrowserLink {
    /** Stable 1-based index rendered as a string; the `link_id` argument of `browser_click`. */
    id: string;
    /** Link anchor text (HTML stripped), or the URL when the anchor has no text. */
    text: string;
    /** Absolute URL (relative hrefs resolved against the page URL). */
    url: string;
}

/**
 * The structured view of one browsed page, produced by the plain-HTTP fetch
 * + HTML extraction pipeline (no browser engine, no JavaScript execution).
 */
export interface BrowserPage {
    /** Final URL after redirects. */
    url: string;
    /** Document title (`<title>`), empty when absent. */
    title: string;
    /** Rendered text (scripts/styles stripped), bounded by `maxTextChars`. */
    text: string;
    /** Links on the page, bounded by `maxLinks`; empty for non-HTML bodies. */
    links: BrowserLink[];
    /** HTTP status code of the final response (non-2xx is a result, not an error). */
    statusCode: number;
    /** True when the body or the extracted text/links were capped. */
    truncated: boolean;
    /** Always true — page content is EXTERNAL/UNTRUSTED data, never instructions. */
    untrusted: boolean;
}

/**
 * One agent session's browsing state: the current page plus the back/forward
 * history stacks of URLs visited around it (the page itself is not in either
 * stack).
 */
export interface BrowserSession {
    /** URL of the current page ('' before the first successful open). */
    currentUrl: string;
    /** The current page view, or null before the first successful open. */
    currentPage: BrowserPage | null;
    /** URLs visited before the current page, most recent last (the back stack). */
    history: string[];
    /** URLs the user went back from, for forward navigation, most recent last. */
    forwardHistory: string[];
}

/**
 * The model-facing view of a navigation outcome: the current page plus
 * session metadata the model needs to navigate further.
 */
export interface BrowserView {
    url: string;
    title: string;
    text: string;
    links: BrowserLink[];
    statusCode: number;
    truncated: boolean;
    /** Depth of the back-history stack (0 = cannot go back). */
    historySize: number;
    /** Depth of the forward-history stack (0 = cannot go forward). */
    forwardSize: number;
    /** Always true — the page content is EXTERNAL/UNTRUSTED data. */
    untrusted: boolean;
}

/** Options shared by the whole browser plugin. */
export interface BrowserServiceOptions {
    /** Cap on extracted page text characters (default 8000). */
    maxTextChars: number;
    /** Cap on extracted links per page (default 100). */
    maxLinks: number;
    /** Per-request cooperative timeout in ms (default 30000). */
    timeoutMs: number;
    /** Cap on the fetched body bytes (default 5 MiB). */
    maxBodyBytes: number;
    /** User-Agent sent with every request. */
    userAgent: string;
    /** Max wait duration for browser_wait (default 15000). */
    waitTimeoutMs?: number;
    /** Max retries for transient fetch errors (default 2). */
    maxRetries?: number;
    /** Permit loopback/private local stub hosts (tests/trusted downstream only). Default false. */
    allowLoopback?: boolean;
}
