/**
 * Signed GitHub webhook receiver. Mounts one POST route on the DSH
 * `webServer`, verifies the `X-Hub-Signature-256` HMAC-SHA256 signature over
 * the raw body (per GitHub's "validating webhook deliveries" contract),
 * normalizes the event into a text summary, and feeds it into a configured DSH
 * agent session through the same seam the Web GUI and headless driver use
 * (`createUserMessage` + `agent.followup`). The agent can then react and reply
 * to GitHub through the plugin's tools.
 *
 * @module dsh-github/core/webhook
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

import type { GitHubMessageSource, GitHubWebhookEventName } from '../types/github.ts';

/** Configuration for the webhook receiver (a subsection of the plugin config). */
export interface GitHubWebhookConfig {
    /** Webhook secret configured in the GitHub repo/webhook settings. Required. */
    readonly secret: string;
    /** Route path; defaults to `/github/webhook`. */
    readonly path?: string;
    /** DSH session id to feed inbound events into. */
    readonly sessionId: string;
    /** Only these `X-GitHub-Event` names are forwarded; empty = all. */
    readonly events?: string[];
    /** Caps the accepted request body; larger requests get 413. Default 1 MiB. */
    readonly maxBodyBytes?: number;
    /** Auto-create the target session when it is not live (deterministic id only). */
    readonly autoCreate?: boolean;
}

/** The raw body type of a Node request as read by this receiver. */
type RawBody = Buffer;

/**
 * Verify a GitHub `X-Hub-Signature-256` header against the raw request body.
 * Constant-time comparison; returns false for a missing/malformed header.
 */
