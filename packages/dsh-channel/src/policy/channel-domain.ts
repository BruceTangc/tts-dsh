/**
 * Channel Bindings Domain (`channel-bindings`, v1).
 *
 * Persistent, schema-validated storage for the channel plugin's durable state.
 * Backed by the DSH storage domain facility (`ctx.storage.domain`) when
 * available; degrades to in-memory tables otherwise (with a loud warning).
 *
 * The minimal channel only READS the `conversation_sessions` table (manual
 * bindings). The identity/pairing/allowlist tables remain in the domain spec
 * purely so an existing domain file opens unchanged; nothing reads them.
 *
 * @module dsh-channel/policy/channel-domain
 */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain';
import { z } from 'zod';

import type { Context } from '@deepseek-ai/cordis';
import { conversationKeyToString, type ConversationKey } from '../contract/channel.ts';

/** Domain format version. Bump (with a migration path) on schema changes. */
export const CHANNEL_BINDINGS_VERSION = 1;

/** Record-level schema version; future migrations read `v` to normalize. */
const RecordV = z.literal(1);

/** A durable conversation→session binding. Key: {@link conversationKeyToString}. */
export const ConversationSessionRecord = z.object({
    v: RecordV,
    sessionId: z.string(),
    platform: z.string(),
    accountId: z.string(),
    conversationId: z.string(),
    threadId: z.string().optional(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
});
export type ConversationSessionRecord = z.infer<typeof ConversationSessionRecord>;

// ── Compatibility tables (declared for the domain spec only; never read) ──
export const IdentityRecord = z.object({
    v: RecordV,
    platform: z.string(),
    accountId: z.string(),
    externalUserId: z.string(),
    displayName: z.string().optional(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
});
export const PairingStatus = z.enum(['pending', 'approved', 'expired', 'revoked']);
export const PairingRecord = z.object({
    v: RecordV,
    code: z.string(),
    platform: z.string(),
    accountId: z.string(),
    externalUserId: z.string(),
    status: PairingStatus,
    createdAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    approvedAt: z.number().int().nonnegative().optional(),
});
export const AllowlistRecord = z.object({
    v: RecordV,
    platform: z.string(),
    accountId: z.string(),
    externalUserId: z.string(),
    enabled: z.boolean(),
    note: z.string().optional(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
});

/** The one channel-bindings domain spec (v1). `channel_bindings` — the Core
 *  `UNIT_NAME_RE` (`^[a-z][a-z0-9_]*$`) forbids hyphens, so the configured
 *  "channel-bindings" name is spelled with an underscore here (semantics unchanged). */
export const channelBindingsSpec = defineDomain({
    name: 'channel_bindings',
    version: CHANNEL_BINDINGS_VERSION,
    tables: {
        conversation_sessions: domainTable(ConversationSessionRecord),
        identities: domainTable(IdentityRecord),
        pairings: domainTable(PairingRecord),
        allowlist: domainTable(AllowlistRecord),
    },
});

/** Minimal storage surface for the router's binding lookups. */
export interface ChannelBindingStore {
    readonly persistent: boolean;
    getConversationSession(conversation: ConversationKey): ConversationSessionRecord | undefined;
    close(): Promise<void>;
}

/**
 * Open the channel-bindings domain on a DSH context. Returns the store with
 * its persistence flag.
 *
 * `ctx.storage` is a Cordis injected service: accessing it on a context that
 * did not inject `storage` throws (and even `?.domain` cannot guard that,
 * because the property access itself throws before `?.` can check). We
 * therefore PROBE for the service without injecting, and only touch
 * `ctx.storage` inside a `ctx.inject` sub-fiber that declares `storage`. When
 * it is absent we warn once and return an in-memory store. The caller owns
 * `close()`.
 */
export async function openChannelBindings(ctx: Context): Promise<{ store: ChannelBindingStore; persistent: boolean }> {
    const hasStorage = Reflect.has(ctx, 'storage');
    if (!hasStorage) {
        ctx.logger.warn('channel: DSH storage service unavailable — channel-bindings fall back to IN-MEMORY (conversation→session bindings will NOT survive restarts)');
        return { store: memoryChannelBindings(), persistent: false };
    }
    try {
        let opened: ChannelBindingStore | undefined;
        await ctx.inject(['storage' as never], async (storageCtx: Context) => {
            const domain = await (storageCtx.storage as unknown as { domain: { open(spec: unknown): Promise<unknown> } }).domain.open(channelBindingsSpec);
            opened = new DomainChannelBindings(domain);
        });
        if (opened !== undefined) return { store: opened, persistent: true };
        ctx.logger.warn('channel: storage injection produced no domain — falling back to IN-MEMORY storage');
        return { store: memoryChannelBindings(), persistent: false };
    } catch (error) {
        ctx.logger.warn(`channel: failed to open channel-bindings domain — falling back to IN-MEMORY storage: ${String(error)}`);
        return { store: memoryChannelBindings(), persistent: false };
    }
}

/** Table handle shape used by the domain-backed store. */
interface RecordTable<V> {
    get(key: string): V | undefined;
}

class DomainChannelBindings implements ChannelBindingStore {
    readonly persistent = true;
    private readonly table: RecordTable<ConversationSessionRecord>;
    private readonly closeDomain: () => Promise<void>;
    private closed = false;

    constructor(domain: unknown) {
        const d = domain as {
            table(name: 'conversation_sessions'): RecordTable<ConversationSessionRecord>;
            close(): Promise<void>;
        };
        this.table = d.table('conversation_sessions');
        this.closeDomain = d.close.bind(d);
    }

    getConversationSession(conversation: ConversationKey): ConversationSessionRecord | undefined {
        return this.table.get(conversationKeyToString(conversation));
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        await this.closeDomain();
    }
}

/** In-memory fallback store (persistent=false). Never writes a second JSON system. */
function memoryChannelBindings(): ChannelBindingStore {
    const conversationSessions = new Map<string, ConversationSessionRecord>();
    return {
        persistent: false,
        getConversationSession(conversation) { return conversationSessions.get(conversationKeyToString(conversation)); },
        async close() {},
    };
}
