# dsh-channel

A DSH (DeepSeek Harness) Cordis plugin that relays messages **bidirectionally**
between external chat platforms and existing DSH agents.

Today it ships **Feishu (Lark)** and **Telegram** adapters. The plugin performs
**no LLM execution**: it feeds inbound messages into an existing bound DSH
session and forwards the agent's **final** output back to the platform.

---

## Scope (minimal, convergence-focused)

- **Bind an existing session and chat with it** from Feishu/Telegram.
  Inbound messages go to a BOUND session only (`channelMap` or the persisted
  `channel_bindings` store) — **no auto-create**.
- **Only the final agent result is relayed.** Intermediate per-step
  `assistant/message` outputs (thinking, tool-call scaffolding) are filtered
  out; the reply is flushed once at `turn/end`.
- **Full official adapters kept**: text, rich text (post), images, files,
  audio, video; reply/reconnect.
- **Markdown tables auto-render as official Feishu cards** (up to 5 per card,
  spilling onto extra cards); long replies auto-chunk at 4000 chars.

---

## Architecture

```
Feishu (long-connection/ws) ─┐
Telegram (polling) ──────────┼─► adapters ─► ChannelRouter ─► bound session (agent.followup)
                             │                    ▲
                             │      session/event firehose (assistant output)
                             ▼                    │
                        adapter.send ◄── turn/end flush (final text only, chunked)
```

| Module | Role |
| --- | --- |
| `src/index.ts` | Cordis plugin: `name`/`Config`/`inject`/`apply`, adapter mounting, disposers. |
| `src/config.ts` | Config schema (`channelMap`, `feishu`, `telegram`, `mediaRoot`). |
| `src/core/router.ts` | Inbound→bound-session routing; outbound `turn/end` flush of final text; tables/chunking. |
| `src/adapters/feishu.ts` | Feishu via `@larksuiteoapi/node-sdk`: receive, reply/quote, media, auto-reaction. |
| `src/adapters/telegram.ts` | Telegram via `grammY`: polling/webhook. |
| `src/feishu-tools.ts` | Model-callable Feishu tools (card/table send, recall/update/pin, reaction). |
| `src/feishu-message.ts` | Feishu client, media downloader, message ops, card builder, emoji mapping. |
| `src/table.ts` | Official Feishu `table` component; markdown table parsing; text chunking. |
| `src/policy/channel-domain.ts` | Persisted `channel_bindings` store (read-only binding lookups). |

---

## Configuration

```yaml
# cordis.patch.yml
- insert:
    - id: channel
      name: '@dsh/channel'
      config:
        channelMap:            # "platform:targetId" -> session id
          'feishu:ou_abc': 'session-2e3f98a1-...'
          'telegram:123456789': 'session-1'
        mediaRoot: 'D:\DSH\data'   # inbound non-image attachments land here
        feishu:
          appId: 'cli_xxxx'
          appSecret: 'xxxx'
          mode: 'long-connection'          # or 'webhook'
          autoReceiveReaction: 'random'    # add a reaction to each inbound msg
        telegram:
          token: '123456789:AAH...'        # mode defaults to 'polling'
```

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `channelMap` | map | `{}` | `"<platform>:<targetId>"` → session id. Unmapped chats are ignored. |
| `mediaRoot` | string | `cwd` | Root for inbound non-image attachments (`channel-attachments/<session>/`). |
| `feishu.mode` | `long-connection \| webhook` | long-connection | No public IP needed for the default. |
| `feishu.autoReceiveReaction` | string | unset | Feishu emoji_type, or `'random'` to auto-react to each inbound message. |
| `telegram.mode` | `polling \| webhook` | polling | No public IP needed for the default. |

---

## Feishu message features

Inbound:
- text, rich text (post), images, files, audio, video (media auto-downloaded).
- **Reply/quote recognition** — when you reply to a message, the referenced
  content is prefixed `[quoting message: …]` so the agent knows what it quoted.
- **Auto-reaction** — optionally adds a reaction (`THUMBSUP`, or random) to
  each inbound message.

Outbound model tools (`ctx.tools`):
| Tool | Function |
| --- | --- |
| `feishu_send_card` | Send an interactive message card. |
| `feishu_send_table` | Send a card with an official `table` component. |
| `feishu_delete_message` | Recall a bot message. |
| `feishu_update_message` | Update a card's content. |
| `feishu_pin_message` | Pin a message. |
| `feishu_add_reaction` | Add an emoji reaction to a message. |

Automatic outbound handling:
- **Final-result-only**: intermediate thinking/tool-call steps are not sent.
- **Long text chunking**: replies > 4000 chars split across messages.
- **Markdown tables → Feishu cards**: up to 5 tables per card (official limit,
  `MAX_TABLES_PER_CARD`), extra tables spill onto more cards; surrounding text
  rides on the same card.

---

## Build & test

```sh
pnpm install
pnpm build        # emits lib/ (ESM)
pnpm test         # node test/smoke.mjs
```

Requires Node ≥ 20 (tested on 24) and TypeScript ≥ 5.8.

## License

MIT