export function verifyGitHubSignature(secret: string, rawBody: RawBody, signatureHeader: string | undefined): boolean {
    if (signatureHeader === undefined) return false;
    const prefix = 'sha256=';
    if (!signatureHeader.startsWith(prefix)) return false;
    const expected = signatureHeader.slice(prefix.length);
    if (!/^[0-9a-f]{64}$/i.test(expected)) return false;
    const digest = createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(digest, 'hex');
    const b = Buffer.from(expected, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
}

/** Context describing one normalized inbound GitHub event. */
export interface NormalizedGitHubEvent {
    readonly event: GitHubWebhookEventName;
    readonly deliveryId?: string;
    readonly repo?: string;
    readonly htmlUrl?: string;
    readonly text: string;
}

function pickString(value: unknown): string | undefined {
    return typeof value === 'string' && value !== '' ? value : undefined;
}

function pickRepo(payload: Record<string, unknown>): string | undefined {
    const repo = payload['repository'];
    if (repo !== null && typeof repo === 'object') {
        return pickString((repo as Record<string, unknown>)['full_name']);
    }
    return undefined;
}

/**
 * Normalize one GitHub webhook event into a one-message text summary the agent
 * can act on. Unknown events degrade to a `JSON` dump so nothing is silently
 * dropped.
 */
export function normalizeWebhookEvent(
    eventName: string,
    payload: Record<string, unknown>,
): NormalizedGitHubEvent {
    const repo = pickRepo(payload);
    const sender = payload['sender'];
    const senderLogin = sender !== null && typeof sender === 'object'
        ? pickString((sender as Record<string, unknown>)['login'])
        : undefined;
    const issue = payload['issue'];
    const comment = payload['comment'];
    const pullRequest = payload['pull_request'];
    const workflowRun = payload['workflow_run'];

    const issueView = (item: unknown): { number?: number; title?: string; url?: string } | undefined => {
        if (item === null || typeof item !== 'object') return undefined;
        const record = item as Record<string, unknown>;
        return {
            number: typeof record['number'] === 'number' ? record['number'] : undefined,
            title: pickString(record['title']),
            url: pickString(record['html_url']),
        };
    };

    const issueSummary = (item: unknown): string | undefined => {
        const view = issueView(item);
        if (view === undefined) return undefined;
        const number = view.number === undefined ? '' : ` #${view.number}`;
        const title = view.title === undefined ? '' : ` — ${view.title}`;
        return `${number}${title}`;
    };

    let text: string;
    const actor = senderLogin === undefined ? '' : ` by ${senderLogin}`;

    switch (eventName) {
        case 'issues': {
            const action = pickString((payload['action'] as unknown) ?? undefined);
            text = `GitHub issue ${action ?? 'changed'}${issueSummary(issue) ?? ''}${actor} in ${repo ?? 'a repository'}.`;
            break;
        }
        case 'issue_comment': {
            const action = pickString((payload['action'] as unknown) ?? undefined);
            const commentBody = comment !== null && typeof comment === 'object'
                ? pickString((comment as Record<string, unknown>)['body'])
                : undefined;
            text = `GitHub comment ${action ?? 'created'}${issueSummary(issue) ?? ''}${actor} in ${repo ?? 'a repository'}.`
                + (commentBody === undefined ? '' : `\n\nComment: ${commentBody}`);
            break;
        }
        case 'pull_request': {
            const action = pickString((payload['action'] as unknown) ?? undefined);
            text = `GitHub pull request ${action ?? 'changed'}${issueSummary(pullRequest) ?? ''}${actor} in ${repo ?? 'a repository'}.`;
            break;
        }
        case 'pull_request_review': {
            const action = pickString((payload['action'] as unknown) ?? undefined);
            const state = pickString((payload['review'] as Record<string, unknown> | null | undefined)?.['state']);
            text = `GitHub pull request review ${action ?? 'submitted'} (${state ?? 'unknown state'})${issueSummary(pullRequest) ?? ''}${actor} in ${repo ?? 'a repository'}.`;
            break;
        }
        case 'push': {
            const ref = pickString(payload['ref']);
            const commits = payload['commits'];
            const count = Array.isArray(commits) ? commits.length : 0;
            const head = pickString((payload['head_commit'] as Record<string, unknown> | null | undefined)?.['message']);
            text = `GitHub push to ${repo ?? 'a repository'}${ref === undefined ? '' : ` (${ref})`}${actor}: ${count} commit(s).`
                + (head === undefined ? '' : `\n\nHead commit: ${head}`);
            break;
        }
        case 'workflow_run': {
            const runView = (): { id?: number; name?: string; status?: string; conclusion?: string; url?: string } => {
                if (workflowRun === null || typeof workflowRun !== 'object') return {};
                const record = workflowRun as Record<string, unknown>;
                return {
                    id: typeof record['id'] === 'number' ? record['id'] : undefined,
                    name: pickString(record['name']),
                    status: pickString(record['status']),
                    conclusion: pickString(record['conclusion']),
                    url: pickString(record['html_url']),
                };
            };
            const run = runView();
            const name = run.name === undefined ? '' : ` ${run.name}`;
            const status = run.status === undefined ? '' : ` (${run.status}${run.conclusion === undefined ? '' : ` → ${run.conclusion}`})`;
            const id = run.id === undefined ? '' : ` #${run.id}`;
            text = `GitHub Actions workflow run${name}${id}${status} in ${repo ?? 'a repository'}.`;
            break;
        }
        default:
            // Unknown or unhandled event: keep the payload so the agent is not
            // silently deprived of the signal.
            text = `GitHub webhook event "${eventName}"${repo === undefined ? '' : ` on ${repo}`}${actor}.\n\n${JSON.stringify(payload).slice(0, 4000)}`;
    }

    return {
        event: eventName,
        deliveryId: undefined,
        repo,
        htmlUrl: issueView(issue)?.url ?? issueView(pullRequest)?.url,
        text,
    };
}

/** Options for constructing the webhook handler. */
export interface WebhookHandlerOptions {
    ctx: Context;
    config: GitHubWebhookConfig;
    /** Called with the resulting user message for the target session (test seam). */
    deliver?: (agent: Agent, message: import('@deepseek-ai/dsh-llm').UserMessage) => void;
}

/**
 * The webhook receiver. Registers its route on `ctx.webServer` at construction
 * and returns a disposer. Signature failures answer 401 without touching any
 * agent; unmapped/dropped events answer 200 after logging.
 */
export class GitHubWebhookHandler {
    private readonly ctx: Context;
    private readonly config: GitHubWebhookConfig;
    private readonly routePath: string;
    private readonly events: ReadonlySet<string>;
    private readonly maxBodyBytes: number;
    private readonly disposeRoute: () => void;
    private readonly deliver: WebhookHandlerOptions['deliver'];
    private disposed = false;

    constructor(options: WebhookHandlerOptions) {
        this.ctx = options.ctx;
        this.config = options.config;
        this.routePath = (options.config.path ?? '/github/webhook').replace(/\/+$/, '') || '/github/webhook';
        this.events = new Set(options.config.events ?? []);
        this.maxBodyBytes = options.config.maxBodyBytes ?? 1024 * 1024;
        this.deliver = options.deliver;

        this.disposeRoute = this.ctx.webServer.register({
            kind: 'exact',
            path: this.routePath,
            handler: (req, res) => this.handle(req, res).catch((error: unknown) => {
                this.ctx.logger.error(`github: webhook handler error: ${String(error)}`);
                if (!res.writableEnded) {
                    res.writeHead(500, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'internal error' }));
                }
            }),
        });
        this.ctx.logger.info(`github: webhook receiver at ${this.routePath} -> session ${options.config.sessionId}`);
    }

    /** Read the request body up to the configured cap. */
    private async readBody(req: import('node:http').IncomingMessage): Promise<Buffer | undefined> {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buffer.length;
            if (size > this.maxBodyBytes) return undefined;
            chunks.push(buffer);
        }
        return Buffer.concat(chunks);
    }

    private answer(res: import('node:http').ServerResponse, status: number, body: string): void {
        if (res.writableEnded) return;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(body);
    }

    /** One webhook delivery. */
    private async handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
        if (this.disposed) {
            this.answer(res, 503, JSON.stringify({ ok: false, error: 'webhook handler disposed' }));
            return;
        }
        if (req.method !== 'POST') {
            this.answer(res, 405, JSON.stringify({ ok: false, error: 'method not allowed' }));
            return;
        }

        const raw = await this.readBody(req);
        if (raw === undefined) {
            this.answer(res, 413, JSON.stringify({ ok: false, error: 'payload too large' }));
            return;
        }

        const signature = req.headers['x-hub-signature-256'];
        if (typeof signature !== 'string' || !verifyGitHubSignature(this.config.secret, raw, signature)) {
            this.ctx.logger.warn('github: webhook signature mismatch (401)');
            this.answer(res, 401, JSON.stringify({ ok: false, error: 'invalid signature' }));
            return;
        }

        const eventName = req.headers['x-github-event'];
        const deliveryId = req.headers['x-github-delivery'];
        if (typeof eventName !== 'string') {
            this.answer(res, 400, JSON.stringify({ ok: false, error: 'missing X-GitHub-Event header' }));
            return;
        }
        if (this.events.size > 0 && !this.events.has(eventName)) {
            this.ctx.logger.debug(`github: ignoring filtered event ${eventName}`);
            this.answer(res, 200, JSON.stringify({ ok: true, ignored: true }));
            return;
        }

        let payload: Record<string, unknown>;
        try {
            const parsed: unknown = JSON.parse(raw.toString('utf8'));
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                throw new Error('payload is not a JSON object');
            }
            payload = parsed as Record<string, unknown>;
        } catch {
            this.answer(res, 400, JSON.stringify({ ok: false, error: 'invalid JSON payload' }));
            return;
        }

        const event = normalizeWebhookEvent(eventName, payload);
        const agent = this.ctx.agents.get(SessionId(this.config.sessionId));
        if (agent === undefined) {
            this.ctx.logger.warn(
                `github: webhook target session ${this.config.sessionId} is not live; event ${eventName} dropped`,
            );
            this.answer(res, 200, JSON.stringify({ ok: true, dropped: 'session-not-live' }));
            return;
        }

        const source: GitHubMessageSource = {
            kind: 'github',
            event: event.event,
            deliveryId: typeof deliveryId === 'string' ? deliveryId : undefined,
            repo: event.repo,
            htmlUrl: event.htmlUrl,
        };
        const message = createUserMessage({
            content: [{ type: 'text', text: event.text }],
            source,
        });
        // V1 collection: inbound MUST go through the Agent OS Ingress (governed)
        // rather than a direct `agent.followup`. The direct seam remains ONLY as
        // a compatibility fallback when the Agent OS is not composed (no hard
        // dependency on @dsh/agent-os — discovered via the shared context).
        type IngressLike = {
            ingest(input: {
                source: string;
                sessionId: string;
                message: import('@deepseek-ai/dsh-llm').UserMessage;
                capability?: string;
            }): Promise<{ outcome: string; reason?: string }>;
        };
        const agentOS = (this.ctx as unknown as { agentOS?: { ingress: IngressLike } }).agentOS;
        if (agentOS !== undefined) {
            const result = await agentOS.ingress.ingest({
                source: 'github',
                sessionId: this.config.sessionId,
                message,
            });
            if (result.outcome !== 'delivered') {
                this.ctx.logger.warn(
                    `github: webhook ingress ${eventName} (${deliveryId ?? '?'}) not delivered to session ${this.config.sessionId}: ${result.outcome}${result.reason === undefined ? '' : ` — ${result.reason}`}`,
                );
                this.answer(res, 200, JSON.stringify({ ok: true, delivered: false, reason: result.outcome }));
                return;
            }
        } else if (this.deliver !== undefined) {
            this.deliver(agent, message);
        } else {
            this.ctx.logger.warn('github: Agent OS Ingress unavailable — falling back to the deprecated direct followup seam (governance bypass)');
            agent.followup(message);
        }
        this.ctx.logger.info(`github: ${eventName} (${deliveryId ?? '?'}) -> session ${this.config.sessionId}`);
        this.answer(res, 200, JSON.stringify({ ok: true, event: eventName }));
    }

    /** Unregister the route. */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.disposeRoute();
    }
}
