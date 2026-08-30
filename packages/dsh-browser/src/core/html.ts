/**
 * Minimal structured HTML extraction for the browser plugin: document title,
 * rendered text, and absolute links. Deliberately NOT a general HTML parser —
 * it implements only the three projections the browser needs.
 *
 * Reuse note: the runtime's only HTML machinery is `turndown` (+ its bundled
 * `@mixmark-io/domino`) inside `@deepseek-ai/dsh-tool-web`, which is a private
 * dependency that is never exported and a *converter* (HTML → markdown), not a
 * structured extractor; it also cannot be installed as a dependency in this
 * deployment (no registry access). This module therefore implements the small,
 * testable extraction surface itself and reuses the Node standard `URL` class
 * for relative-URL resolution (the same primitive any resolver would use).
 *
 * @module dsh-browser/core/html
 */

/** Raw link candidate extracted from an `<a>` element before resolution. */
export interface RawLink {
    /** href attribute value, as written in the document. */
    href: string;
    /** Anchor inner text with tags stripped (may be empty). */
    text: string;
}

/** Extraction bounds. */
export interface HtmlExtractOptions {
    /** Cap on the returned `text` length in characters. */
    maxTextChars: number;
    /** Cap on the number of returned links. */
    maxLinks: number;
}

/** Structured extraction outcome. */
export interface HtmlExtractResult {
    title: string;
    text: string;
    links: RawLink[];
    /** True when text or links hit their cap. */
    truncated: boolean;
}

/** Elements whose bodies never contribute text. */
const SKIP_CONTENT_RE = /<(script|style|noscript|template|head|svg|iframe|object)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
/** Elements whose start tag forces a line break (block layout). */
const BLOCK_START_RE = /<(address|article|aside|blockquote|br|dd|div|dl|dt|figcaption|figure|footer|form|h1|h2|h3|h4|h5|h6|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)\b[^>]*>/gi;
/** Elements whose end tag forces a line break (block close). */
const BLOCK_END_RE = /<\/(address|article|aside|blockquote|dd|div|dl|dt|figcaption|figure|footer|form|h1|h2|h3|h4|h5|h6|header|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)\s*>/gi;
/** Any remaining tag. */
const TAG_RE = /<[^>]*>/g;
/** `<a ...>` elements (attributes captured for href parsing). */
const ANCHOR_RE = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
/** The `href` attribute inside an anchor's opening tag. */
const HREF_RE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

/** Minimal named HTML entities. Numeric entities are decoded separately. */
const NAMED_ENTITIES: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    copy: '©',
    reg: '®',
    hellip: '…',
    mdash: '—',
    ndash: '–',
    lsquo: '‘',
    rsquo: '’',
    ldquo: '“',
    rdquo: '”',
    middot: '·',
};

/** Decode named and numeric HTML entities in `input`. */
export function decodeEntities(input: string): string {
    return input.replace(/&(#x[\da-fA-F]+|#\d+|[\w]+);/g, (match, body: string) => {
        if (body.startsWith('#x')) {
            const code = Number.parseInt(body.slice(2), 16);
            return Number.isFinite(code) ? String.fromCodePoint(code) : match;
        }
        if (body.startsWith('#')) {
            const code = Number.parseInt(body.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : match;
        }
        return NAMED_ENTITIES[body] ?? match;
    });
}

/** Strip tags and normalize whitespace; block elements become line breaks. */
export function htmlToText(html: string): string {
    let out = html
        .replace(SKIP_CONTENT_RE, '')
        .replace(BLOCK_START_RE, '\n')
        .replace(BLOCK_END_RE, '\n')
        .replace(TAG_RE, '')
        .replace(/[ \t\f\v]+/g, ' ');
    out = decodeEntities(out);
    const lines = out
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    return lines.join('\n');
}

/** Extract the document title: `<title>` content, tags stripped. */
export function extractTitle(html: string): string {
    const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
    if (!match) return '';
    const title = match[1] ?? ''
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return decodeEntities(title);
}

/** Whether a resolved URL is worth exposing as a navigable link. */
function isNavigableUrl(url: URL, href: string): boolean {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    // Pure fragment anchors (#frag) cannot drive `browser_click` navigation.
    if (href.trim().startsWith('#')) return false;
    return true;
}

/** Extract anchor links, resolving relative hrefs against `baseUrl`. */
export function extractLinks(html: string, baseUrl: string, maxLinks: number): RawLink[] {
    const seen = new Set<string>();
    const links: RawLink[] = [];
    let match: RegExpExecArray | null;
    const re = new RegExp(ANCHOR_RE.source, 'gi');
    while ((match = re.exec(html)) !== null) {
        const attrs = match[1] ?? '';
        const inner = match[2] ?? '';
        const hrefMatch = HREF_RE.exec(attrs);
        if (!hrefMatch) continue;
        const href = (hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? '').trim();
        if (href.length === 0) continue;
        let resolved: URL;
        try {
            resolved = new URL(href, baseUrl);
        } catch {
            continue;
        }
        if (!isNavigableUrl(resolved, href)) continue;
        const absolute = resolved.href;
        if (seen.has(absolute)) continue;
        seen.add(absolute);
        const text = htmlToText(inner).trim() || href;
        links.push({ href: absolute, text });
        if (links.length >= maxLinks) break;
    }
    return links;
}

/**
 * Run the full extraction pipeline over an HTML body.
 *
 * @param html - the decoded HTML body.
 * @param baseUrl - base URL for relative link resolution (the final page URL).
 * @param options - text/link caps.
 * @returns the structured extraction.
 */
export function parseHtml(html: string, baseUrl: string, options: HtmlExtractOptions): HtmlExtractResult {
    const title = extractTitle(html);
    const text = htmlToText(html);
    const links = extractLinks(html, baseUrl, options.maxLinks);
    const textTruncated = text.length > options.maxTextChars;
    const linksTruncated = links.length >= options.maxLinks;
    return {
        title,
        text: textTruncated ? `${text.slice(0, options.maxTextChars)}…` : text,
        links,
        truncated: textTruncated || linksTruncated,
    };
}
