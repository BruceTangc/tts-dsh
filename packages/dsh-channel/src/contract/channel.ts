/**
 * V2 Channel Contract — the platform-neutral type layer for the DSH Channel
 * plugin.
 *
 * This contract is deliberately free of DSH Core dependencies: it only models
 * the *external world* the plugin manages (accounts, identities,
 * conversations, normalized messages, capabilities, lifecycle), so any
 * adapter, policy, or routing layer can be built against it in isolation.
 *
 * Key first-class identities:
 *  - {@link AccountKey}   — one connected account on a platform
 *                          (`platform:accountId`).
 *  - {@link ConversationKey} — one named conversation reachable through an
 *                          account (`platform:accountId:conversationId`).
 * Modules MUST use these keys and MUST NOT hand-assemble `platform/chatId`
 * strings themselves.
 *
 * @module dsh-channel/contract
 */

/** A platform the plugin can relay through. Extend as adapters are added. */
export type PlatformId = 'telegram' | 'feishu';

/** Rough kind of a conversation, driving platform-specific policy. */
export type ConversationKind = 'dm' | 'group' | 'topic';

/**
 * Stable identity of one connected account on a platform. E.g.
 * `{ platform: 'telegram', accountId: 'bot_123456789' }`.
 * `accountId` is the bot/application identity (Telegram bot username or id,
 * Feishu app id).
 */
export interface AccountKey {
    readonly platform: PlatformId;
    readonly accountId: string;
}

/**
 * Stable identity of one conversation reachable through an account.
 * E.g. `{ platform: 'telegram', accountId: 'bot_123456789', conversationId: 'chat_42' }`.
 * For groups a trailing `threadId` (topic/thread) further refines it.
 */
export interface ConversationKey {
    readonly platform: PlatformId;
    readonly accountId: string;
    readonly conversationId: string;
    /** Optional thread/topic within the conversation (Telegram forum topic, Feishu thread). */
    readonly threadId?: string;
}

/** Canonical string form of an {@link AccountKey} (`platform:accountId`). */
export function accountKeyToString(key: AccountKey): string {
    return `${key.platform}:${key.accountId}`;
}

/** Canonical string form of a {@link ConversationKey} (`platform:accountId:conversationId[#threadId]`). */
export function conversationKeyToString(key: ConversationKey): string {
    const base = `${key.platform}:${key.accountId}:${key.conversationId}`;
    return key.threadId === undefined ? base : `${base}#${key.threadId}`;
}

/**
 * Capabilities an {@link AccountAdapter} declares it supports. The router and
 * any outbound pipeline consult these before sending: an account that lacks
 * `message-edit` only ever sends final text; one that lacks `media` never
 * receives media attachments. Additions are additive and harmless to older
 * consumers.
 */
export const Capability = {
    text: 'text',                 // plain text messages (minimum)
    media: 'media',               // images/files/photos
    image: 'image',               // image messages
    file: 'file',                 // raw file/document attachments
    audio: 'audio',               // audio messages
    video: 'video',               // video messages
    voice: 'voice',               // voice notes
    ['message-edit']: 'message-edit', // can edit/replace an already-sent message in place
    typing: 'typing',             // can send "typing…" indicators
    reply: 'reply',               // can reply to a specific message
    thread: 'thread',             // supports threads/topics
    html: 'html',                 // rich text / markup
    reactions: 'reactions',       // emoji reactions (reserved)
    streaming: 'streaming',       // live delta streaming (start/delta/end)
} as const;

export type CapabilityId = typeof Capability[keyof typeof Capability];

/** A media attachment referenced by a normalized message, before DSH ingestion. */
export interface ChannelMediaRef {
    readonly kind: CapabilityId;      // 'media' | 'file' | 'voice'
    readonly mimeType?: string;
    /** Bytes or a local path the adapter materialized for the platform. */
    readonly data: Uint8Array | string;
    readonly fileName?: string;
    readonly size?: number;
}

/** A mention of a peer/account inside a message (drives mention gating). */
export interface ChannelMention {
    /** The mentioned account's id on the platform (or a '@' style handle). */
    readonly id: string;
    /** Name/handle as typed, when available. */
    readonly name?: string;
}

