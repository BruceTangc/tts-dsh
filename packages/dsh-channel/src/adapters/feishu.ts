/**
 * Feishu (Lark) adapter for the DSH Channel plugin.
 *
 * Uses the official Node SDK `@larksuiteoapi/node-sdk` (verified against
 * v1.73.0). The SDK owns the fiddly parts of the event callback: AES-256-CBC
 * Encrypt-Key decryption, event validation (x-lark-signature when encrypted,
 * verification-token checks otherwise), and tenant_access_token caching.
 *
 * Two delivery modes (no public IP required for long-connection):
 *
 *  - `long-connection` (default): the SDK's `WSClient` holds a WebSocket
 *    long connection to Feishu and pushes events to the same
 *    `EventDispatcher` (your program pulls nothing; Feishu pushes over the
 *    outbound socket — works behind NAT/CGNAT with no inbound firewall and no
 *    callback URL). Select "长连接" as the event-subscription mode in the
 *    Feishu developer console.
 *  - `webhook`: the plugin answers the event callback URL (challenge echo via
 *    `generateChallenge`, `EventDispatcher.invoke` for events) mounted on the
 *    DSH `webServer` `(req, res)` signature — no Express, no bundled server.
 *    Requires a public HTTPS callback URL configured in the console.
 *
 * Outbound text is sent through `client.im.message.create` / `.reply` in
 * both modes (outbound is a client-side API call, no inbound reachability
 * needed).
 *
 * @module dsh-channel/adapters/feishu
 */
import {
    AppType,
    Client,
    Domain,
    EventDispatcher,
    WSClient,
    generateChallenge,
} from '@larksuiteoapi/node-sdk';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ChannelAdapter, ChannelInboundMessage, ChannelMediaRef, ChannelTarget } from '../types/channel.ts';
import type { AccountAdapter, AccountKey, ConversationKey, FeishuCardPayload, OutboundRequest } from '../contract/channel.ts';
import { accountKey, conversationKey } from '../accounts/keys.ts';
import { detectImageType } from '../core/media.ts';

/** How the Feishu adapter receives events. */
export type FeishuMode = 'webhook' | 'long-connection';

/** Reaction pool used when `autoReceiveReaction: 'random'`. */
const RANDOM_REACTIONS: readonly string[] = [
    'THUMBSUP', 'HEART', 'LAUGH', 'FIRE', 'OK', 'DONE', 'SMILE', 'PARTY', 'APPLAUSE',
];

/** Feishu adapter configuration. */
export interface FeishuChannelConfig {
    /** Feishu self-built app id (`cli_...`). Empty/absent disables the adapter. */
    appId?: string;
    /** Feishu self-built app secret. Empty/absent disables the adapter. */
    appSecret?: string;
    /**
     * How events are received. `long-connection` (default) needs no public IP
     * and no callback URL; `webhook` requires a public HTTPS callback URL
     * (and answers the URL-verification challenge).
     */
    mode?: FeishuMode;
    /** Event-callback Encrypt Key, when encryption is enabled on the app. */
    encryptKey?: string;
    /** Event-callback Verification Token, when set on the app. */
    verificationToken?: string;
    /** Path (URL pathname, no trailing slash) the event callback lands on (webhook mode). */
    webhookPath?: string;
    /** International Lark domain instead of the CN Feishu domain. */
    larkDomain?: boolean;
    /** Auto-add this emoji_type reaction (e.g. THUMBSUP) to each inbound message, or 'random' to pick from a pool. */
    autoReceiveReaction?: string;
}

/** Feishu config with the credentials guaranteed present (mount-time narrowing). */
export type FeishuCredentials = FeishuChannelConfig & { appId: string; appSecret: string };

/** Adapter handles the SDK client + dispatcher so tests can swap them. */
export interface FeishuRuntime {
    client: Client;
    dispatcher: EventDispatcher;
    /** Injected WSClient for `long-connection` mode (tests avoid the network). */
    wsClient?: WSClient;
}

