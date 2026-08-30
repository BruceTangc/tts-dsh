/**
 * P3 media helpers — bridge platform media into DSH's native attachment
 * system and back out, WITHOUT touching DSH Core.
 *
 * Inbound:
 *  - images → `ctx.attachments.saveImage()` → `ImageAttachmentRef` → an
 *    `ImageBlock` for `createUserMessage`.
 *  - files (non-image) → bytes written under the channel workspace
 *    (`<cwd>/channel-attachments/<sessionId>/<name>`) and surfaced to the
 *    agent as a text path reference.
 *
 * Outbound:
 *  - resolve the account's declared capabilities; when `media` is absent the
 *    caller MUST fall back explicitly (never a silent drop).
 *
 * Validation: size caps and a media-type allowlist live here; the attachment
 * store additionally validates/normalizes images at `saveImage`.
 *
 * @module dsh-channel/core/media
 */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ImageAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment';
import type { Context } from '@deepseek-ai/cordis';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';

import type { CapabilityId, ChannelMediaRef } from '../contract/channel.ts';

/** Max bytes accepted for an inbound channel media item (default 20 MiB). */
export const MAX_CHANNEL_MEDIA_BYTES = 20 * 1024 * 1024;
/** Image media types the attachment store admits (png/jpeg/webp/gif). */
export const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/**
 * Sniff the image media type from magic bytes. Returns undefined for
 * non-image input (the caller handles it as a validation failure).
 */
export function detectImageType(data: Uint8Array): string | undefined {
    if (data.length < 12) return undefined;
    // PNG: 89 50 4E 47
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png';
    // JPEG: FF D8 FF
    if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
    // GIF: 47 49 46 38 ('GIF8')
    if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return 'image/gif';
    // WebP: 'RIFF' .... 'WEBP'
    if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
        && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return 'image/webp';
    return undefined;
}

/** Structured media error so callers can fall back loudly instead of silently. */
export class ChannelMediaError extends Error {
    constructor(
        message: string,
        readonly code: 'download-failed' | 'type-unsupported' | 'size-exceeded' | 'storage-failed',
    ) {
        super(message);
        this.name = 'ChannelMediaError';
    }
}

/** Adapter-produced raw media + destination context for one inbound item. */
export interface InboundMediaItem {
    /** Capability kind: 'media' (image) or 'file'. */
    readonly kind: 'media' | 'file';
    /** Raw bytes to validate/store. */
    readonly data: Uint8Array;
    /** Declared media type (image/* for images). */
    readonly mimeType?: string;
    /** Display name (stripped of path later). */
    readonly name?: string;
}

/** Result of ingesting one inbound media item into the plugin's/DSH's stores. */
export type IngestedMedia =
    /** An image committed to the DSH attachment store. */
    | { readonly kind: 'image'; readonly ref: ImageAttachmentRef }
    /** A non-image file committed under the channel workspace. */
    | { readonly kind: 'file'; readonly path: string; readonly name: string; readonly bytes: number };

/**
 * Validate an inbound media item against size and type policy.
 * @throws {@link ChannelMediaError} on violation.
 */
export function validateInboundMedia(item: InboundMediaItem): void {
    if (item.data.byteLength > MAX_CHANNEL_MEDIA_BYTES) {
        throw new ChannelMediaError(`inbound media exceeds ${MAX_CHANNEL_MEDIA_BYTES} bytes`, 'size-exceeded');
    }
    if (item.kind === 'media') {
        if (item.mimeType === undefined || !IMAGE_MEDIA_TYPES.has(item.mimeType)) {
            throw new ChannelMediaError(`unsupported image type ${String(item.mimeType)}`, 'type-unsupported');
        }
    }
}

/**
 * Ingest one validated inbound media item.
 * - image: save to the DSH attachment store → durable `ImageAttachmentRef`.
 * - file: write under `<root>/channel-attachments/<sessionId>/<name>`.
 * @throws {@link ChannelMediaError} when storage fails.
 */
export async function ingestInboundMedia(
    ctx: Context,
    item: InboundMediaItem,
    sessionId: string,
    root: string,
): Promise<IngestedMedia> {
    validateInboundMedia(item);
    if (item.kind === 'media') {
        const attachments = ctx.attachments;
        if (attachments === undefined) {
            throw new ChannelMediaError('DSH attachment service unavailable', 'storage-failed');
        }
        const input: SaveImageAttachment = {
            data: item.data,
            mediaType: item.mimeType as SaveImageAttachment['mediaType'],
            ...(item.name === undefined ? {} : { name: safeName(item.name) }),
        };
        const ref = await attachments.saveImage(input);
        return { kind: 'image', ref };
    }
    // Non-image file: land it under the channel workspace for the agent to read.
    const dir = join(root, 'channel-attachments', sessionId);
    await mkdir(dir, { recursive: true });
    const name = safeName(item.name ?? `file-${randomUUID().slice(0, 8)}`);
    const path = join(dir, name);
    await writeFile(path, item.data);
    return { kind: 'file', path, name, bytes: item.data.byteLength };
}

/** Guard against path traversal / weird names in attachment display names. */
export function safeName(name: string): string {
    const cleaned = name.replace(/[/\\]/g, '_').replace(/^\.+/, '');
    return cleaned.length === 0 ? 'file' : cleaned.slice(0, 200);
}

/** Turn one ingested image ref into a user-message ContentBlock (image). */
export function imageBlock(ref: ImageAttachmentRef): ContentBlock {
    return { type: 'image', attachment: ref };
}

/** Declared capability of an outbound surface for media. */
export function supportsCapability(capabilities: readonly CapabilityId[], cap: CapabilityId): boolean {
    return capabilities.includes(cap);
}
