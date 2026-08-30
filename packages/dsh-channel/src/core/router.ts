/**
 * Channel router: the DSH integration seam (minimal build).
 *
 * Inbound: dedup → resolve the bound session via the ConversationRegistry
 * (explicit `channelMap`, then the persisted binding) → deliver to the LIVE
 * agent through `ctx.agents.get(...).followup`. No session is ever created:
 * an unbound chat or a bound-but-not-live session is ignored (logged).
 *
 * Outbound: subscribes the DSH `session/event` firehose and forwards
 * `assistant/message` text to every chat that has spoken in that session,
 * through the platform `AccountAdapter` registered for its platform.
 *
 * @module dsh-channel/core/router
 */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-attachment';
import { SessionId, isSurfaceEvent, type SessionEvent } from '@deepseek-ai/dsh-session';
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm';

import type { ChannelInboundMessage, ChannelOutboundMessage, ChannelTarget, PlatformId } from '../types/channel.ts';
import type { AccountAdapter, ChannelMediaRef, ConversationKey } from '../contract/channel.ts';
import type { ConversationRegistry } from '../conversation/registry.ts';
import { chatKey } from '../conversation/keys.ts';
import { imageBlock, ingestInboundMedia } from './media.ts';
import { splitTablesFromText, containsCodeBlock, buildCodeBlockCards, chunkLongText } from '../table.ts';

/** The stable chat key used for mapping: `<platform>:<target.id>`. */
export { chatKey } from '../conversation/keys.ts';

/** One chat currently associated with a session for outbound replies. */
interface ChatRow {
    readonly platform: PlatformId;
    readonly target: ChannelTarget;
}

/** Options for constructing the router. */
export interface ChannelRouterOptions {
    /** Root/plugin context; the router emits `channel/*` events here. */
    ctx: Context;
    /** The SINGLE authoritative conversation→session mapping source. */
    registry: ConversationRegistry;
    /** Live platform adapters keyed by platform (outbound sends). */
    adapters: Readonly<Partial<Record<PlatformId, AccountAdapter>>>;
    /** Root directory for inbound non-image attachments (channel-attachments/). */
    mediaRoot: string;
    /** Optional per-platform callback to clear a chat's auto-acknowledgment
     *  reaction once the agent has replied to that chat. */
    clearAutoReaction?: (platform: PlatformId, chatId: string) => Promise<void>;
}

/** Text extracted from assistant message content blocks. */
function extractText(content: readonly ContentBlock[]): string {
    return content
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('');
}

/** How long a processed platform message id stays deduplicated (redelivery guard). */
const INBOUND_DEDUP_TTL_MS = 60_000;

/**
 * Routes channel traffic to/from DSH agents. Create once per plugin load and
 * dispose on unload.
 */
export class ChannelRouter {
    private readonly ctx: Context;
    private readonly registry: ConversationRegistry;
    private readonly adapters: Readonly<Partial<Record<PlatformId, AccountAdapter>>>;
    private readonly mediaRoot: string;
    private clearAutoReaction: ((platform: PlatformId, chatId: string) => Promise<void>) | undefined;

    /** Session id → chats that have spoken, so replies land where the turn came from. */
    private readonly sessionChats = new Map<string, ChatRow[]>();
    /** Latest assistant text+images per session for the current turn; the FINAL
     *  reply is the last one, flushed at turn/end. */
    private readonly finalAssistant = new Map<string, { text: string; images: readonly Extract<ContentBlock, { type: 'image' }>[] }>();
    /** Recently processed platform message ids, guarding against redelivery. */
    private readonly seenMessages = new Map<string, number>();
    private readonly offSessionEvent: () => void;
    private disposed = false;

    constructor(options: ChannelRouterOptions) {
        this.ctx = options.ctx;
        this.registry = options.registry;
        this.adapters = options.adapters;
        this.mediaRoot = options.mediaRoot;
        this.clearAutoReaction = options.clearAutoReaction;
        this.offSessionEvent = this.ctx.on('session/event', (session: { id: SessionId }, event: SessionEvent) => {
            this.handleSessionEvent(String(session.id), event);
        });
    }