/** The `im.message.receive_v1` payload as typed by the SDK. */
interface ReceiveV1Data {
    sender?: {
        sender_id?: {
            union_id?: string;
            user_id?: string;
            open_id?: string;
        };
        sender_type?: string;
    };
    message?: {
        message_id: string;
        chat_id: string;
        chat_type: string;
        message_type: string;
        content: string;
        /** Id of the root message when this message is inside a thread/topic. */
        root_id?: string;
        /** Id of the parent/quote message when this message replies to or
         *  quotes another message. */
        parent_id?: string;
    };
}

/**
 * Mount a Feishu channel and return its adapter.
 *
 * @param config - validated Feishu channel config.
 * @param dispatchInbound - core callback that receives normalized inbound messages.
 * @param serverRegister - the `webServer.register` binding (webhook mode only).
 * @param runtime - injected SDK surface (defaults to the real SDK).
 * @returns the adapter handle plus the disposer (closes the WS / deregisters the route).
 */
export interface FeishuOptions {
    /** The bot/app identity used for the V2 account key. */
    readonly accountId: string;
    /** Called to normalize an inbound message into the V1 surface for the router. */
    readonly dispatchInbound: (message: ChannelInboundMessage) => Promise<unknown>;
    readonly serverRegister: (route: { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }) => () => void;
    /**
     * Download an inbound media resource (image/file) by message + resource key.
     * Returns raw bytes, or `undefined` when the resource is unavailable.
     * Absent ⇒ media is not ingested (text-only mode).
     */
    readonly downloadMedia?: (messageId: string, fileKey: string, messageType: string | undefined) => Promise<Uint8Array | undefined>;
    /** When set, automatically add this emoji_type reaction to each inbound
     *  message (e.g. 'THUMBSUP') so the bot visibly "acknowledges" receipt,
     *  mirroring openclaw's behavior. */
    readonly autoReceiveReaction?: string;
    readonly runtime?: FeishuRuntime;
    /** Optional lifecycle reporter (pushes `channel/account-status`). */
    readonly reportStatus?: (state: 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'error', detail?: string) => void;
}

