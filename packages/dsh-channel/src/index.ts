/**
 * DSH Channel plugin: bidirectional message relay between external chat
 * platforms and DSH agents.
 *
 * Scope (minimal build):
 *  - Feishu (long-connection/webhook) and Telegram (polling/webhook) adapters
 *    keep the FULL official capabilities (media, reply, reconnect).
 *  - Inbound messages are delivered to a BOUND session only (`channelMap` or
 *    the persisted `channel_bindings` store); no auto-create, no pairing policy.
 *  - Agent output (`session/event` assistant/message) is forwarded back to the
 *    chats that have spoken in the session; markdown tables in replies are
 *    auto-rendered as Feishu cards.
 *  - Feishu message flaunting tools (card/table send, recall/update/pin,
 *    reaction) are model-callable.
 *
 * @module dsh-channel
 */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-attachment';
import type {} from '@deepseek-ai/dsh-tools';

import { ChannelRouter } from './core/router.ts';
import { createConversationRegistry } from './conversation/registry.ts';
import { openChannelBindings } from './policy/channel-domain.ts';
import { createTelegramAdapter, type TelegramCredentials } from './adapters/telegram.ts';
import { createFeishuAdapter } from './adapters/feishu.ts';
import type { AccountAdapter } from './contract/channel.ts';
import type { PlatformId } from './types/channel.ts';
import { Config, type ChannelConfig, type FeishuChannelConfig } from './config.ts';
import { createFeishuDownloader } from './feishu-message.ts';
import { registerFeishuTools } from './feishu-tools.ts';

/** Stable Cordis plugin name. */
export const name = 'channel';

/** Services the plugin requires before it can load. */
export const inject = ['webServer', 'agents', 'sessions', 'attachments', 'tools'];

declare module '@deepseek-ai/cordis' {
    interface Events {
        /**
         * A normalized inbound message was dispatched by an adapter.
         * @param message - the normalized payload.
         * @param sessionId - the DSH session the message was routed to, when routed.
         * @mode emit
         */
        'channel/inbound'(message: import('./types/channel.ts').ChannelInboundMessage, sessionId: import('@deepseek-ai/dsh-session').SessionId | undefined): void;
    }
}

/**
 * Plugin body: open the binding store, wire the router, mount the platform
 * adapters, and register the Feishu model tools.
 */
export async function apply(ctx: Context, config: ChannelConfig): Promise<void> {
    const { store: bindingsStore, persistent: bindingsPersistent } = await openChannelBindings(ctx);
    const registry = createConversationRegistry({ channelMap: config.channelMap, store: bindingsStore });

    const adapters: Partial<Record<PlatformId, AccountAdapter>> = {};
    const router = new ChannelRouter({ ctx, registry, adapters, mediaRoot: config.mediaRoot });
    const disposers: Array<() => void> = [];

    ctx.logger.info(bindingsPersistent
        ? 'channel: channel-bindings backed by DSH storage domain (persistent)'
        : 'channel: channel-bindings IN-MEMORY (bindings do not survive restarts)');

    // ── Telegram adapter (full: polling/webhook + text/media) ──────────────
    if (config.telegram !== undefined && config.telegram.token !== undefined && config.telegram.token.length > 0) {
        const telegram = createTelegramAdapter(config.telegram as TelegramCredentials, {
            accountId: `tg-${config.telegram.token.split(':')[0]}`,
            dispatchInbound: (message) => router.dispatchInbound(message),
            serverRegister: (route) => ctx.webServer.register(route),
        });
        adapters.telegram = telegram.accountAdapter;
        disposers.push(() => telegram.dispose());
        void telegram.start().then(
            () => ctx.logger.info('channel: telegram adapter started'),
            (err) => ctx.logger.warn(`channel: telegram adapter start failed: ${String(err)}`),
        );
    }

    // ── Feishu adapter (full: long-connection/webhook + text/media) ────────
    if (config.feishu !== undefined && config.feishu.appId !== undefined && config.feishu.appId.length > 0
        && config.feishu.appSecret !== undefined && config.feishu.appSecret.length > 0) {
        const feishuCfg = config.feishu as FeishuChannelConfig;
        const feishu = createFeishuAdapter(
            { ...feishuCfg, appId: feishuCfg.appId as string, appSecret: feishuCfg.appSecret as string },
            {
                accountId: feishuCfg.appId as string,
                dispatchInbound: (message) => router.dispatchInbound(message),
                serverRegister: (route) => ctx.webServer.register(route),
                downloadMedia: createFeishuDownloader(feishuCfg),
                ...(feishuCfg.autoReceiveReaction === undefined ? {} : { autoReceiveReaction: feishuCfg.autoReceiveReaction }),
            },
        );
        adapters.feishu = feishu.accountAdapter;
        disposers.push(() => feishu.dispose());
        // Clear the auto-acknowledgment reaction once the agent has replied.
        router.setClearAutoReaction((platform, chatId) =>
            platform === 'feishu' ? feishu.clearAutoReaction(chatId) : Promise.resolve(),
        );
        void feishu.start().then(
            () => ctx.logger.info('channel: feishu adapter started'),
            (err) => ctx.logger.warn(`channel: feishu adapter start failed: ${String(err)}`),
        );

        // Feishu model tools (card/table send, recall/update/pin, reaction).
        disposers.push(...registerFeishuTools(ctx, router, { ...feishuCfg, appId: feishuCfg.appId as string, appSecret: feishuCfg.appSecret as string }));
    }

    // Register a disposer on the fiber so unload tears the router and adapters
    // down in order.
    ctx.effect(() => {
        return () => {
            router.dispose();
            for (const dispose of disposers) dispose();
            void bindingsStore.close();
        };
    }, 'channel: dispose router and adapters');
}

export { ChannelRouter, chatKey } from './core/router.ts';
export { createConversationRegistry, type ConversationRegistry } from './conversation/registry.ts';
export { openChannelBindings, channelBindingsSpec, type ChannelBindingStore } from './policy/channel-domain.ts';
export { createTelegramAdapter, type TelegramChannelConfig, type TelegramCredentials } from './adapters/telegram.ts';
export { createFeishuAdapter, type FeishuChannelConfig } from './adapters/feishu.ts';
export { Config, type ChannelConfig } from './config.ts';
export { buildFeishuCard, createFeishuMessageOps, createFeishuDownloader, unicodeToEmojiType, type FeishuMessageOps } from './feishu-message.ts';
export { registerFeishuTools } from './feishu-tools.ts';
export { buildTableCard, extractMarkdownTable, extractAllMarkdownTables, splitTablesFromText, containsCodeBlock, buildCodeBlockCards, chunkLongText, FEISHU_TEXT_CHUNK_LIMIT, MAX_TABLES_PER_CARD } from './table.ts';
export type {
    AccountAdapter,
    AccountKey,
    ConversationKey,
    NormalizedMessage,
    OutboundRequest,
} from './contract/channel.ts';
export type {
    ChannelAdapter,
    ChannelChatBinding,
    ChannelInboundMessage,
    ChannelOutboundMessage,
    ChannelTarget,
    PlatformId,
} from './types/channel.ts';

export default { name, Config, inject, apply };