    /**
     * Route one normalized inbound message from a platform adapter.
     * @param message - the normalized inbound payload.
     * @returns the routed session id, or undefined when the message was ignored.
     */
    async dispatchInbound(message: ChannelInboundMessage): Promise<SessionId | undefined> {
        if (this.disposed) return undefined;
        // Platforms deliver at-least-once (Feishu long connection redelivers on
        // reconnect), so an identical native message id within the TTL window is
        // a duplicate delivery — do not re-run the agent for it.
        if (message.nativeMessageId !== undefined) {
            const now = Date.now();
            for (const [id, ts] of this.seenMessages) {
                if (now - ts > INBOUND_DEDUP_TTL_MS) this.seenMessages.delete(id);
            }
            const dedupKey = `${message.platform}:${message.nativeMessageId}`;
            if (this.seenMessages.has(dedupKey)) {
                this.ctx.logger.debug(`channel: duplicate delivery of ${dedupKey} ignored`);
                return undefined;
            }
            this.seenMessages.set(dedupKey, now);
        }
        const key = chatKey(message.platform, message.target);

        // Resolve the bound session: explicit channelMap, then persisted binding.
        const resolved = message.target.key !== undefined
            ? this.registry.lookup(message.target.key)
            : this.registry.lookupLegacy(key);
        const sessionId = resolved?.sessionId;
        if (sessionId === undefined) {
            this.ctx.logger.debug(`channel: ignored inbound from ${key} (no binding)`);
            this.ctx.emit('channel/inbound', message, undefined);
            return undefined;
        }

        // Deliver only to a LIVE agent — never create/resume a session here.
        const agent = this.ctx.agents.get(SessionId(sessionId));
        if (agent === undefined) {
            this.ctx.logger.debug(`channel: ${key} -> session ${sessionId} not live; ignored`);
            this.ctx.emit('channel/inbound', message, undefined);
            return undefined;
        }
        agent.followup(await this.buildUserMessage(message, sessionId));

        // Remember this chat so replies to this session reach it.
        this.associate(sessionId, message.platform, message.target);

        this.ctx.logger.debug(`channel: ${key} -> session ${sessionId} (inbound)`);
        this.ctx.emit('channel/inbound', message, SessionId(sessionId));
        return SessionId(sessionId);
    }

    /** Record that a chat spoke in a session; replies are fanned out to these chats. */
    private associate(sessionId: string, platform: PlatformId, target: ChannelTarget): void {
        const rows = this.sessionChats.get(sessionId) ?? [];
        const key = chatKey(platform, target);
        if (!rows.some((row) => chatKey(row.platform, row.target) === key)) {
            rows.push({ platform, target });
            this.sessionChats.set(sessionId, rows);
        }
    }

    /**
     * Build the user message fed into the agent, tagged with the channel
     * source. Inbound media is ingested: images become DSH image attachments
     * (visible to the model), non-image files land under
     * `<mediaRoot>/channel-attachments/<sessionId>/` and are surfaced to the
     * agent as a text path reference.
     */
    private async buildUserMessage(
        message: ChannelInboundMessage,
        sessionId: string,
    ): Promise<ReturnType<typeof createUserMessage>> {
        const content: ContentBlock[] = [];
        if (message.text !== '') content.push({ type: 'text', text: message.text });
        for (const item of message.media ?? []) {
            if (typeof item.data === 'string') {
                this.ctx.logger.warn(`channel: inbound media with path reference ignored: ${item.data}`);
                continue;
            }
            try {
                const ingested = await ingestInboundMedia(this.ctx, {
                    kind: item.kind === 'media' ? 'media' : 'file',
                    data: item.data,
                    ...(item.mimeType === undefined ? {} : { mimeType: item.mimeType }),
                    ...(item.fileName === undefined ? {} : { name: item.fileName }),
                }, sessionId, this.mediaRoot);
                if (ingested.kind === 'image') {
                    content.push(imageBlock(ingested.ref));
                } else {
                    content.push({ type: 'text', text: `[收到文件附件: ${ingested.path}]` });
                }
            } catch (error) {
                this.ctx.logger.warn(`channel: inbound media ingestion failed: ${String(error)}`);
            }
        }
        if (content.length === 0) content.push({ type: 'text', text: message.text });
        return createUserMessage({
            content,
            source: {
                kind: 'channel',
                platform: message.platform,
                chatId: message.target.id,
                senderId: message.senderId,
                ...(message.senderName === undefined ? {} : { senderName: message.senderName }),
            },
        });
    }

