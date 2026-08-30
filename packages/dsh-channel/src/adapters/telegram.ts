/**
 * Telegram adapter for the DSH Channel plugin.
 *
 * Uses the grammY SDK (`grammy`, verified against v1.45.1). grammY's core has
 * no runtime dependencies and ships native TypeScript types.
 *
 * Two delivery modes (no public IP required for polling):
 *
 *  - `polling` (default): grammY runs long polling against Telegram's
 *    `getUpdates` (your program pulls updates — works behind NAT/CGNAT with no
 *    inbound firewall, no webhook setup at all). Start/stop via
 *    `bot.start()` / `bot.stop()`.
 *  - `webhook`: `webhookCallback(bot, 'http')` returns a plain `(req, res)`
 *    Node handler (the `http` adapter drives `req.on('data')` /
 *    `res.writeHead` / `res.end` directly) that mounts on the DSH
 *    `webServer` service — no Express, no bundled HTTP server. The same
 *    helper validates `X-Telegram-Bot-Api-Secret-Token` when a secret token is
 *    configured, and the route path defaults to `/telegram/webhook/<token>`
 *    (the token in the path is the URL secret). Requires the server to be
 *    reachable from Telegram (public HTTPS).
 *
 * Messages are sent through `bot.api.sendMessage(...)` in both modes.
 *
 * @module dsh-channel/adapters/telegram
 */
import { Bot, webhookCallback, InputFile } from 'grammy';
import type { Context as GrammyContext } from 'grammy';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ChannelAdapter, ChannelInboundMessage, ChannelMediaRef, ChannelTarget } from '../types/channel.ts';
import type { AccountAdapter, AccountKey, ConversationKey, OutboundRequest } from '../contract/channel.ts';
import { accountKey, conversationKey } from '../accounts/keys.ts';

/** How the Telegram adapter receives updates. */
export type TelegramMode = 'webhook' | 'polling';

/** Telegram adapter configuration. */
export interface TelegramChannelConfig {
    /** Bot token from BotFather (`123456:ABC-DEF...`). Empty/absent disables the adapter. */
    token?: string;
    /**
     * How updates are received. `polling` (default) needs no public IP and no
     * webhook setup; `webhook` requires a public HTTPS endpoint and a
     * `setWebhook` call, and validates the optional secret token header.
     */
    mode?: TelegramMode;
    /**
     * Optional secret token set alongside `setWebhook` (webhook mode only);
     * when present it must match the `X-Telegram-Bot-Api-Secret-Token` header
     * on every update.
     */
    secretToken?: string;
    /** Webhook route path (webhook mode only; no trailing slash). Defaults to `/telegram/webhook/<token>`. */
    webhookPath?: string;
}

/** Telegram config with the token guaranteed present (mount-time narrowing). */
export type TelegramCredentials = TelegramChannelConfig & { token: string };

/** Adapter handles the underlying grammY bot so tests can swap it. */
export interface TelegramRuntime {
    bot: Bot;
}

/**
 * Mount a Telegram channel and return its adapter.
 *
 * @param config - validated Telegram channel config.
 * @param dispatchInbound - core callback that receives normalized inbound messages.
 * @param serverRegister - the `webServer.register` binding (webhook mode only).
 * @param runtime - injected grammY bot (defaults to a fresh one from the token).
 * @returns the adapter handle plus the disposer (stops polling / deregisters the route).
 */
export interface TelegramOptions {
    /** The bot identity used for the V2 account key (username or numeric id). */
    readonly accountId: string;
    readonly dispatchInbound: (message: ChannelInboundMessage) => Promise<unknown>;
    readonly serverRegister: (route: { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }) => () => void;
    readonly runtime?: TelegramRuntime;
    readonly reportStatus?: (state: 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'error', detail?: string) => void;
}

