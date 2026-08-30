/**
 * DSH Channel — Feishu message helpers: a shared SDK client, the media
 * downloader, the message operations (recall/update/pin/reaction), card
 * construction, and Unicode→emoji_type mapping.
 *
 * @module dsh-channel/feishu-message
 */
import { AppType, Client, Domain } from '@larksuiteoapi/node-sdk';

import type { FeishuCardPayload } from './contract/channel.ts';
import type { FeishuChannelConfig } from './adapters/feishu.ts';

/** Build a Feishu domain-scoped SDK client. */
export function createFeishuClient(config: FeishuChannelConfig): Client {
    const domain = config.larkDomain ? Domain.Lark : Domain.Feishu;
    return new Client({
        appId: config.appId as string,
        appSecret: config.appSecret as string,
        appType: AppType.SelfBuild,
        domain,
    });
}

/**
 * Build the Feishu resource downloader used to ingest inbound media
 * (`GET /open-apis/im/v1/messages/{message_id}/resources/{file_key}`).
 */
export function createFeishuDownloader(config: FeishuChannelConfig) {
    const client = createFeishuClient(config);
    return async (messageId: string, fileKey: string, messageType: string | undefined): Promise<Uint8Array | undefined> => {
        const type = messageType === 'image' ? 'image' : messageType === 'audio' ? 'audio' : 'file';
        try {
            const resource = (client.im as never as { messageResource: { get(args: unknown): Promise<{ getReadableStream(): import('node:stream').Readable }> } }).messageResource;
            const resp = await resource.get({
                path: { message_id: messageId, file_key: fileKey },
                params: { type },
            });
            // The SDK returns a stream handle (not JSON): read the resource bytes.
            const stream = resp.getReadableStream();
            const chunks: Buffer[] = [];
            for await (const chunk of stream) {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
                chunks.push(buffer);
            }
            return new Uint8Array(Buffer.concat(chunks));
        } catch (error) {
            console.warn(`channel: feishu media download failed: ${String(error)}`);
            return undefined;
        }
    };
}

/**
 * Feishu message operations (recall/update/pin/reaction) wrap the official
 * `im.message` / `im.pin` / `im.messageReaction` clients.
 */
export interface FeishuMessageOps {
    delete(messageId: string): Promise<string>;
    update(messageId: string, content: string): Promise<string>;
    pin(messageId: string): Promise<string>;
    addReaction(messageId: string, emoji: string): Promise<string>;
}

/** Feishu message operations (delete/patch/pin/reaction). */
export function createFeishuMessageOps(config: FeishuChannelConfig): FeishuMessageOps {
    const client = createFeishuClient(config);
    const del = (client.im.message as never as { delete(args: unknown): Promise<unknown> }).delete;
    const patch = (client.im.message as never as { patch(args: unknown): Promise<unknown> }).patch;
    const pin = (client.im.pin as never as { create(args: unknown): Promise<unknown> }).create;
    const reactionCreate = (client.im.messageReaction as never as { create(args: unknown): Promise<unknown> }).create;

    return {
        async delete(messageId: string): Promise<string> {
            try {
                await del({ path: { message_id: messageId } });
                return `message has been recalled successfully (${messageId})`;
            } catch (error) {
                return `recall failed: ${String(error)}`;
            }
        },
        async update(messageId: string, content: string): Promise<string> {
            try {
                await patch({
                    path: { message_id: messageId },
                    data: { content },
                });
                return `message card updated successfully (${messageId})`;
            } catch (error) {
                return `update failed: ${String(error)}`;
            }
        },
        async pin(messageId: string): Promise<string> {
            try {
                await pin({ data: { message_id: messageId } });
                return `message pinned successfully (${messageId})`;
            } catch (error) {
                return `pin failed: ${String(error)}`;
            }
        },
        async addReaction(messageId: string, emoji: string): Promise<string> {
            try {
                await reactionCreate({
                    path: { message_id: messageId },
                    data: { reaction_type: { emoji_type: emoji } },
                });
                return `reaction ${emoji} added to message ${messageId}`;
            } catch (error) {
                return `reaction failed: ${String(error)}`;
            }
        },
    };
}

/**
 * Build a Feishu interactive message card (schema 2.0) from a title, markdown
 * body, and optional button labels.
 */
export function buildFeishuCard(headerTitle: string, markdown: string, buttons?: string[]): FeishuCardPayload {
    const elements: unknown[] = [];
    if (markdown !== '') {
        elements.push({ tag: 'markdown', content: markdown });
    }
    if (buttons !== undefined && buttons.length > 0) {
        for (const label of buttons) {
            elements.push({ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: label }, type: 'default', value: {} }] });
        }
    }
    return {
        schema: '2.0',
        header: {
            title: { tag: 'plain_text', content: headerTitle },
            template: 'blue',
        },
        body: { elements },
    };
}

/** Map common Unicode emoji to Feishu emoji_type keys; passes through otherwise. */
const UNICODE_EMOJI_MAP: Record<string, string> = {
    '👍': 'THUMBSUP', '👎': 'ThumbsDown', '❤️': 'HEART', '💛': 'HEART', '💙': 'HEART',
    '😂': 'LAUGH', '😅': 'SWEAT', '😊': 'BLUSH', '🙂': 'SMILE', '😀': 'SMILE',
    '😄': 'JOYFUL', '😁': 'JOYFUL', '🤣': 'LAUGH', '😭': 'SOB', '😢': 'TEARS',
    '😡': 'ANGRY', '🔥': 'Fire', '🎉': 'PARTY', '🎂': 'CAKE', '🎁': 'GIFT',
    '✅': 'DONE', '❌': 'ERROR', '👍🏻': 'THUMBSUP',
};

/** Convert a Unicode emoji to a Feishu emoji_type key; passes ASCII keys through. */
export function unicodeToEmojiType(emoji: string): string {
    if (emoji.trim() === '') return emoji;
    // Already an emoji_type key (uppercase or mixed ASCII).
    if (/^[A-Za-z_]+$/.test(emoji.trim())) return emoji.trim();
    return UNICODE_EMOJI_MAP[emoji.trim()] ?? emoji;
}
