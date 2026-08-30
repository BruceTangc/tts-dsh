/**
 * Shared type surface for the DSH Channel plugin.
 *
 * V1 (below) keeps the historical single-account adapter surface working; the
 * V2 {@link AccountAdapter} contract in `../contract/channel.ts` supersedes it
 * for new accounts. The bridge in `../core/service.ts` maps a V2 account to
 * the V1 {@link ChannelAdapter} shape so the router and existing consumers keep
 * working unchanged.
 *
 * The plugin relays messages between external chat platforms (Feishu, Telegram
 * today) and DSH agents. It deliberately does NOT run an LLM: Agent/LLM
 * execution stays in the DSH runtime; this plugin only feeds inbound user
 * messages into an existing DSH agent and forwards the agent's session events
 * back out to the platform.
 *
 * @module dsh-channel/types
 */
import type { AccountKey, ChannelMediaRef, ConversationKey } from '../contract/channel.ts';

export type { AccountKey, ChannelMediaRef, ConversationKey } from '../contract/channel.ts';

/** A platform the plugin can relay through. Extend as adapters are added. */
export type PlatformId = 'telegram' | 'feishu';

/**
 * One explicit chat→session binding. The value of a `channelMap` entry: a
 * bare session id (the compact form) or this object to also pin the agent
 * preset / model for that particular chat.
 */
export interface ChannelChatBinding {
    /** The DSH session id this chat maps to. */
    sessionId: string;
    /** Agent preset name for THIS chat (overrides `autoCreateOptions.agentPreset`). */
    agentPreset?: string;
    /** Model provider for this chat (overrides `autoCreateOptions.provider`). */
    provider?: string;
    /** Model id for this chat (overrides `autoCreateOptions.model`). */
    model?: string;
    /** Max output tokens for this chat (overrides `autoCreateOptions.maxTokens`). */
    maxTokens?: number;
}

/**
 * Tabular conversation identity in V1 shape: the stable address of a
 * conversation, plus a reference to the owning account and the equivalent
 * V2 {@link ConversationKey}. The router uses {@link ChannelTarget.key} as the
 * first-class conversation identity rather than re-assembling `platform/chatId`.
 */
export interface ChannelTarget {
    /**
     * Stable, platform-specific string address of the conversation to reply
     * into (Telegram chat id, Feishu open_id/chat_id). Kept for V1 consumers.
     */
    readonly id: string;
    /** Optional extra platform-specific reply context (e.g. thread/message id). */
    readonly replyTo?: string;
    /** The v2 first-class conversation identity (always present in V2 flow). */
    readonly key?: ConversationKey;
    /** The account this conversation belongs to. */
    readonly account?: AccountKey;
    /** Conversation kind, when the adapter parsed it (drives P2 policy). */
    readonly kind?: 'dm' | 'group' | 'topic';
}

/** A normalized inbound message from a platform (V1 shape, text-first). */
export interface ChannelInboundMessage {
    /** Which adapter surfaced this message. */
    readonly platform: PlatformId;
    /** The conversation this message arrived in (used to reply). */
    readonly target: ChannelTarget;
    /** The sender's stable platform id (for attribution in the DSH session). */
    readonly senderId: string;
    /** The sender's display name, when known. */
    readonly senderName?: string;
    /** Plain-text payload of the message. */
    readonly text: string;
    /** The platform-native message id, when the sender may later reply to it. */
    readonly nativeMessageId?: string;
    /** Optional parsed media from a V2 adapter (only when the account supports it). */
    readonly media?: readonly ChannelMediaRef[];
    /**
     * Whether the message mentions this bot. P2 group policy requires it;
     * adapters that cannot parse mentions leave it unset (safe default: group
     * requires mention → denied).
     */
    readonly mentionsBot?: boolean;
}

/**
 * A normalized outbound message rendered to a platform (V1 shape). A V2
 * adapter realizes this through its {@link AccountAdapter.send}; media is
 * passed through only when the account declares the capability.
 */
export interface ChannelOutboundMessage {
    /** Non-empty text to send. */
    readonly text: string;
    /** Optional platform-native message to reply to (thread/topic). */
    readonly replyTo?: string;
    /** Optional media attachments. */
    readonly media?: readonly ChannelMediaRef[];
    /** Optional Feishu interactive message card. */
    readonly card?: import('../contract/channel.ts').FeishuCardPayload;
}

/**
 * Provenance attached to inbound user messages this plugin feeds into a DSH
 * agent. Registered as a merge-extensible entry of `MessageSourceMap`, so the
 * agent's durable transcript records *which channel* a message came from.
 */
export interface ChannelMessageSource {
    readonly kind: 'channel';
    /** The platform the message arrived on. */
    readonly platform: PlatformId;
    /** The conversation on that platform (used to route replies back). */
    readonly chatId: string;
    /** The sender's stable platform id. */
    readonly senderId: string;
    /** The sender's display name, when known. */
    readonly senderName?: string;
}

declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        channel: ChannelMessageSource;
    }
}

/** What the core asked an adapter to do with an inbound message. */
export type InboundDisposition =
    /** The message was handed to a DSH agent; the adapter may reply 200. */
    | { readonly kind: 'accepted' }
    /** The message was dropped (unknown chat, disabled, etc.). */
    | { readonly kind: 'ignored' };

/**
 * Adapter contract. Each platform implements this so the core can route
 * through it without platform knowledge. Adapters are expected to:
 *
 *  - register their webhook receive route(s) on `ctx.webServer.register(...)`,
 *  - parse/normalize inbound platform messages into {@link ChannelInboundMessage}
 *    and hand them to the core's `dispatchInbound(...)`,
 *  - implement {@link ChannelAdapter.send} to push outbound text to the target.
 */
export interface ChannelAdapter {
    /** The platform this adapter serves. */
    readonly platform: PlatformId;
    /**
     * Push one outbound message to a target conversation.
     * @param target - where to send.
     * @param message - what to send (text, optional reply target).
     */
    send(target: ChannelTarget, message: ChannelOutboundMessage): Promise<void>;
}