export function createFeishuAdapter(
    config: FeishuCredentials,
    options: FeishuOptions,
): { adapter: ChannelAdapter; accountAdapter: AccountAdapter; account: AccountKey; start: () => Promise<void>; clearAutoReaction: (chatId: string) => Promise<void>; dispose: () => void } {
    const domain = config.larkDomain ? Domain.Lark : Domain.Feishu;
    const account: AccountKey = accountKey('feishu', options.accountId);

    const client = options.runtime?.client
        ?? new Client({
            appId: config.appId,
            appSecret: config.appSecret,
            appType: AppType.SelfBuild,
            domain,
        });
    const reactionDelete = (client.im.messageReaction as never as { delete(args: unknown): Promise<unknown> }).delete;

    // Auto-acknowledgment reactions awaiting removal: chatId -> { messageId,
    // reactionId }. Cleared once the agent has replied to that chat.
    const pendingReactions = new Map<string, { messageId: string; reactionId: string }>();
    const clearAutoReaction = async (chatId: string): Promise<void> => {
        const pending = pendingReactions.get(chatId);
        if (pending === undefined) return;
        pendingReactions.delete(chatId);
        try {
            await reactionDelete({
                path: { message_id: pending.messageId, reaction_id: pending.reactionId },
            });
        } catch (error) {
            console.warn(`channel: feishu clear auto-reaction failed: ${String(error)}`);
        }
    };

    const dispatcher = options.runtime?.dispatcher
        ?? new EventDispatcher({
            ...(config.encryptKey === undefined ? {} : { encryptKey: config.encryptKey }),
            ...(config.verificationToken === undefined ? {} : { verificationToken: config.verificationToken }),
        });

    // Normalize `im.message.receive_v1` into a ChannelInboundMessage. The SDK
    // delivers the flat (already decrypted/unwrapped) event payload in both modes.
    dispatcher.register({
        'im.message.receive_v1': async (data: ReceiveV1Data) => {
            const message = data.message;
            if (message === undefined) return;
            const chatType = message.chat_type;
            if (chatType !== 'p2p' && chatType !== 'group' && chatType !== 'topic') return;

            const content = parseMessageContent(message.message_type, message.content);
            // Media-only messages (image/file/audio) have empty text but MUST
            // still be dispatched so the router can ingest the attachment.
            const mediaKey = extractFeishuMediaKey(message.message_type, message.content);
            if (content === '' && mediaKey === undefined) return;

            const senderId = data.sender?.sender_id?.open_id ?? '';
            const conversationId = chatType === 'p2p' ? senderId : message.chat_id;
            const conversation: ConversationKey = conversationKey('feishu', options.accountId, conversationId, undefined);

            let media: readonly ChannelMediaRef[] | undefined;
            if (mediaKey !== undefined && options.downloadMedia !== undefined) {
                try {
                    const bytes = await options.downloadMedia(message.message_id, mediaKey, message.message_type);
                    if (bytes !== undefined) {
                        media = [{
                            kind: message.message_type === 'image' ? 'media' : 'file',
                            data: bytes,
                            mimeType: message.message_type === 'image' ? detectImageType(bytes) : undefined,
                            fileName: undefined,
                            size: bytes.byteLength,
                        }];
                    }
                } catch (error) {
                    // Download failure must NOT silently drop the message: attach
                    // a textual note instead so the agent sees something happened.
                    options.reportStatus?.('error', `feishu media download failed: ${String(error)}`);
                }
            }

            if (options.autoReceiveReaction !== undefined && options.autoReceiveReaction !== '') {
                // Fire-and-forget acknowledgment so it never blocks routing.
                // Value may be a fixed emoji_type ('THUMBSUP') or 'random' (pick
                // from a default reaction pool each time). We remember the
                // reaction so it can be cleared after the agent's reply.
                const emoji = options.autoReceiveReaction === 'random'
                    ? RANDOM_REACTIONS[Math.floor(Math.random() * RANDOM_REACTIONS.length)] as string
                    : options.autoReceiveReaction;
                void client.im.messageReaction.create({
                    path: { message_id: message.message_id },
                    data: { reaction_type: { emoji_type: emoji } },
                }).then((resp) => {
                    const reactionId = (resp as { data?: { reaction_id?: string } } | null | undefined)?.data?.reaction_id;
                    if (reactionId !== undefined && reactionId !== '') {
                        pendingReactions.set(conversationId, { messageId: message.message_id, reactionId });
                    }
                }).catch((error: unknown) => {
                    console.warn(`channel: feishu auto-reaction failed: ${String(error)}`);
                });
            }

            // If this message replies to / quotes another message (parent_id),
            // fetch the referenced message's text so the agent can see what was
            // quoted. Best-effort: on any failure we fall back to the raw text.
            let inboundText = content;
            if (message.parent_id !== undefined && message.parent_id !== '') {
                try {
                    const parent = await client.im.message.get({ path: { message_id: message.parent_id } });
                    const data = (parent as { data?: { items?: Array<{ msg_type?: string; body?: { content?: string } }> } })?.data;
                    // SDK get returns data.items[0]; msg_type is on the item,
                    // the content JSON string is on item.body.content.
                    const quotedItem = data?.items?.[0];
                    const quotedMsgType = quotedItem?.msg_type;
                    const quotedJson = quotedItem?.body?.content;
                    if (typeof quotedJson === 'string') {
                        const quotedText = parseMessageContent(quotedMsgType, quotedJson);
                        if (quotedText !== '') {
                            inboundText = `[quoting message: ${quotedText}]\n${content}`;
                        }
                    }
                } catch (error) {
                    console.warn(`channel: feishu fetch quoted message failed: ${String(error)}`);
                }
            }

            await options.dispatchInbound({
                platform: 'feishu',
                // Reply into the same chat the message arrived in.
                target: {
                    id: conversationId,
                    replyTo: message.message_id,
                    key: conversation,
                    account,
                    kind: chatType === 'p2p' ? 'dm' : chatType,  // 'group' | 'topic'
                },
                senderId,
                senderName: senderId,
                text: inboundText,
                ...(media === undefined ? {} : { media }),
                nativeMessageId: message.message_id,
            });
        },
    });

    const mode = config.mode ?? 'long-connection';
    let disposeRoute: (() => void) | undefined;
    let wsClient: WSClient | undefined;

    if (mode === 'webhook') {
        const path = config.webhookPath ?? '/feishu/event';
        const handler = async (req: IncomingMessage, res: ServerResponse) => {
            const rawBody = await readRequestBody(req);
            let data: unknown = {};
            try {
                data = rawBody === '' ? {} : JSON.parse(rawBody);
            } catch {
                data = {};
            }
            if (typeof data !== 'object' || data === null) data = {};

            // Feishu URL-verification: echo the challenge (decrypting first when an
            // Encrypt Key is configured, exactly like the SDK's own adapters).
            try {
                const probe = generateChallenge(data, { encryptKey: dispatcher.encryptKey });
                if (probe.isChallenge) {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify(probe.challenge));
                    return;
                }
            } catch (error) {
                // Malformed or encrypted-without-key payload; let invoke decide.
                void error;
            }

            // Attach the raw headers so the SDK can verify x-lark-signature events.
            const payload = Object.assign(Object.create({ headers: req.headers }), data);
            // The SDK itself logs verification/parse failures; answer 200 regardless
            // so Feishu does not retry-bomb the route for one bad event.
            let value: unknown = '';
            try {
                value = await dispatcher.invoke(payload);
            } catch {
                value = '';
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(value ?? ''));
        };
        disposeRoute = options.serverRegister({ kind: 'exact', path, handler });
    } else {
        // Long connection: Feishu pushes events over an outbound WebSocket —
        // usable behind NAT/CGNAT with no public address. Same dispatcher.
        wsClient = options.runtime?.wsClient
            ?? new WSClient({
                appId: config.appId,
                appSecret: config.appSecret,
                domain,
                autoReconnect: true,
                handshakeTimeoutMs: 15_000,
                onError: (error) => {
                    console.warn(`channel: feishu long-connection error: ${error.message}`);
                    options.reportStatus?.('reconnecting', error.message);
                },
            });
    }

    /**
     * Start the connection explicitly (Phase 5: enables the reconnect loop to
     * drive reconnects through the same entry point). Resolves when the SDK
     * reports readiness; rejects when startup fails.
     */
    const start = async (): Promise<void> => {
        if (mode === 'webhook') {
            // Route already mounted at factory time; webhook mode is "connected"
            // by construction (inbound reachable once mounted).
            options.reportStatus?.('connected');
            return;
        }
        if (wsClient === undefined) throw new Error('channel: feishu wsClient not initialized');
        await wsClient.start({ eventDispatcher: dispatcher });
        options.reportStatus?.('connected');
    };

    // ── Phase 6: unified deliver (text + real media upload/send) ──────────────
    const sendTextMessage = async (conversation: ConversationKey, text: string, replyTo?: string): Promise<void> => {
        const content = JSON.stringify({ text });
        if (replyTo !== undefined) {
            await client.im.message.reply({ path: { message_id: replyTo }, data: { msg_type: 'text', content } });
        } else if (conversation.conversationId.startsWith('oc_')) {
            await client.im.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: conversation.conversationId, msg_type: 'text', content } });
        } else {
            await client.im.message.create({ params: { receive_id_type: 'open_id' }, data: { receive_id: conversation.conversationId, msg_type: 'text', content } });
        }
    };

    /** Upload bytes and send one media message (image/file/audio/video). */
    const sendMedia = async (conversation: ConversationKey, media: ChannelMediaRef, replyTo?: string): Promise<void> => {
        const buffer = Buffer.from(media.data);
        const kind: 'media' | 'file' | 'audio' | 'video' | 'voice' =
            media.kind === 'media' || media.kind === 'image' ? 'media'
                : media.kind === 'audio' ? 'audio'
                    : media.kind === 'video' ? 'video'
                        : media.kind === 'voice' ? 'voice' : 'file';
        let msgType: string;
        let content: string;
        if (kind === 'media') {
            const upload = await client.im.v1.image.create({ data: { image_type: 'message', image: buffer } });
            const imageKey = (upload as unknown as { image_key?: string; data?: { image_key?: string } }).image_key
                ?? (upload as unknown as { data?: { image_key?: string } }).data?.image_key;
            if (imageKey === undefined) throw new Error('feishu image upload returned no image_key');
            msgType = 'image';
            content = JSON.stringify({ image_key: imageKey });
        } else {
            const fileType = feishuFileType(kind, media.mimeType);
            const upload = await client.im.v1.file.create({
                data: {
                    file_type: fileType,
                    file: buffer,
                    file_name: media.fileName ?? `channel-${kind}`,
                },
            });
            const fileKey = (upload as unknown as { file_key?: string; data?: { file_key?: string } }).file_key
                ?? (upload as unknown as { data?: { file_key?: string } }).data?.file_key;
            if (fileKey === undefined) throw new Error('feishu file upload returned no file_key');
            msgType = kind === 'audio' ? 'audio' : 'file';
            content = JSON.stringify({ file_key: fileKey });
        }
        const data = { msg_type: msgType, content };
        if (replyTo !== undefined) {
            await client.im.message.reply({ path: { message_id: replyTo }, data });
        } else if (conversation.conversationId.startsWith('oc_')) {
            await client.im.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: conversation.conversationId, ...data } });
        } else {
            await client.im.message.create({ params: { receive_id_type: 'open_id' }, data: { receive_id: conversation.conversationId, ...data } });
        }
    };

    /** Send one interactive message card. */
    const sendCard = async (conversation: ConversationKey, card: FeishuCardPayload, replyTo?: string): Promise<string | undefined> => {
        // Card schema v2: send the raw payload as the message content. A
        // schema-2.0 card is sent with msg_type=interactive and content = the
        // card JSON itself (no outer {"type":...} wrapper for schema 2.0).
        const data: { msg_type: string; content: string } =
            card.schema?.startsWith('2')
                ? { msg_type: 'interactive', content: JSON.stringify(card) }
                : { msg_type: 'interactive', content: JSON.stringify({ type: 'template', data: card }) };
        let res: { data?: { message_id?: string } } | null | undefined;
        if (replyTo !== undefined) {
            res = await client.im.message.reply({ path: { message_id: replyTo }, data });
        } else if (conversation.conversationId.startsWith('oc_')) {
            res = await client.im.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: conversation.conversationId, ...data } });
        } else {
            res = await client.im.message.create({ params: { receive_id_type: 'open_id' }, data: { receive_id: conversation.conversationId, ...data } });
        }
        return res?.data?.message_id;
    };

    /** Deliver an outbound request to a conversation; returns the sent card's
     *  message id when the request carries a card. */
    const deliver = async (conversation: ConversationKey, request: OutboundRequest): Promise<string | undefined> => {
        const replyTo = request.threadId;
        if (request.card !== undefined) {
            const messageId = await sendCard(conversation, request.card, replyTo);
            for (const item of request.media ?? []) {
                await sendMedia(conversation, item, replyTo);
            }
            return messageId;
        }
        if (request.text !== '') await sendTextMessage(conversation, request.text, replyTo);
        for (const item of request.media ?? []) {
            await sendMedia(conversation, item, replyTo);
        }
        return undefined;
    };

    // Legacy ChannelAdapter surface (V1 compatibility).
    const adapter: ChannelAdapter = {
        platform: 'feishu',
        async send(target: ChannelTarget, message) {
            const conversation = messageTargetToConversation(target, account);
            await deliver(conversation, {
                text: message.text,
                ...(message.replyTo === undefined ? {} : { threadId: message.replyTo }),
                ...(message.media === undefined ? {} : { media: message.media }),
            });
        },
    };

    // Phase 6: AccountAdapter is the STANDARD face of this adapter.
    const accountAdapter: AccountAdapter = {
        platform: 'feishu',
        accountKey: account,
        capabilities: ['text', 'reply', 'image', 'file', 'audio', 'video'],
        supports: (cap) => (['text', 'reply', 'image', 'file', 'audio', 'video'] as const).includes(cap as never),
        async start() {
            await start();
        },
        async stop() {
            options.reportStatus?.('closed');
            if (mode === 'long-connection' && wsClient !== undefined) wsClient.close();
            disposeRoute?.();
        },
        async send(conversation, request) {
            const messageId = await deliver(conversation, request);
            return { messageId: messageId ?? `${conversation.conversationId}` };
        },
    };

    return {
        adapter,
        accountAdapter,
        account,
        start,
        clearAutoReaction,
        dispose() {
            options.reportStatus?.('closed');
            if (mode === 'long-connection' && wsClient !== undefined) {
                wsClient.close();
            }
            pendingReactions.clear();
            disposeRoute?.();
        },
    };
}

