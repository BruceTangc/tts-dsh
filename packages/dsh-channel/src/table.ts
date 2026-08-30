/**
 * Feishu card table helpers — parse markdown table blocks out of assistant
 * text and render them with the official Feishu `table` component (JSON 2.0).
 *
 * Markdown tables are NOT supported in Feishu card text, but the card JSON 2.0
 * structure ships a native `table` component. Limits (Feishu docs):
 *   - at most 5 `table` components per card;
 *   - at most 50 columns (beyond is not displayed);
 *   - each page shows `page_size` data rows (default 5, cap 10; the table
 *     paginates client-side).
 *
 * When a reply contains more than 5 tables, the tables spill onto additional
 * cards (each card holds up to 5 tables).
 *
 * @module dsh-channel/table
 */
import type { FeishuCardPayload } from './contract/channel.ts';

/** Max `table` components permitted per card by Feishu. */
export const MAX_TABLES_PER_CARD = 5;
/** Max data columns per table (Feishu cap; beyond is not displayed). */
export const MAX_TABLE_COLUMNS = 50;

/** One parsed markdown table: header (row 0) + data rows. */
export interface RawTable {
    rows: string[][];
    /** Line index (in the source text) where the table block starts. */
    startLine: number;
    /** Line index (exclusive) where the table block ends. */
    endLine: number;
}

/**
 * Split assistant text into alternating plain-text segments (before/after
 * tables) and raw tables, preserving order.
 */
interface Segment {
    kind: 'text' | 'table';
    text?: string;
    raw?: RawTable;
}

function parseRow(l: string): string[] {
    return l.replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

/** True when a trimmed line looks like a markdown table data/header row. */
function isTableRow(line: string): boolean {
    const t = line.trim();
    return t.startsWith('|') && t.endsWith('|') && t.length > 2;
}

/** True when a line is a markdown table separator row (`|---|---|`). */
function isSeparator(line: string): boolean {
    return /^\|[\s:|-]+\|?$/.test(line.trim());
}

/** Extract EVERY markdown table from `text`, in order. */
export function extractAllMarkdownTables(text: string): RawTable[] {
    const lines = text.split('\n');
    const tables: RawTable[] = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i] ?? '';
        // A table starts with a data row followed by a separator row.
        if (isTableRow(line) && i + 1 < lines.length && isSeparator(lines[i + 1]!)) {
            const rows: string[][] = [parseRow(line)];
            let j = i + 2;
            while (j < lines.length && isTableRow(lines[j]!)) {
                rows.push(parseRow(lines[j]!));
                j++;
            }
            if (rows.length >= 2) {
                tables.push({ rows, startLine: i, endLine: j });
            }
            i = j;
        } else {
            i++;
        }
    }
    return tables;
}

/** Backward-compatible: first table only, or null. */
export function extractMarkdownTable(text: string): string[][] | null {
    const all = extractAllMarkdownTables(text);
    return all.length > 0 ? all[0]!.rows : null;
}

/** True when `text` contains a markdown fenced code block (``` ... ```). */
export function containsCodeBlock(text: string): boolean {
    return /```[\s\S]*?```/.test(text);
}

/** True when the reply has structure worth rendering as a Feishu card
 *  (markdown table or fenced code block). Feishu's card markdown component
 *  renders both. */
export function shouldUseCard(text: string): boolean {
    return extractAllMarkdownTables(text).length > 0 || containsCodeBlock(text);
}

/**
 * Build the outbound cards for reply text that contains markdown tables.
 *
 * Splits `text` into tables and the plain-text runs around them, then groups
 * the tables into cards of at most {@link MAX_TABLES_PER_CARD} each. The
 * plain-text block preceding a group becomes that group's lead text. Returns
 * the ordered cards plus `residual` (any remaining plain text that became no
 * card, e.g. trailing text after the last group).
 */
