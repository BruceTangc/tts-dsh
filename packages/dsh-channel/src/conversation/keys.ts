/**
 * Conversation identity key factories — the shared, first-class conversation
 * addressing primitives. Both the ConversationRegistry and the Router depend
 * on these; keeping them here avoids a registry ↔ router import cycle.
 *
 * @module dsh-channel/conversation/keys
 */
import type { ConversationKey } from '../contract/channel.ts';

/** Deterministic session id for an auto-created channel session. */
export function channelSessionId(platform: string, conversationId: string): string {
    const slug = conversationId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 120);
    return `channel-${platform}-${slug}`;
}

/** Legacy chat key (`platform:target.id`) used by V1 config/logging. */
export function chatKey(platform: string, target: { readonly id: string }): string {
    return `${platform}:${target.id}`;
}

/** V2 conversation file key (`platform:conversationId`) for explicit channelMap. */
export function conversationFileKey(conversation: ConversationKey): string {
    return `${conversation.platform}:${conversation.conversationId}`;
}
