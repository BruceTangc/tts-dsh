/**
 * DSH Channel — configuration schema and types.
 *
 * @module dsh-channel/config
 */
import z from '@deepseek-ai/schemastery';
import type { TelegramChannelConfig, TelegramCredentials } from './adapters/telegram.ts';
import type { FeishuChannelConfig } from './adapters/feishu.ts';

const TelegramSchema = z.object({
    /** Bot token from BotFather (`123456:ABC-DEF...`). Secret. Empty disables the adapter. */
    token: z.string().role('secret'),
    /**
     * Update delivery: `polling` (default, no public IP needed) or `webhook`
     * (requires a public HTTPS URL + `setWebhook`).
     */
    mode: z.union([z.const('webhook'), z.const('polling')]).default('polling'),
    /** Optional secret token set alongside `setWebhook` (webhook mode); validated via header. */
    secretToken: z.string().role('secret'),
    /** Webhook route path (webhook mode; no trailing slash). Defaults to `/telegram/webhook/<token>`. */
    webhookPath: z.string(),
});

const FeishuSchema = z.object({
    /** Feishu self-built app id (`cli_...`). Empty disables the adapter. */
    appId: z.string(),
    /** Feishu self-built app secret. Secret. Empty disables the adapter. */
    appSecret: z.string().role('secret'),
    /**
     * Event delivery: `long-connection` (default, no public IP needed) or
     * `webhook` (requires a public HTTPS callback URL).
     */
    mode: z.union([z.const('webhook'), z.const('long-connection')]).default('long-connection'),
    /** Event-callback Encrypt Key, when encryption is enabled. Secret. */
    encryptKey: z.string().role('secret'),
    /** Event-callback Verification Token, when set. Secret. */
    verificationToken: z.string().role('secret'),
    /** Event-callback route path (webhook mode; no trailing slash). Defaults to `/feishu/event`. */
    webhookPath: z.string(),
    /** International Lark domain instead of the CN Feishu domain. */
    larkDomain: z.boolean(),
    /** Auto-add this emoji_type reaction to each inbound message (e.g. THUMBSUP), or 'random' to pick from a pool. */
    autoReceiveReaction: z.string().role('secret'),
});

/**
 * Per-chat binding schema for `channelMap`. A map value is either a bare
 * session id string or this object (sessionId pinned).
 */
const ChannelBindingSchema = z.object({
    /** The DSH session id this chat maps to. */
    sessionId: z.string().required(),
});

/** Configuration schema for the channel plugin. */
export const Config: z<ChannelConfig> = z.object({
    /**
     * Explicit `"<platform>:<targetId>"` → session-id map, e.g.
     * `{ "telegram:123456789": "session-1" }`.
     */
    channelMap: z.dict(z.union([z.string(), ChannelBindingSchema])).default({}),
    /** Telegram channel config. Absent/empty disables the Telegram adapter. */
    telegram: TelegramSchema.default(undefined as never),
    /** Feishu channel config. Absent/empty disables the Feishu adapter. */
    feishu: FeishuSchema.default(undefined as never),
    /** Root directory for inbound non-image attachments (`channel-attachments/`). */
    mediaRoot: z.string().default(process.cwd()),
});

/** Validated config shape (mirrors {@link Config}). */
export interface ChannelConfig {
    channelMap: Record<string, string | { sessionId: string }>;
    telegram?: TelegramChannelConfig;
    feishu?: FeishuChannelConfig;
    mediaRoot: string;
}

export type { TelegramChannelConfig, TelegramCredentials, FeishuChannelConfig };
