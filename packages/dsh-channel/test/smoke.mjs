/**
 * Smoke test for the minimal dsh-channel plugin against the BUILT lib output.
 *
 * Exercises, with a real Cordis `Context` and stubbed agent/adapter services
 * (no DSH host running):
 *   1. Config schema validation (channelMap + both adapter blocks).
 *   2. Router inbound: mapped chat -> live agent followup with a channel source.
 *   3. Router ignores unbound chats and not-live sessions.
 *   4. Router outbound: assistant/message event -> adapter send.
 *   5. Feishu adapter long-connection lifecycle (injected WS stub).
 *   6. Telegram adapter polling lifecycle + send (injected bot stub).
 *
 * Run: node test/smoke.mjs  (expect "smoke: OK")
 */
import { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';

const {
    Config,
    ChannelRouter,
    createConversationRegistry,
    openChannelBindings,
    createFeishuAdapter,
    createTelegramAdapter,
} = await import('../lib/index.js');

let failed = 0;
function check(label, ok, detail = '') {
    if (ok) {
        console.log(`  ok  ${label}`);
    } else {
        failed += 1;
        console.error(`FAIL  ${label}${detail ? `: ${detail}` : ''}`);
    }
}

// ---- 1. Config schema ----------------------------------------------------
const cfg = Config({
    channelMap: { 'telegram:12345': 'session-1' },
    feishu: { appId: 'cli_x', appSecret: 's' },
    telegram: { token: '111:AAA' },
});
check('Config validates channelMap + adapter blocks',
    cfg.channelMap['telegram:12345'] === 'session-1'
    && cfg.feishu?.appId === 'cli_x' && cfg.telegram?.token === '111:AAA');
const minimal = Config({});
check('Config validates minimal config (defaults)',
    minimal.channelMap === undefined || Object.keys(minimal.channelMap).length === 0);

// ---- 2-4. Router ---------------------------------------------------------
const ctx = new Context();
const { store } = await openChannelBindings(new Context()); // in-memory (no storage domain)
const registry = createConversationRegistry({
    channelMap: {
        'telegram:12345': 'session-1',
        'telegram:55555': 'session-dead',
    },
    store,
});

const sentOut = [];
const adapters = {
    telegram: {
        platform: 'telegram',
        accountKey: { platform: 'telegram', accountId: 'tg-111' },
        capabilities: ['text'],
        supports: () => true,
        async start() {},
        async stop() {},
        async send(conversation, request) {
            sentOut.push([conversation.conversationId, request.text]);
            return { messageId: '1' };
        },
    },
};

const router = new ChannelRouter({ ctx, registry, adapters });

let followed = null;
ctx.agents = {
    get(id) {
        return id === SessionId('session-1')
            ? { followup: (message) => { followed = message; } }
            : undefined;
    },
};

const routed = await router.dispatchInbound({
    platform: 'telegram',
    target: { id: '12345', key: { platform: 'telegram', accountId: 'tg-111', conversationId: '12345' } },
    senderId: 'u1',
    senderName: 'Alice',
    text: 'hello from telegram',
    nativeMessageId: 'm1',
});
check('Router routes mapped chat to session', routed === SessionId('session-1'));
check('Agent received a user message', followed !== null && followed.role === 'user'
    && followed.content?.[0]?.type === 'text' && followed.content[0].text === 'hello from telegram');
check('User message carries channel source', followed?.source?.kind === 'channel'
    && followed.source.platform === 'telegram' && followed.source.chatId === '12345');

const routedUnbound = await router.dispatchInbound({
    platform: 'telegram',
    target: { id: '99999', key: { platform: 'telegram', accountId: 'tg-111', conversationId: '99999' } },
    senderId: 'u2',
    text: 'ignored',
});
check('Unbound chat ignored', routedUnbound === undefined && followed?.content?.[0]?.text === 'hello from telegram');

const routedDead = await router.dispatchInbound({
    platform: 'telegram',
    target: { id: '55555', key: { platform: 'telegram', accountId: 'tg-111', conversationId: '55555' } },
    senderId: 'u3',
    text: 'dead session',
    nativeMessageId: 'm3',
});
check('Bound but not-live session ignored', routedDead === undefined);

// Duplicate delivery within TTL is dropped.
const routedDup = await router.dispatchInbound({
    platform: 'telegram',
    target: { id: '12345', key: { platform: 'telegram', accountId: 'tg-111', conversationId: '12345' } },
    senderId: 'u1',
    text: 'hello from telegram',
    nativeMessageId: 'm1',
});
check('Duplicate native message id ignored', routedDup === undefined);

// Outbound: assistant steps accumulate; the LAST one with text (the final
// reply) is flushed at turn/end. Intermediate thinking steps are not sent.
sentOut.length = 0;
ctx.emit('session/event', { id: SessionId('session-1') }, {
    type: 'assistant/message',
    surfaceOp: 'append',
    data: { message: { content: [{ type: 'text', text: '让我查一下...' }, { type: 'tool-call', id: 'c1', name: 'x', arguments: '{}' }] } },
});
ctx.emit('session/event', { id: SessionId('session-1') }, {
    type: 'assistant/message',
    surfaceOp: 'append',
    data: { message: { content: [{ type: 'tool-call', id: 'c2', name: 'y', arguments: '{}' }] } },
});
ctx.emit('session/event', { id: SessionId('session-1') }, {
    type: 'assistant/message',
    surfaceOp: 'append',
    data: { message: { content: [{ type: 'text', text: 'reply text' }] } },
});
await new Promise((r) => setTimeout(r, 10));
check('Intermediate assistant text not sent before turn/end', sentOut.length === 0);
ctx.emit('session/event', { id: SessionId('session-1') }, {
    type: 'turn/end',
    data: { reason: 'end_turn' },
});
await new Promise((r) => setTimeout(r, 10));
check('Only the final assistant text is sent at turn/end',
    sentOut.length === 1 && sentOut[0][0] === '12345' && sentOut[0][1] === 'reply text');

router.dispose();

// ---- 5. Feishu adapter long-connection (stubbed WS) ----------------------
const feishu = createFeishuAdapter(
    { appId: 'cli_x', appSecret: 's' },          // mode defaults to 'long-connection'
    {
        accountId: 'cli_x',
        dispatchInbound: () => Promise.resolve(),
        serverRegister: (route) => { return () => {}; },
        runtime: { wsClient: stubWsClient() },
    },
);
const wsCalls = [];
function stubWsClient() {
    return {
        start: async ({ eventDispatcher }) => { wsCalls.push(['start', typeof eventDispatcher]); },
        close: () => { wsCalls.push(['close']); },
    };
}
await feishu.start();
check('Feishu long-connection calls wsClient.start with the dispatcher',
    wsCalls.some(([op, dt]) => op === 'start' && dt === 'object'));
feishu.dispose();
check('Feishu long-connection dispose closes the ws client', wsCalls.some(([op]) => op === 'close'));

// ---- 6. Telegram adapter polling (stubbed bot) ---------------------------
const lifecycle = [];
const botApiCalls = [];
const stubBot = {
    on: (event, handler) => { void event; void handler; }, // registration only
    start: async () => { lifecycle.push('start'); },
    stop: async () => { lifecycle.push('stop'); },
    api: {
        sendMessage: async (chatId, text) => {
            botApiCalls.push([chatId, text]);
            return { message_id: 9, chat: { id: Number(chatId) }, date: 0, text };
        },
    },
};
const telegram = createTelegramAdapter(
    { token: '111:AAA' },                          // mode defaults to 'polling'
    {
        accountId: 'tg-111',
        dispatchInbound: () => Promise.resolve(),
        serverRegister: (route) => { return () => {}; },
        runtime: { bot: stubBot },
    },
);
await telegram.start();
check('Telegram polling calls bot.start() on start()', lifecycle.includes('start'));
await telegram.accountAdapter.send(
    { platform: 'telegram', accountId: 'tg-111', conversationId: '-100555' },
    { text: 'reply' },
);
check('Telegram send posts via bot.api.sendMessage',
    botApiCalls.length === 1 && botApiCalls[0][0] === '-100555' && botApiCalls[0][1] === 'reply');
telegram.dispose();
await new Promise((r) => setTimeout(r, 10));
check('Telegram polling dispose stops the bot', lifecycle.includes('stop'));

// ---- cleanup -------------------------------------------------------------
await ctx.dispose?.();

if (failed > 0) {
    console.error(`smoke: ${failed} check(s) FAILED`);
    process.exit(1);
}
console.log('smoke: OK');