    /** Handle one session event for the outbound half. We accumulate the latest
     *  assistant text per turn and only push it to Feishu at `turn/end`, so
     *  intermediate per-step outputs (thinking / tool scaffolding) are not
     *  relayed — the user sees just the final result. */
    private handleSessionEvent(sessionId: string, event: SessionEvent): void {
        // Associate the latest assistant text for the turn; the FINAL answer is
        // the LAST assistant/message step. We keep it here and flush at
        // turn/end, so only the final reply goes out (no intermediate thinking).
        if (event.type === 'assistant/message' && isSurfaceEvent(event)) {
            const content = event.data.message.content;
            const text = extractText(content);
            const images = content.filter(
                (block): block is Extract<ContentBlock, { type: 'image' }> => block.type === 'image',
            );
            if (text !== '' || images.length > 0) {
                this.finalAssistant.set(sessionId, { text, images });
            }
            return;
        }

        if (event.type === 'turn/end') {
            const toSend = this.finalAssistant.get(sessionId);
            const chatsForTurn = this.sessionChats.get(sessionId) ?? [];
            if (toSend !== undefined && (toSend.text !== '' || toSend.images.length > 0)) {
                void this.sendAssistant(sessionId, chatsForTurn, toSend.text, toSend.images);
            }
            this.finalAssistant.delete(sessionId);
            this.clearReactionsForChats(chatsForTurn);
            // NOTE: sessionChats is deliberately NOT cleared here, so any async
            // assistant output that arrives after the turn still has a chat to
            // deliver to — otherwise replies could be silently dropped.
            return;
        }
    }

    /** After replying to a chat, clear its auto-acknowledgment reaction. */
    private clearReactionsForChats(chats: readonly ChatRow[]): void {
        if (this.clearAutoReaction === undefined) return;
        for (const chat of chats) {
            void this.clearAutoReaction(chat.platform, chat.target.id).catch(() => undefined);
        }
    }

    /** Assemble outbound media from assistant image blocks, then send. */
    private async sendAssistant(
        sessionId: string,
        chats: readonly ChatRow[],
        text: string,
        imageBlocks: readonly Extract<ContentBlock, { type: 'image' }>[],
    ): Promise<void> {
        const media: ChannelMediaRef[] = [];
        for (const block of imageBlocks) {
            try {
                const stored = await this.ctx.attachments.readImage(block.attachment);
                media.push({
                    kind: 'media',
                    data: stored.data,
                    mimeType: block.attachment.mediaType,
                    ...(block.attachment.name === undefined ? {} : { fileName: block.attachment.name }),
                    size: stored.data.byteLength,
                });
            } catch (error) {
                this.ctx.logger.warn(`channel: outbound image read failed: ${String(error)}`);
            }
        }

        // Detect markdown tables in the reply. Each table group (≤5 tables per
        // Feishu card) becomes one card carrying its surrounding text as the
        // lead, so text and tables live in the same messages instead of
        // separate ones.
        const { cards, residual } = splitTablesFromText(text);
        if (cards.length > 0) {
            // Any media still goes out as a normal message (images can't embed
            // in the table card alongside).
            if (media.length > 0) {
                await this.sendToChats(sessionId, chats, '', media);
            }
            for (const card of cards) {
                await this.sendCardNow(sessionId, card);
            }
            // Trailing plain text after the last table group (if any).
            if (residual.trim() !== '') {
                await this.sendToChats(sessionId, chats, residual);
            }
            return;
        }

        const textToSend = text;
        if (textToSend === '' && media.length === 0) return;
        // Code-block replies render as cards (Feishu card markdown supports
        // ``` fenced blocks); media can't live inside a card, so send it first.
        if (media.length > 0) {
            await this.sendToChats(sessionId, chats, '', media);
        }
        if (containsCodeBlock(textToSend)) {
            for (const card of buildCodeBlockCards(textToSend)) {
                await this.sendCardNow(sessionId, card);
            }
            return;
        }
        // Plain text (no tables/code) stays a normal text message; split
        // over-long replies into multiple messages.
        const chunks = chunkLongText(textToSend);
        let first = true;
        for (const chunk of chunks) {
            await this.sendToChats(sessionId, chats, chunk, first ? media : []);
            first = false;
        }
    }