/**
 * A normalized inbound message from a platform. Every adapter produces this
 * shape; the router consumes it. Media/mentions are optional and only present
 * when the adapter parsed them.
 */
export interface NormalizedMessage {
    /** The message id assigned by the originating account (identity + dedup). */
    readonly messageId: string;
    /** Which account received it. */
    readonly account: AccountKey;
    /** Which conversation it arrived in. */
    readonly conversation: ConversationKey;
    /** The sender's stable identity on the platform (open_id / user id / phone). */
    readonly identity: string;
    /** Display name when known. */
    readonly senderName?: string;
    /** Plain-text body (text-only when the adapter strips media). */
    readonly text: string;
    /** Any parsed media attachments (only when the account supports it). */
    readonly media?: readonly ChannelMediaRef[];
    /** Peers/accounts mentioned in the message, when parsed. */
    readonly mentions?: readonly ChannelMention[];
    /** A platform-native message id this one replies to, when present. */
    readonly replyToMessageId?: string;
}

/**
 * One bit of an outbound reply the router wants to send. The adapter decides
 * how to realize it based on its capabilities (edit an earlier message,
 * send new, show typing).
 */
export interface OutboundRequest {
    /** Required plain text. */
    readonly text: string;
    /** Reply into the same conversation's thread, when supported. */
    readonly threadId?: string;
    /** Media attached to this outbound (only when the account declares it). */
    readonly media?: readonly ChannelMediaRef[];
    /**
     * Optional Feishu interactive message card (when the adapter supports it).
     * The object is a Feishu card JSON payload (schema v2). When present with
     * an accompanying `text`, the text is used as a fallback summary.
     */
    readonly card?: FeishuCardPayload;
}

/**
 * A Feishu interactive message card (schema 2.0). The full shape is large;
 * this minimal typing covers the common card forms and preserves unknown
 * fields verbatim so the adapter can forward them.
 */
export interface FeishuCardPayload {
    schema?: string;
    header?: {
        title?: { tag: 'plain_text' | 'md'; content: string };
        template?: string;
        [key: string]: unknown;
    };
    elements?: unknown[];
    config?: Record<string, unknown>;
    i18n?: Record<string, unknown>;
    [key: string]: unknown;
}

/** Result of a policy decision for an inbound message (P2; reserved in V1). */
export type AccessDecision =
    | { readonly kind: 'allow' }
    | { readonly kind: 'deny' }
    | { readonly kind: 'pairing-required' };

/**
 * Lifecycle states a single account connection moves through. Surfaces on
 * `channel/account-status` so operators can observe reconnect/error.
 */
export type AccountLifecycleState =
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'closed'
    | 'error';

/**
 * The V2 adapter contract. One instance per connected account. Implementations
 * own platform SDK connect/disconnect, connection reuse, and per-account
 * lifecycle; the router owns policy + routing and requests outbound through
 * these methods.
 *
 * Adapter authors MUST keep `platform`/`accountId` consistent with the
 * {@link AccountKey} and MUST set `/conversation` on every
 * {@link NormalizedMessage} it dispatches.
 */
export interface AccountAdapter {
    /** The platform this adapter serves. */
    readonly platform: PlatformId;
    /** The stable account identity (bot/app). */
    readonly accountKey: AccountKey;
    /** Declared capabilities (at least `['text']`). */
    readonly capabilities: readonly CapabilityId[];

    /** Helper: does this account support `cap`. */
    supports(cap: CapabilityId): boolean;

    /**
     * Start the connection / long polling / webhook mounting. Resolves when
     * the adapter considers itself healthy enough to receive/send.
     */
    start(): Promise<void>;

    /** Stop the connection and release platform resources. */
    stop(): Promise<void>;

    /**
     * Send an outbound reply to a conversation.
     * @param conversation - where to send.
     * @param request - what to send.
     * @param retryFrom - optional `{ messageId }` of a previously sent message
     *   to EDIT in place when the account supports `message-edit`.
     */
    send(
        conversation: ConversationKey,
        request: OutboundRequest,
        retryFrom?: { readonly messageId: string },
    ): Promise<{ readonly messageId: string }>;
}
