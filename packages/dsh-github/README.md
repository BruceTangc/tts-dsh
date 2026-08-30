# dsh-github

A DSH (DeepSeek Harness) Cordis plugin that gives DSH agents **model-facing
GitHub tools** (repositories, issues, pull requests, repository contents,
Actions workflows) over the [GitHub REST API](https://docs.github.com/en/rest),
plus an optional **signed webhook receiver** that feeds GitHub repository
events into a DSH agent session — so the agent can react to issues / PRs /
CI runs and reply back to GitHub through the same tools.

The plugin performs **no LLM execution**. It only calls the GitHub REST API on
the agent's behalf (`ctx.tools.register` + `defineTool`) and injects inbound
webhook events as user messages (`createUserMessage` + `agent.followup`), the
same seam the Web GUI and headless driver use. Agent/LLM execution stays
entirely in the DSH runtime.

Built against the DSH conventions of the installed runtime
(`@deepseek-ai/dsh-tools` `defineTool` registry, Cordis `name`/`Config`/
`inject`/`apply` namespace plugin, schemastery `role('secret')` config,
`ctx.webServer.register` for webhook routes).

---

## Architecture

```
                ┌────────────────────────────────────────────────┐
GitHub REST API ◄── github_* tools (ctx.tools, defineTool) ──────┤ DSH agent
                └────────────────────────────────────────────────┘
                ┌────────────────────────────────────────────────┐
GitHub Webhook ──► /github/webhook (HMAC-SHA256 verified) ──────► │ session
   events          issues / issue_comment / pull_request / push /  │ agent.followup
                   workflow_run / ...  (X-GitHub-Event allowlist)  │ (source: github)
                └────────────────────────────────────────────────┘
```

- **`src/core/client.ts`** — dependency-free GitHub REST client (`fetch`, no
  SDK): Bearer auth, the `X-GitHub-Api-Version: 2022-11-28` header,
  JSON errors as `GitHubApiError`, rate-limit surfacing, cooperative
  per-request timeout, GitHub Enterprise Server (`apiBaseUrl`) support.
- **`src/core/registry.ts`** — the 15 `github_*` tools registered through
  `defineTool` (schemas flow into the agent's system-prompt assembly
  automatically; read-only tools opt into parallel scheduling).
- **`src/core/webhook.ts`** — signature verification (constant-time HMAC-SHA256
  comparison per GitHub's [validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)),
  event normalization into one message, and delivery to a configured DSH
  session.
- **`src/types/github.ts`** — canonical model-facing views, plus the `github`
  `MessageSource` augmentation for the agent's durable transcript.

## Tools

| Tool | Args | Behavior |
|---|---|---|
| `github_repo_info` | `owner`, `repo` | Repo metadata (stars, forks, language, license, topics, default branch). |
| `github_search_repos` | `query`, `perPage?` | GitHub repository search. |
| `github_search_issues` | `query`, `perPage?` | GitHub issue/PR search. |
| `github_issue_list` | `owner`, `repo`, `state?`, `perPage?`, `labels?`, `sort?`, `direction?` | List issues (and PRs). |
| `github_issue_get` | `owner`, `repo`, `number` | One issue with full body. |
| `github_issue_create` | `owner`, `repo`, `title`, `body?`, `labels?`, `assignees?` | Create an issue. |
| `github_issue_update` | `owner`, `repo`, `number`, `title?`, `body?`, `state?`, `labels?`, `assignees?` | Update an issue (close/reopen, retitle…). |
| `github_issue_comment` | `owner`, `repo`, `number`, `body` | Comment on an issue or PR. |
| `github_pr_list` | `owner`, `repo`, `state?`, `perPage?`, `sort?`, `direction?` | List pull requests. |
| `github_pr_get` | `owner`, `repo`, `number` | One PR with head/base, draft, merge state. |
| `github_pr_create` | `owner`, `repo`, `title`, `head`, `base`, `body?`, `draft?` | Open a pull request. |
| `github_pr_merge` | `owner`, `repo`, `number`, `commitTitle?`, `commitMessage?`, `mergeMethod?` | Merge a PR (`merge`/`squash`/`rebase`). |
| `github_repo_contents` | `owner`, `repo`, `path`, `ref?` | Read a file (base64-decoded) or list a directory. |
| `github_workflow_list` | `owner`, `repo` | List GitHub Actions workflows. |
| `github_workflow_dispatch` | `owner`, `repo`, `workflowId`, `ref`, `inputs?` | Trigger `workflow_dispatch`. |

Endpoints follow the official
[Repos](https://docs.github.com/en/rest/repos/repos),
[Issues](https://docs.github.com/en/rest/issues/issues),
[Pulls](https://docs.github.com/en/rest/pulls/pulls),
[Search](https://docs.github.com/en/rest/search/search),
[Contents](https://docs.github.com/en/rest/repos/contents) and
[Actions workflows](https://docs.github.com/en/rest/actions/workflows)
documentation.

## Install & build

```sh
cd dsh-github
pnpm install        # needs registry access; peer deps = the DSH runtime packages
pnpm build          # emits lib/ (ESM, .ts-extension imports rewritten)
pnpm test           # offline smoke test against a local HTTP stub
```

Requires Node ≥ 20 (tested on 24) and TypeScript ≥ 5.8.

## Configuration

The plugin is a standard Cordis plugin (`name`, `Config`, `inject`, `apply`).
It injects `tools` (tool registry), `webServer` (webhook route), and `agents`
(event delivery), so **it loads in the web profile** where those services are
mounted. Add it to the profile patch layer:

```yaml
# D:\DSH\data\profiles\web\cordis.patch.yml — append to the top-level array
- insert:
    - id: github
      name: '@dsh/github'
      config:
        # token: 'github_pat_...'        # or set GITHUB_TOKEN env; secret
        tokenEnv: 'GITHUB_TOKEN'
        # apiBaseUrl: 'https://api.github.com'   # GHES override
        requestTimeoutMs: 30000
        webhook:
          secret: 'whsec_your_webhook_secret'    # GitHub webhook secret; secret
          path: '/github/webhook'
          sessionId: 'session-1'                 # DSH session the agent drives
          events: ['issues', 'issue_comment', 'pull_request']   # empty = all
```

### Config fields

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `token` | `string` (secret) | env fallback | GitHub PAT (fine-grained or classic). Marked `role('secret')`. |
| `tokenEnv` | `string` | `'GITHUB_TOKEN'` | Env var read when `token` is unset. |
| `apiBaseUrl` | `string` | `https://api.github.com` | GitHub API base (GitHub Enterprise Server). |
| `requestTimeoutMs` | `number` | `30000` | Per-request cooperative timeout (ms). |
| `webhook` | object | unset | Enables the signed webhook receiver. |
| `webhook.secret` | `string` (secret) | — (required) | GitHub webhook secret, verified against `X-Hub-Signature-256`. |
| `webhook.path` | `string` | `/github/webhook` | Exact-match route on the DSH `webServer`. |
| `webhook.sessionId` | `string` | — (required) | DSH session to feed inbound events into. |
| `webhook.events` | `string[]` | `[]` (all) | `X-GitHub-Event` allowlist; others get a 200 ignore. |
| `webhook.maxBodyBytes` | `number` | `1048576` | Request body cap; larger deliveries get 413. |

Forwarded events reach the agent as a user message with source
`{ kind: 'github', event, repo, htmlUrl }`, e.g.

> GitHub issue opened #1 — Login bug by alice in acme/widget.

### GitHub side

1. **Token** — [create a PAT](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens):
   a fine-grained token with only the repositories you need and the minimal
   permissions (`Issues: read/write`, `Pull requests: read/write`,
   `Contents: read`, `Actions: read/write` as needed), then put it in the
   config or the `GITHUB_TOKEN` environment variable. Tools fail fast with a
   clear message when no token is configured.
2. **Webhooks** (optional) — repo → Settings → Webhooks → Add webhook:
   - Payload URL: the DSH web URL + `/github/webhook`
     (e.g. `http://your-dsh-host:<port>/github/webhook`);
   - Content type: `application/json`;
   - Secret: the same value as `webhook.secret`;
   - Events: select the events you enabled (Issues, Issue comments, Pull
     requests, … — the plugin only inspects payloads for events it knows).
   The receiver answers GitHub's `ping` delivery with 200 and never touches an
   agent for it; unknown events degrade to a JSON dump so nothing is dropped.

## The integration seam (for DSH developers)

- **Outbound (agent → GitHub)** — the plugin registers tools on `ctx.tools`
  with `defineTool`; schemas join the system-prompt assembly automatically and
  every `execute` forwards `exec.signal` (cooperative cancellation). Tool
  canonical values are the curated views in `src/types/github.ts`.
- **Inbound (GitHub → agent)** — the webhook handler verifies the HMAC
  signature, normalizes the payload to one text message, builds
  `createUserMessage({ content, source: { kind: 'github', … } })` and calls
  `agent.followup(...)`. The `github` source is registered in
  `MessageSourceMap`, so the agent's durable transcript records which event
  produced a turn.
- **No LLM anywhere** — the plugin only performs REST calls and event
  normalization; the agent loop owns all model execution.

## Roadmap

- [x] REST tools: repos / issues / pulls / contents / workflows
- [x] Signed webhook receiver → DSH agent session
- [ ] Pagination (`Link` header) for large listings
- [ ] Reaction/`@mention`-aware auto-reply mode
- [ ] Credential-seam token storage (`ctx.credentials` env-var refs)
- [ ] GitHub App (installation token) auth mode

## References

- GitHub REST API: <https://docs.github.com/en/rest> · Issues ·
  Pulls · Search · Contents · Actions
- GitHub webhooks (events & payloads, validation): <https://docs.github.com/en/webhooks>
- DSH plugin/tool docs: <https://github.com/deepseek-ai/DeepSeek-Harness/tree/master/docs/user/develop>

## License

MIT