    /** Send final text + media (and an optional card) to every chat associated with a session. */
    private async sendToChats(
        sessionId: string,
        chats: readonly ChatRow[],
        text: string,
        media: readonly ChannelMediaRef[] = [],
        card?: import('../contract/channel.ts').FeishuCardPayload,
    ): Promise<string | undefined> {
        const message: ChannelOutboundMessage = {
            text,
            ...(media.length === 0 ? {} : { media }),
            ...(card === undefined ? {} : { card }),
        };
        let cardMessageId: string | undefined;
        await Promise.allSettled(chats.map((chat) => {
            const adapter = this.adapters[chat.platform];
            if (adapter === undefined) return Promise.resolve();
            const conversation: ConversationKey = chat.target.key ?? {
                platform: chat.platform,
                accountId: adapter.accountKey.accountId,
                conversationId: chat.target.id,
            };
            return adapter.send(conversation, {
                text: message.text,
                ...(message.media === undefined ? {} : { media: message.media }),
                ...(message.card === undefined ? {} : { card: message.card }),
                ...(message.replyTo === undefined ? {} : { threadId: message.replyTo }),
            }).then((result) => {
                if (card !== undefined && cardMessageId === undefined && result?.messageId !== undefined) {
                    cardMessageId = result.messageId;
                }
            }).catch((error: unknown) => {
                this.ctx.logger.warn(
                    `channel: failed to send to ${chat.platform} ${chat.target.id}: ${String(error)}`,
                );
            });
        }));
        return cardMessageId;
    }

    /**
     * Send a Feishu card payload to a session's chats now. Returns the sent
     * message id, or undefined when the session has no associated chats.
     */
    async sendCardNow(sessionId: string, card: import('../contract/channel.ts').FeishuCardPayload): Promise<string | undefined> {
        const chats = this.sessionChats.get(sessionId);
        if (chats === undefined || chats.length === 0) return undefined;
        return this.sendToChats(sessionId, chats, '', [], card);
    }

    /** Register the per-platform reaction-clear callback (set once adapters are up). */
    setClearAutoReaction(fn: (platform: PlatformId, chatId: string) => Promise<void>): void {
        this.clearAutoReaction = fn;
    }

    /**
     * Send a Feishu card payload to a session's chats now (fire-and-forget).
     * Returns false when the session has no associated chats yet.
     */
    queueCard(sessionId: string, card: import('../contract/channel.ts').FeishuCardPayload): boolean {
        // Redirect to the awaitable variant.
        void this.sendCardNow(sessionId, card);
        return this.sessionChats.has(sessionId) && (this.sessionChats.get(sessionId)?.length ?? 0) > 0;
    }

    /**
     * Resolve the first chat currently speaking in a session (used to target
     * outbound message operations like delete/pin/update at the Feishu chat the
     * agent is talking to). Returns undefined when the session has no active
     * chat or the chat is not a Feishu DM/group we can address.
     */
    getActiveTarget(sessionId: string): { conversationId: string } | undefined {
        const chats = this.sessionChats.get(sessionId);
        if (chats === undefined || chats.length === 0) return undefined;
        const chat = chats[0];
        if (chat === undefined) return undefined;
        return { conversationId: chat.target.id };
    }

    /** Dispose the router: drop state. (Adapter disposal is the caller's job.) */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.offSessionEvent();
        this.seenMessages.clear();
        this.sessionChats.clear();
    }
}
