/**
 * DSH Channel — Feishu model-facing tools.
 *
 * @module dsh-channel/feishu-tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { Context } from '@deepseek-ai/cordis';

import type { ChannelRouter } from './core/router.ts';
import type { FeishuChannelConfig } from './adapters/feishu.ts';
import { buildTableCard } from './table.ts';
import {
    createFeishuMessageOps,
    buildFeishuCard,
    unicodeToEmojiType,
} from './feishu-message.ts';

/** Resolve the active DSH session id from a tool's execution context. */
function sessionIdOf(exec?: { agent?: { id: unknown } }): string | undefined {
    return exec?.agent !== undefined ? String(exec.agent.id) : undefined;
}

/**
 * Register the Feishu model-facing tools on `ctx.tools`.
 *
 * Returns disposers. Each tool targets the Feishu chat currently speaking to
 * the agent (resolved via the router's session→chat map).
 */
export function registerFeishuTools(
    ctx: Context,
    router: ChannelRouter,
    config: FeishuChannelConfig,
): Array<() => void> {
    const ops = createFeishuMessageOps(config);
    const disposers: Array<() => void> = [];

    disposers.push(ctx.tools.register(defineTool({
        name: 'feishu_send_card',
        description: 'Send a Feishu interactive message card (buttons/rich layout) to the Feishu chat that is currently talking to this agent. The card is sent as a message_card with msg_type=interactive.',
        parameters: {
            header_title: { type: 'string', description: 'Card header title text.' },
            markdown: { type: 'string', description: 'Markdown body content for the card.' },
            buttons: { type: 'array', items: { type: 'string' }, description: 'Optional button labels; each becomes a button in the card.' },
        },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        timeoutMs: 15000,
        async execute(args, exec) {
            const sessionId = sessionIdOf(exec);
            if (sessionId === undefined) return 'card not sent: not running in an agent session';
            const card = buildFeishuCard(args.header_title ?? '', args.markdown ?? '', args.buttons);
            const messageId = await router.sendCardNow(sessionId, card);
            return messageId !== undefined
                ? `card sent to session ${sessionId} (message_id=${messageId})`
                : `card queued for session ${sessionId} (no active chat yet)`;
        },
    })));

    disposers.push(ctx.tools.register(defineTool({
        name: 'feishu_send_table',
        description: 'Send a Feishu message card with a native table (official table component) to the Feishu chat currently talking to this agent. Markdown tables are NOT supported in Feishu card text, so use this for tabular data.',
        parameters: {
            header_title: { type: 'string', description: 'Card header title text.' },
            headers: { type: 'array', items: { type: 'string' }, required: true, description: 'Column header labels.' },
            rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, required: true, description: 'Table data rows; each row is an array matching the headers length.' },
            page_size: { type: 'integer', description: 'Rows shown per page before the card paginates (1-10; default 5).' },
        },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        timeoutMs: 15000,
        async execute(args, exec) {
            const sessionId = sessionIdOf(exec);
            if (sessionId === undefined) return 'table not sent: not running in an agent session';
            const rows = [args.headers ?? [], ...(args.rows ?? [])];
            const card = buildTableCard(args.header_title ?? 'Table', rows, { pageSize: args.page_size });
            const messageId = await router.sendCardNow(sessionId, card);
            return messageId !== undefined
                ? `table card sent to session ${sessionId} (message_id=${messageId})`
                : `table card queued for session ${sessionId} (no active chat yet)`;
        },
    })));

    disposers.push(ctx.tools.register(defineTool({
        name: 'feishu_delete_message',
        description: 'Recall (delete) a message that this bot sent in Feishu, by its message id. Returns ok once recalled.',
        parameters: { message_id: { type: 'string', required: true, description: 'The Feishu message id to recall.' } },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        timeoutMs: 15000,
        async execute(args) {
            return ops.delete(args.message_id);
        },
    })));

    disposers.push(ctx.tools.register(defineTool({
        name: 'feishu_update_message',
        description: 'Update the content of a message card this bot sent in Feishu (by its message id), replacing the whole card with a new header + markdown body.',
        parameters: {
            message_id: { type: 'string', required: true, description: 'The Feishu message id (card) to update.' },
            header_title: { type: 'string', description: 'New card header title text.' },
            markdown: { type: 'string', description: 'New markdown body content for the card.' },
        },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        timeoutMs: 15000,
        async execute(args) {
            const card = buildFeishuCard(args.header_title ?? 'Updated', args.markdown ?? '', undefined);
            return ops.update(args.message_id, JSON.stringify(card));
        },
    })));

    disposers.push(ctx.tools.register(defineTool({
        name: 'feishu_pin_message',
        description: 'Pin a message in a Feishu chat so it stays at the top, by its message id.',
        parameters: { message_id: { type: 'string', required: true, description: 'The Feishu message id to pin.' } },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        timeoutMs: 15000,
        async execute(args) {
            return ops.pin(args.message_id);
        },
    })));

    disposers.push(ctx.tools.register(defineTool({
        name: 'feishu_add_reaction',
        description: 'Add an emoji reaction to a Feishu message (by message_id). Pass the Feishu emoji_type key (e.g. THUMBSUP, SMILE, HEART, FIRE, LAUGH, OK, DONE, PARTY) — Unicode emoji like 👍 are auto-mapped when possible.',
        parameters: {
            message_id: { type: 'string', required: true, description: 'The Feishu message id to react to.' },
            emoji: { type: 'string', required: true, description: 'Feishu emoji_type key or a Unicode emoji, e.g. "THUMBSUP", "SMILE", "👍", "❤️".' },
        },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        timeoutMs: 15000,
        async execute(args) {
            return ops.addReaction(args.message_id, unicodeToEmojiType(args.emoji));
        },
    })));

    return disposers;
}