export function splitTablesFromText(
    text: string,
): { cards: FeishuCardPayload[]; residual: string } {
    const tables = extractAllMarkdownTables(text);
    if (tables.length === 0) return { cards: [], residual: text };

    const lines = text.split('\n');

    const cards: FeishuCardPayload[] = [];
    for (let idx = 0; idx < tables.length; idx += MAX_TABLES_PER_CARD) {
        const group = tables.slice(idx, idx + MAX_TABLES_PER_CARD);
        const bodyElements: unknown[] = [];
        if (idx === 0) {
            // Attach any leading text before the first table as the lead.
            const before = lines.slice(0, group[0]!.startLine).join('\n').trim();
            if (before !== '') bodyElements.push({ tag: 'markdown', content: before });
        }
        for (const t of group) {
            bodyElements.push(tableElement(t.rows));
        }
        cards.push({
            schema: '2.0',
            body: { elements: bodyElements },
        } as FeishuCardPayload);
    }

    // Trailing plain text after the last table (footnote/wrap-up) is appended
    // to the LAST card so it rides along with it, not emitted as its own
    // message. residual is returned empty for callers that send trailing text.
    const lastTableEnd = tables[tables.length - 1]!.endLine;
    const trailing = lines.slice(lastTableEnd).join('\n').trim();
    if (trailing !== '') {
        const lastCard = cards[cards.length - 1]!;
        const body = (lastCard as { body?: { elements?: unknown[] } }).body ?? { elements: [] };
        body.elements ??= [];
        body.elements.push({ tag: 'markdown', content: trailing });
        (lastCard as { body?: { elements?: unknown[] } }).body = body;
    }
    return { cards, residual: '' };
}

/** One official `table` component for a markdown table. */
function tableElement(rows: string[][]): unknown {
    const headers = (rows[0] ?? []).slice(0, MAX_TABLE_COLUMNS);
    const dataRows = rows.slice(1);
    const pageSize = 5;

    const columns = headers.map((displayName, i) => ({
        name: `col_${i}`,
        display_name: displayName,
        data_type: 'text' as const,
    }));

    const tableRows = dataRows.map((row) => {
        const record: Record<string, string | number> = {};
        for (let i = 0; i < headers.length; i++) {
            const cell = row[i] ?? '';
            record[`col_${i}`] = /^[-+]?\d+(\.\d+)?$/.test(cell.trim()) ? Number(cell) : cell;
        }
        return record;
    });

    return {
        tag: 'table',
        page_size: pageSize,
        columns,
        rows: tableRows,
    };
}

/**
 * Build a single Feishu schema-2.0 card rendering ONE markdown table with the
 * native `table` component. `rows[0]` is the header row; the rest are data.
 * Optional `leadText` renders as a markdown paragraph above the table.
 */
export function buildTableCard(
    headerTitle: string,
    rows: string[][],
    opts: { pageSize?: number; leadText?: string } = {},
): FeishuCardPayload {
    const pageSize = Math.min(10, Math.max(1, opts.pageSize ?? 5));
    const elements: unknown[] = [];
    if (opts.leadText !== undefined && opts.leadText.trim() !== '') {
        elements.push({ tag: 'markdown', content: opts.leadText });
    }
    elements.push(tableElement(rows));
    return {
        schema: '2.0',
        ...(headerTitle === '' ? {} : { header: { title: { tag: 'plain_text', content: headerTitle }, template: 'blue' } }),
        body: { elements },
    } as FeishuCardPayload;
}

/**
 * Build a Feishu card holding reply text that contains a fenced code block.
 * The card markdown component renders ``` blocks natively, so the whole text
 * rides in one markdown element (no need to split the code block out). Long
 * text spills onto multiple cards.
 */
export function buildCodeBlockCards(text: string): FeishuCardPayload[] {
    const t = text.trim();
    if (t === '') return [];
    const chunks = chunkLongText(t);
    return chunks.map((chunk) => ({
        schema: '2.0',
        body: { elements: [{ tag: 'markdown', content: chunk }] },
    }) as FeishuCardPayload);
}

/**
 * Feishu single-text-message length cap. Messages longer than this must be
 * split across multiple messages (openclaw uses 4000 as its chunk limit).
 */
export const FEISHU_TEXT_CHUNK_LIMIT = 4000;

/**
 * Split a long plain-text message into chunks of at most
 * {@link FEISHU_TEXT_CHUNK_LIMIT} characters, breaking at paragraph/newline
 * boundaries when possible. Returns the original text unchanged when it is
 * short enough.
 */
export function chunkLongText(text: string, limit = FEISHU_TEXT_CHUNK_LIMIT): string[] {
    const t = text.trim();
    if (t === '') return [];
    if (t.length <= limit) return [t];

    const chunks: string[] = [];
    let rest = t;
    while (rest.length > limit) {
        // Try to break at the last newline within the limit (prefer paragraph
        // splits); fall back to a hard cut.
        const head = rest.slice(0, limit);
        const newline = head.lastIndexOf('\n');
        const cut = newline > limit * 0.5 ? newline : limit;
        chunks.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
    }
    if (rest !== '') chunks.push(rest);
    return chunks;
}
