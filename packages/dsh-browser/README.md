# dsh-browser

A DSH (DeepSeek Harness) Cordis plugin that gives DSH agents **stateful web
navigation** — `browser_open`, `browser_read`, `browser_click`, `browser_back`
— on the plain HTTP stack, with **one browsing session per agent session**.

The plugin performs **no LLM execution** and **no browser engine**: no Chrome,
no Chromium, no Playwright, no Puppeteer, no CDP, no JavaScript execution, no
cookies, no screenshots. Retrieval is the same Node built-in `fetch` every DSH
web provider uses; HTML is projected into the small structured view the
browser needs (title / text / links) by a minimal extractor that reuses the
Node standard `URL` class for relative-link resolution.

---

## Boundary: web_search ≠ web_fetch ≠ browser

| | `web_search` | `web_fetch` | `browser_*` (this plugin) |
|---|---|---|---|
| Purpose | discovery | one-shot read | stateful navigation |
| Stateless | yes | yes | **no — per-session state** |
| Finds URLs | yes | no | no (follows them) |
| Navigation (`click`/`back`) | no | no | **yes** |
| Session history | no | no | **yes** (`history` stack) |
| JS execution | no | no | no |

- **`web_search`** — finds information / URLs, never maintains state.
- **`web_fetch`** — reads one URL once, returns the result, keeps no state.
- **`browser_open(url)`** — creates/updates this conversation's
  `BrowserSession`; the current page becomes `url` (the previous one is pushed
  onto the back-history).
- **`browser_read()`** — reads the *current* page from session state (no
  refetch).
- **`browser_click(link_id)`** — navigates by the `link_id` shown on the
  current page's link list; updates the session and the history.
- **`browser_back()`** — pops the history and returns to the previous page.

## Architecture

```
                 ┌────────────────────────────────────────────────────┐
   HTTP(S) ─────►│ BrowserService (per agent session)                 │
   Node fetch    │   session = { currentUrl, currentPage, history[] } │──► browser_* tools
                 │   navigate() → fetchResource() + parseHtml()       │    (ctx.tools, defineTool)
                 └────────────────────────────────────────────────────┘
```

- **`src/core/fetch.ts`** — plain-HTTP retrieval (Node built-in `fetch`, the
  same primitive `@deepseek-ai/dsh-web-search-deepseek` uses): redirects
  followed, final URL via `response.url`, cooperative `exec.signal`
  cancellation, request timeout, body-size cap. A non-2xx response is a
  **result**, not an error (same semantics as the `ctx.web` `WebFetchResult`).
- **`src/core/html.ts`** — minimal structured HTML extraction: document title,
  rendered text (scripts/styles stripped, block layout → line breaks), and
  links (relative hrefs resolved with the standard `URL` class, `javascript:`
  / fragment anchors excluded). Deliberately not a general HTML parser — only
  the three projections the browser needs.
- **`src/core/browser.ts`** — `BrowserService`: one `BrowserSession` per agent
  session, keyed by `exec.agent.id` (the DSH `SessionId`); `open` / `read` /
  `click` / `back` mutate it; `dispose()` clears it on plugin teardown.
- **`src/core/registry.ts`** — the four `browser_*` tools via `defineTool`
  (schemas flow into the agent's system-prompt assembly automatically).
  Navigation tools deliberately do **not** opt into concurrent scheduling
  (`isConcurrencySafe`), so same-session navigation stays serialized.

### Reuse over re-implementation

The browser reuses what already exists and adds only state + navigation:

| Capability | Reused from | New here |
|---|---|---|
| HTTP client | Node built-in `fetch` (the runtime's shared HTTP primitive) | — |
| URL resolution | Node standard `URL` (`new URL(href, base)`) | — |
| Tool registration | `defineTool` + `ctx.tools.register` (dsh-tools / dsh-github pattern) | — |
| Agent-session identity | `exec.agent.id` (`Agent.id: SessionId`) | — |
| HTML → structured view | — | `html.ts` (title/text/links) |
| Session state + history | — | `browser.ts` (`BrowserSession`) |

> Why not reuse `turndown`/`@mixmark-io/domino` from `@deepseek-ai/dsh-tool-web`?
> They are **private dependencies** of that package (never exported as a
> public API) and a *converter* (HTML → markdown), not a structured extractor;
> the browser needs `{title, text, links[]}`, which turndown does not produce.
> They also cannot be added as a dependency here (no registry access in this
> deployment). The browser therefore implements only its small extraction
> surface and reuses the standard `URL` class for resolution.

## Install & build

```sh
cd dsh-browser
pnpm install        # needs registry access; peer deps = the DSH runtime packages
pnpm build          # emits lib/ (ESM, .ts-extension imports rewritten)
pnpm test           # offline smoke test against a local HTTP stub
```

Requires Node ≥ 20 (tested on 24) and TypeScript ≥ 5.8. Zero runtime
dependencies.

## Configuration

The plugin is a standard Cordis plugin (`name`, `Config`, `inject`, `apply`).
It injects `tools` (tool registry) and `systemPrompt` (guidance section), so
**it loads in the web profile**. Add it to the profile patch layer:

```yaml
# D:\DSH\data\profiles\web\cordis.patch.yml — append to the top-level array
- insert:
    - id: browser
      name: '@dsh/browser'
      config:
        maxTextChars: 8000     # cap on page text returned to the model
        maxLinks: 100          # cap on links per page
        timeoutMs: 30000       # per-request timeout
        maxBodyBytes: 5242880  # 5 MiB body cap
        # userAgent: '...'     # override the default DSH-Browser UA
```

The package must resolve as `@dsh/browser` from the DSH runtime (e.g. link it
into `runtime/node_modules/@dsh/` like `@dsh/channel`), then restart DSH.

### Config fields

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `maxTextChars` | `number` | `8000` | Cap on extracted page text characters. |
| `maxLinks` | `number` | `100` | Cap on extracted links per page. |
| `timeoutMs` | `number` | `30000` | Per-request cooperative timeout (ms). |
| `maxBodyBytes` | `number` | `5242880` | Cap on the fetched body bytes. |
| `userAgent` | `string` | DSH-Browser UA | User-Agent header. |

## Model experience

Guidance (system-prompt section `tool:browser`):

> Use the browser_open tool to start a stateful browsing session and open a
> URL, browser_read to see the current page, browser_click(link_id) to follow
> a link on the current page, and browser_back to return to the previous page.
> The browser keeps per-conversation state: use web_search to find URLs and
> web_fetch for a stateless one-shot read of a single URL.

Each tool returns the same structured view:

```json
{
  "url": "https://example.com/page2",
  "title": "Page Two",
  "text": "Second page body.",
  "links": [
    { "id": "1", "text": "Back home", "url": "https://example.com/" }
  ],
  "statusCode": 200,
  "truncated": false,
  "historySize": 1
}
```

## Tests

`pnpm test` runs an offline smoke suite against a local HTTP stub: retrieval
(web_fetch equivalent), open / read / open+read, open→click→read,
open→click→back→read, relative URL resolution, redirects, HTTP errors,
non-HTML pages, link hygiene (`javascript:` / fragment anchors), per-agent
session isolation, and tool registration.

## Roadmap

- [ ] Forward/refresh navigation (`browser_forward`, re-open current URL)
- [ ] Persisted sessions across plugin restarts
- [ ] `charset`-aware body decoding (beyond UTF-8)
- [ ] Deeper text extraction (headings/paragraph structure)

## License

MIT
