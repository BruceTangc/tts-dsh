/**
 * Account addressing helpers for the V2 Channel plugin. Every payload that
 * reaches the router already carries stable {@link AccountKey} /
 * {@link ConversationKey}; these helpers normalize platform-native ids into
 * those keys so adapters never hand-assemble `platform:chatId` strings.
 *
 * @module dsh-channel/accounts/keys
 */
import type { AccountKey, ConversationKey, PlatformId } from '../contract/channel.ts';

/** Build an account key from a platform id and native account/bot id. */
export function accountKey(platform: PlatformId, accountId: string): AccountKey {
    return { platform, accountId };
}

/** Build a conversation key, defaulting the conversation id when omitted. */
export function conversationKey(
    platform: PlatformId,
    accountId: string,
    conversationId: string,
    threadId?: string,
): ConversationKey {
    return threadId === undefined
        ? { platform, accountId, conversationId }
        : { platform, accountId, conversationId, threadId };
}

/**
 * Derive the concise account label used in logs/config (e.g. Telegram bot
 * username, Feishu app short id) for operators to recognize an account.
 */
export function accountLabel(key: AccountKey): string {
    return key.accountId.length > 24 ? `${key.accountId.slice(0, 10)}…${key.accountId.slice(-8)}` : key.accountId;
}