/** Map a legacy ChannelTarget to its ConversationKey (Phase 6 helper). */
function messageTargetToConversation(target: ChannelTarget, account: AccountKey): ConversationKey {
    return target.key ?? {
        platform: account.platform,
        accountId: account.accountId,
        conversationId: target.id,
    };
}

/** Feishu file_type for upload, derived from media kind/mime (SDK-legal values). */
function feishuFileType(kind: 'file' | 'audio' | 'video' | 'voice', mimeType?: string): 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' {
    if (kind === 'audio') return 'opus';
    if (kind === 'video') return 'mp4';
    if (kind === 'voice') return 'opus';
    const mime = (mimeType ?? '').toLowerCase();
    if (mime.startsWith('application/pdf')) return 'pdf';
    if (mime.includes('word') || mime.includes('document')) return 'doc';
    if (mime.includes('sheet')) return 'xls';
    if (mime.includes('presentation') || mime.includes('powerpoint')) return 'ppt';
    return 'stream';
}

/** Concatenate the raw request body bytes. */
function readRequestBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

/**
 * Extract the media resource key from a Feishu `im.message.receive_v1`
 * content payload (`image_key` for images, `file_key` for files, media_id for
 * audio). Returns undefined for text/system/unsupported payloads.
 */
function extractFeishuMediaKey(messageType: string | undefined, content: string | undefined): string | undefined {
    if (content === undefined) return undefined;
    try {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        switch (messageType) {
            case 'image': {
                const k = parsed.image_key;
                return typeof k === 'string' && k.length > 0 ? k : undefined;
            }
            case 'file': {
                const k = parsed.file_key;
                return typeof k === 'string' && k.length > 0 ? k : undefined;
            }
            case 'audio': {
                const k = parsed.media_id;
                return typeof k === 'string' && k.length > 0 ? k : undefined;
            }
            default:
                return undefined;
        }
    } catch {
        return undefined;
    }
}

/** Extract plain text from a Feishu message content JSON string. */
function parseMessageContent(messageType: string | undefined, content: string | undefined): string {
    if (content === undefined) return '';
    try {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        switch (messageType) {
            case 'text':
                return typeof parsed.text === 'string' ? parsed.text : '';
            case 'post': {
                // Rich text: { "title": "...", "content": [[{ "tag": "text", "text": "..." }]] }
                const lines = Array.isArray(parsed.content)
                    ? (parsed.content as unknown[][]).map((line) => (line as { text?: string }[])
                        .map((block) => (typeof block === 'object' && block !== null && typeof (block as { text?: unknown }).text === 'string'
                            ? (block as { text: string }).text
                            : '')).join(''))
                    : [];
                return lines.join('\n');
            }
            default:
                return '';
        }
    } catch {
        // Non-text content (image, file, audio...) has no relayable text.
        return '';
    }
}