export function createTelegramAdapter(
    config: TelegramCredentials,
    options: TelegramOptions,
): { adapter: ChannelAdapter; accountAdapter: AccountAdapter; account: AccountKey; start: () => Promise<void>; dispose: () => void } {
    const bot = options.runtime?.bot ?? new Bot(config.token);
    const mode = config.mode ?? 'polling';
    const account: AccountKey = accountKey('telegram', options.accountId);

    // Normalize an incoming Telegram update into a ChannelInboundMessage.
    // Runs in both modes: polling feeds updates through the same middlewares.
    bot.on('message:text', async (ctx: GrammyContext) => {
        const message = ctx.message;
        if (message === undefined) return;
        const text = message.text;
        if (text === undefined || text === '') return;
        const chat = message.chat;
        const from = message.from;
        const replyTo = message.reply_to_message?.message_id;
        const conversation: ConversationKey = conversationKey('telegram', options.accountId, String(chat.id));
        const kind = chat.type === 'private' ? 'dm' : 'group';
        await options.dispatchInbound({
            platform: 'telegram',
            target: {
                id: String(chat.id),
                ...(replyTo === undefined ? {} : { replyTo: String(replyTo) }),
                key: conversation,
                account,
                kind,
            },
            senderId: String(from?.id ?? ''),
            senderName: from?.username
                ?? from?.first_name,
            text,
            nativeMessageId: String(message.message_id),
        });
    });

    let disposeRoute: (() => void) | undefined;
    if (mode === 'webhook') {
        const path = config.webhookPath ?? `/telegram/webhook/${config.token}`;
        // The 'http' adapter reads the raw body off the IncomingMessage itself
        // and validates the optional secret-token header before dispatching.
        const handler = webhookCallback(bot, 'http', {
            ...(config.secretToken === undefined ? {} : { secretToken: config.secretToken }),
        }) as (req: IncomingMessage, res: ServerResponse) => Promise<void>;
        disposeRoute = options.serverRegister({ kind: 'exact', path, handler });
    }

    /**
     * Start the connection explicitly (Phase 5: reconnect loop entry point).
     * Polling resolves when `bot.start()` settles; webhook mode is
     * "connected" by construction once the route is mounted.
     */
    const start = async (): Promise<void> => {
        if (mode === 'webhook') {
            options.reportStatus?.('connected');
            return;
        }
        await bot.start({ allowed_updates: ['message'] });
        options.reportStatus?.('connected');
    };

    // ── Phase 6: unified deliver (text + real media send) ─────────────────────
    const sendText = async (conversation: ConversationKey, text: string, replyTo?: string): Promise<void> => {
        await bot.api.sendMessage(conversation.conversationId, text, {
            parse_mode: 'HTML',
            ...(replyTo === undefined ? {} : { reply_to_message_id: Number(replyTo) }),
        });
    };

    const sendOneMedia = async (conversation: ConversationKey, media: ChannelMediaRef, replyTo?: string): Promise<void> => {
        const file = new InputFile(Buffer.from(media.data), media.fileName);
        const reply = replyTo === undefined ? {} : { reply_to_message_id: Number(replyTo) };
        const kind: 'image' | 'file' | 'audio' | 'video' | 'voice' =
            media.kind === 'image' || media.kind === 'media' ? 'image'
                : media.kind === 'audio' ? 'audio'
                    : media.kind === 'video' ? 'video'
                        : media.kind === 'voice' ? 'voice' : 'file';
        switch (kind) {
            case 'image':
                await bot.api.sendPhoto(conversation.conversationId, file, reply);
                break;
            case 'audio':
                await bot.api.sendAudio(conversation.conversationId, file, reply);
                break;
            case 'video':
                await bot.api.sendVideo(conversation.conversationId, file, reply);
                break;
            case 'voice':
                await bot.api.sendVoice(conversation.conversationId, file, reply);
                break;
            default:
                await bot.api.sendDocument(conversation.conversationId, file, reply);
                break;
        }
    };

    const deliver = async (conversation: ConversationKey, request: OutboundRequest): Promise<void> => {
        const replyTo = request.threadId;
        if (request.text !== '') await sendText(conversation, request.text, replyTo);
        for (const item of request.media ?? []) {
            await sendOneMedia(conversation, item, replyTo);
        }
    };

    const adapter: ChannelAdapter = {
        platform: 'telegram',
        async send(target: ChannelTarget, message) {
            const conversation: ConversationKey = target.key ?? {
                platform: account.platform,
                accountId: account.accountId,
                conversationId: target.id,
            };
            await deliver(conversation, {
                text: message.text,
                ...(message.replyTo === undefined ? {} : { threadId: message.replyTo }),
                ...(message.media === undefined ? {} : { media: message.media }),
            });
        },
    };

    // Phase 6: AccountAdapter is the STANDARD face of this adapter.
    const accountAdapter: AccountAdapter = {
        platform: 'telegram',
        accountKey: account,
        capabilities: ['text', 'reply', 'image', 'file', 'audio', 'video'],
        supports: (cap) => (['text', 'reply', 'image', 'file', 'audio', 'video'] as const).includes(cap as never),
        async start() {
            await start();
        },
        async stop() {
            options.reportStatus?.('closed');
            if (mode === 'polling') {
                void bot.stop().catch((error: unknown) => {
                    console.warn(`channel: telegram polling stop: ${String(error)}`);
                });
            }
            disposeRoute?.();
        },
        async send(conversation, request) {
            await deliver(conversation, request);
            return { messageId: `${conversation.conversationId}` };
        },
    };

    return {
        adapter,
        accountAdapter,
        account,
        start,
        dispose() {
            options.reportStatus?.('closed');
            if (mode === 'polling') {
                void bot.stop().catch((error: unknown) => {
                    console.warn(`channel: telegram polling stop: ${String(error)}`);
                });
            }
            disposeRoute?.();
        },
    };
}
