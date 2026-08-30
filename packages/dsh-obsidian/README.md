# dsh-obsidian

Direct **Obsidian vault** access tools for DeepSeek Harness (DSH) agents.

No Obsidian desktop app and no Agent Client Protocol needed: an Obsidian vault
is just a local directory of markdown notes, and this plugin registers
`obsidian_*` tools that let DSH agents **read / write / append / list / search**
notes inside it. Point the plugin at your vault folder and the agent can use it
as a knowledge base.

## Tools

| Tool | Args | Behavior |
|---|---|---|
| `obsidian_read_note` | `path` | Read a note's markdown content. |
| `obsidian_write_note` | `path`, `content` | Create/overwrite a note (creates parent folders). |
| `obsidian_append_note` | `path`, `content` | Append to a note (creates it if missing). |
| `obsidian_list_notes` | `path?` | List markdown notes (recursive, sorted). |
| `obsidian_search` | `query`, `limit?` | Case-insensitive content search with snippets. |

All `path` values are vault-relative (`Projects/Ideas.md`). Every operation is
checked against the vault root — paths that escape the vault (`..`, drive
paths) are rejected.

## Install

Add to the profile patch layer (`cordis.patch.yml`):

```yaml
- insert:
    - id: obsidian
      name: '@dsh/obsidian'
      config:
        vaultPath: 'D:\\ObsidianVault'
```

| Field | Meaning |
| --- | --- |
| `vaultPath` | Absolute path of the Obsidian vault directory (required). |

If the plugin is linked from a checkout (junction), rebuild after edits:

```sh
pnpm install
pnpm build      # emits lib/ (ESM)
pnpm test       # offline smoke test against a temp vault
```

## Using the vault with Obsidian (optional)

If you later open the same folder in the Obsidian desktop app, it becomes a
real vault (`.obsidian/` config is created on first open). The plugin works on
the folder regardless — Obsidian is only needed if you want the app's UI.

## License

MIT
