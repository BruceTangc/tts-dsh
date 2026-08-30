/**
 * DSH GitHub plugin: a model-facing GitHub toolset for DSH agents (repos,
 * issues, pull requests, repository contents, Actions workflows) plus an
 * optional signed GitHub webhook receiver that feeds repository events into a
 * DSH agent session.
 *
 * The plugin performs no LLM execution itself: agent work stays in the DSH
 * runtime, this plugin only talks to the GitHub REST API on the agent's behalf
 * and injects inbound webhook events as user messages.
 *
 * @module dsh-github
 */
import z from '@deepseek-ai/schemastery';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type { Context } from '@deepseek-ai/cordis';

import { GitHubClient, DEFAULT_API_BASE_URL, DEFAULT_REQUEST_TIMEOUT_MS } from './core/client.ts';
import { registerGitHubTools } from './core/registry.ts';
import { GitHubWebhookHandler, type GitHubWebhookConfig } from './core/webhook.ts';

/** Stable Cordis plugin name (also usable as an id in cordis.yml/patch). */
export const name = 'github';

/** Services the plugin requires before it can load. */
export const inject = ['tools', 'webServer', 'agents'];

const WebhookSchema = z.object({
    /**
     * The webhook secret configured on the GitHub side (repo settings →
     * Webhooks → secret). Used to verify `X-Hub-Signature-256`. Secret.
     */
    secret: z.string().role('secret').required(),
    /** Webhook route path; default `/github/webhook` (exact match, no trailing slash). */
    path: z.string().default('/github/webhook'),
    /** DSH session id to feed inbound GitHub events into. */
    sessionId: z.string().required(),
    /** Only these `X-GitHub-Event` names are forwarded; empty = all events. */
    events: z.array(z.string()),
    /** Cap on the accepted request body in bytes (default 1 MiB). */
    maxBodyBytes: z.natural().default(1024 * 1024),
});

/** Configuration schema for the GitHub plugin. */
export const Config: z<GitHubConfig> = z.object({
    /**
     * GitHub personal access token (fine-grained or classic). Marked secret —
     * redacted on configuration surfaces. When omitted, the plugin falls back
     * to the environment variable named by {@link GitHubConfig.tokenEnv}
     * (`GITHUB_TOKEN` by default).
     */
    token: z.string().role('secret'),
    /** Environment variable holding the token when `token` is not set. */
    tokenEnv: z.string().default('GITHUB_TOKEN'),
    /** GitHub API base URL; default `https://api.github.com` (GitHub Enterprise Server override). */
    apiBaseUrl: z.string().default(DEFAULT_API_BASE_URL),
    /** Per-request cooperative timeout in milliseconds (default 30000). */
    requestTimeoutMs: z.natural().default(DEFAULT_REQUEST_TIMEOUT_MS),
    /**
     * Optional block enabling the signed webhook receiver; absent disables it.
     * Uses `default(undefined)` so an omitted block stays absent (schemastery
     * object keys otherwise materialize as `{}` and would demand the required
     * fields).
     */
    webhook: WebhookSchema.default(undefined as never),
});

/** Validated config shape (mirrors {@link Config}). */
export interface GitHubConfig {
    token?: string;
    tokenEnv: string;
    apiBaseUrl: string;
    requestTimeoutMs: number;
    webhook?: GitHubWebhookConfig;
}

/** Plugin body: build the client, register the tools, mount the webhook. */
export function apply(ctx: Context, config: GitHubConfig): void {
    const client = new GitHubClient({
        apiBaseUrl: config.apiBaseUrl,
        token: config.token,
        tokenEnv: config.tokenEnv,
        requestTimeoutMs: config.requestTimeoutMs,
    });
    if (!client.authenticated) {
        ctx.logger.warn(
            `github: no token available (config token / ${config.tokenEnv}); tool calls and webhook replies will fail`,
        );
    }

    const disposers: Array<() => void> = [];

    // Model-facing tools: schemas flow into the system prompt automatically.
    disposers.push(...registerGitHubTools(ctx, {
        client,
        requestTimeoutMs: config.requestTimeoutMs,
    }));
    ctx.logger.info('github: REST tools registered (repos, issues, pulls, contents, workflows)');

    // Optional inbound half: the signed webhook receiver.
    let webhook: GitHubWebhookHandler | undefined;
    if (config.webhook !== undefined) {
        webhook = new GitHubWebhookHandler({ ctx, config: config.webhook });
    }

    ctx.effect(() => {
        return () => {
            webhook?.dispose();
            for (const dispose of disposers) dispose();
        };
    }, 'github: dispose tools and webhook');
}

export { GitHubClient, GITHUB_API_VERSION, DEFAULT_API_BASE_URL, DEFAULT_REQUEST_TIMEOUT_MS, resolveToken } from './core/client.ts';
export { GitHubApiError } from './types/github.ts';
export { GitHubWebhookHandler, verifyGitHubSignature, normalizeWebhookEvent } from './core/webhook.ts';
export type { GitHubWebhookConfig, NormalizedGitHubEvent } from './core/webhook.ts';
export type {
    GitHubClientOptions,
    GitHubCommentView,
    GitHubDispatchView,
    GitHubFileView,
    GitHubIssueView,
    GitHubMessageSource,
    GitHubPullView,
    GitHubRepoView,
    GitHubSearchResult,
    GitHubWebhookEventName,
    GitHubWorkflowView,
} from './types/github.ts';
