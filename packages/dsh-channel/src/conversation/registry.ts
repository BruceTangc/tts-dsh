/**
 * DSH Channel — ConversationRegistry: the single authoritative
 * conversation→session mapping for the Channel layer.
 *
 * Ownership (minimal build):
 *  - explicit `channelMap` config (operator-authorized, highest priority)
 *  - persisted binding (`channel-bindings.conversation_sessions`)
 *
 * Bindings are read-only here: the operator maintains them by editing
 * `channelMap` or the persisted store. The router delegates resolution here
 * and never keeps its own second mapping.
 *
 * @module dsh-channel/conversation/registry
 */
import type { ConversationKey } from '../contract/channel.ts';
import type { ChannelBindingStore, ConversationSessionRecord } from '../policy/channel-domain.ts';
import type { ChannelChatBinding } from '../types/channel.ts';
import { conversationFileKey } from './keys.ts';

export interface ConversationRegistryOptions {
    /** Explicit channelMap from config (V1). Values are session ids or bindings. */
    channelMap?: Readonly<Record<string, string | ChannelChatBinding>>;
    /** Persisted binding store. */
    store: ChannelBindingStore;
}

/** Where a resolved session id came from. */
export type ConversationBindingSource = 'explicit' | 'bound';

export interface ConversationRegistry {
    readonly persistent: boolean;
    /**
     * Resolve a conversation to its session id from the explicit map, then the
     * persisted binding. Returns undefined when nothing maps the conversation.
     */
    lookup(conversation: ConversationKey): { sessionId: string; source: ConversationBindingSource } | undefined;
    /**
     * Legacy lookup by the V1 plain string key (`platform:chatId`) — messages
     * that carry no V2 conversation key still match the explicit channelMap.
     */
    lookupLegacy(key: string): { sessionId: string; source: ConversationBindingSource } | undefined;
}

export function createConversationRegistry(options: ConversationRegistryOptions): ConversationRegistry {
    const explicit = new Map<string, string>();
    for (const [key, value] of Object.entries(options.channelMap ?? {})) {
        explicit.set(key, typeof value === 'string' ? value : value.sessionId);
    }

    return {
        persistent: options.store.persistent,
        lookup(conversation) {
            // 1. explicit channelMap (operator-authorized, highest priority).
            const mapped = explicit.get(conversationFileKey(conversation));
            if (mapped !== undefined) return { sessionId: mapped, source: 'explicit' };
            // 2. persisted binding.
            const stored = options.store.getConversationSession(conversation);
            if (stored !== undefined) return { sessionId: stored.sessionId, source: 'bound' };
            return undefined;
        },
        lookupLegacy(key) {
            const mapped = explicit.get(key);
            if (mapped !== undefined) return { sessionId: mapped, source: 'explicit' };
            return undefined;
        },
    };
}
