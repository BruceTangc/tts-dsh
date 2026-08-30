/**
 * GitHub REST client: the only place this plugin talks to GitHub. It wraps
 * `fetch` with the GitHub REST conventions (Bearer auth, the `2022-11-28`
 * API version header, JSON errors, rate-limit surfacing, cooperative
 * per-request timeouts) and projects API responses into the canonical
 * model-facing views declared in {@link module:dsh-github/types}.
 *
 * The client itself is dependency-free (`fetch` is built into Node ≥ 18) and
 * pure — no Cordis imports — so it is unit-testable against a local HTTP stub
 * without any DSH runtime.
 *
 * @module dsh-github/core/client
 */
import type { GitHubClientOptions, GitHubBranchView, GitHubCodeSearchHitView, GitHubCommentView, GitHubCommitView, GitHubContentsDeleteView, GitHubContentsEntryView, GitHubDispatchView, GitHubFileView, GitHubIssueView, GitHubLabelView, GitHubMilestoneView, GitHubPullFileView, GitHubPullView, GitHubRefView, GitHubReleaseView, GitHubRepoView, GitHubReviewState, GitHubReviewView, GitHubSearchResult, GitHubWorkflowJobView, GitHubWorkflowLogsView, GitHubWorkflowRunView, GitHubWorkflowView } from '../types/github.ts';
import { GitHubApiError } from '../types/github.ts';

/** The GitHub REST API version pinned by this client (docs.github.com/rest/overview/api-versions). */
export const GITHUB_API_VERSION = '2022-11-28';

/** Default per-request timeout, in milliseconds. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Default API base URL (override for GitHub Enterprise Server). */
export const DEFAULT_API_BASE_URL = 'https://api.github.com';

/** Raw GitHub issue payload shape (the fields this plugin projects). */
export interface GitHubIssueRaw {
    number: number;
    title: string;
    state: string;
    html_url: string;
    user: { login?: string } | null;
    created_at: string | null;
    updated_at: string | null;
    closed_at: string | null;
    labels: Array<{ name?: string }>;
    body: string | null;
    pull_request?: unknown;
    comments?: number;
}

/** Raw GitHub pull-request payload shape (the fields this plugin projects). */
export interface GitHubPullRaw {
    number: number;
    title: string;
    state: string;
    html_url: string;
    user: { login?: string } | null;
    created_at: string | null;
    updated_at: string | null;
    merged_at: string | null;
    draft: boolean;
    merged: boolean;
    mergeable: boolean | null;
    head: { ref: string; sha: string; repo: { full_name?: string } | null };
    base: { ref: string; sha: string; repo: { full_name?: string } | null };
    body: string | null;
}

/** Resolve the bearer token: explicit option, then the named environment variable. */
export function resolveToken(token?: string, envName = 'GITHUB_TOKEN'): string | undefined {
    if (token !== undefined && token !== '') return token;
    const value = process.env[envName];
    return value !== undefined && value !== '' ? value : undefined;
}

interface RequestOptions {
    method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
    body?: unknown;
    /** Caller-owned cooperative cancellation signal (forwarded to fetch). */
    signal?: AbortSignal;
    /** Non-2xx responses with this status return `undefined` instead of throwing. */
    notFoundIsUndefined?: boolean;
    /** GitHub repo "name with owner" (`owner/repo`), for error messages only. */
    repo?: string;
}

/** Minimal fetch response surface this client relies on (undici-version-agnostic). */
interface FetchResponseLike {
    ok: boolean;
    status: number;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
    json(): Promise<unknown>;
}

/**
 * The GitHub REST client. Create one per plugin load; all tools share it.
 * Not exported for consumers outside this plugin, but kept a plain class so
 * the smoke test can drive it against an HTTP stub.
 */
export class GitHubClient {
    private readonly apiBaseUrl: string;
    private readonly token: string | undefined;
    private readonly timeoutMs: number;

    constructor(options: GitHubClientOptions = {}) {
        this.apiBaseUrl = (options.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, '');
        this.token = resolveToken(options.token, options.tokenEnv);
        this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    }

    /** Whether this client has a token; tools fail fast with a clear message when not. */
    get authenticated(): boolean {
        return this.token !== undefined;
    }

    /** One low-level REST call: response JSON or a normalized {@link GitHubApiError}. */
    async request<T>(path: string, options: RequestOptions = {}): Promise<T | undefined> {
        const method = options.method ?? 'GET';
        if (!this.authenticated) {
            throw new Error(
                'GitHub token not configured: set GITHUB_TOKEN or the plugin `token` / `tokenEnv` config.',
            );
        }

        const controller = new AbortController();
        const forwardSignal = options.signal;
        const onOuterAbort = (): void => controller.abort(forwardSignal?.reason);
        let timer: NodeJS.Timeout | undefined;
        if (forwardSignal !== undefined) {
            if (forwardSignal.aborted) {
                onOuterAbort();
            } else {
                forwardSignal.addEventListener('abort', onOuterAbort, { once: true });
            }
        }
        const timedOut = new Error(`GitHub API ${method} ${path} timed out after ${this.timeoutMs}ms`);
        timer = setTimeout(() => controller.abort(timedOut), this.timeoutMs);
        timer.unref?.();

        const url = `${this.apiBaseUrl}${path}`;
        try {
            const response = (await fetch(url, {
                method,
                signal: controller.signal,
                headers: {
                    accept: 'application/vnd.github+json',
                    'x-github-api-version': GITHUB_API_VERSION,
                    authorization: `Bearer ${this.token}`,
                    'user-agent': 'dsh-github-plugin',
                    ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
                },
                ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
            })) as unknown as FetchResponseLike;

            const rateLimited = response.headers.get('x-ratelimit-remaining') === '0';

            if (response.status === 404 && options.notFoundIsUndefined) {
                return undefined;
            }

            if (!response.ok) {
                const text = await response.text();
                let message = text;
                let documentationUrl: string | undefined;
                try {
                    const json = JSON.parse(text) as { message?: string; documentation_url?: string };
                    if (typeof json.message === 'string') message = json.message;
                    documentationUrl = json.documentation_url;
                } catch {
                    // non-JSON error body: keep the raw text
                }
                if (rateLimited) {
                    message += ' — GitHub API rate limit exhausted.';
                }
                throw new GitHubApiError({
                    status: response.status,
                    method,
                    path,
                    message,
                    documentationUrl,
                    rateLimited,
                });
            }

            if (response.status === 204) return undefined as T | undefined;
            return (await response.json()) as T;
        } finally {
            if (timer !== undefined) clearTimeout(timer);
            if (forwardSignal !== undefined) forwardSignal.removeEventListener('abort', onOuterAbort);
        }
    }

    // ---- Repositories -----------------------------------------------------

    /** GET /repos/{owner}/{repo} */
    async getRepo(owner: string, repo: string, signal?: AbortSignal): Promise<GitHubRepoView> {
        const raw = await this.request<{
            full_name: string;
            description: string | null;
            html_url: string;
            default_branch: string;
            language: string | null;
            stargazers_count: number;
            forks_count: number;
            open_issues_count: number;
            private: boolean;
            archived: boolean;
            license: { name?: string } | null;
            topics?: string[];
            pushed_at: string | null;
            homepage: string | null;
        }>(`/repos/${owner}/${repo}`, { signal, repo: `${owner}/${repo}` });
        if (raw === undefined) {
            throw new GitHubApiError({
                status: 404,
                method: 'GET',
                path: `/repos/${owner}/${repo}`,
                message: `repository ${owner}/${repo} not found`,
            });
        }
        return {
            fullName: raw.full_name,
            description: raw.description ?? undefined,
            htmlUrl: raw.html_url,
            defaultBranch: raw.default_branch,
            language: raw.language ?? undefined,
            stars: raw.stargazers_count,
            forks: raw.forks_count,
            openIssues: raw.open_issues_count,
            private: raw.private,
            archived: raw.archived,
            license: raw.license?.name,
            topics: raw.topics ?? [],
            pushedAt: raw.pushed_at ?? undefined,
            homepage: raw.homepage ?? undefined,
        };
    }

    /** GET /search/repositories?q=... */
    async searchRepos(
        query: string,
        perPage: number,
        signal?: AbortSignal,
    ): Promise<GitHubSearchResult<GitHubRepoView>> {
        const raw = await this.request<{
            total_count: number;
            items: Array<{
                full_name: string;
                description: string | null;
                html_url: string;
                default_branch: string;
                language: string | null;
                stargazers_count: number;
                forks_count: number;
                open_issues_count: number;
                private: boolean;
                archived: boolean;
                license: { name?: string } | null;
            }>;
        }>(`/search/repositories?q=${encodeURIComponent(query)}&per_page=${perPage}`, { signal });
        if (raw === undefined) throw new Error('GitHub search/repositories returned no body');
        return {
            totalCount: raw.total_count,
            items: raw.items.map((item) => ({
                fullName: item.full_name,
                description: item.description ?? undefined,
                htmlUrl: item.html_url,
                defaultBranch: item.default_branch,
                language: item.language ?? undefined,
                stars: item.stargazers_count,
                forks: item.forks_count,
                openIssues: item.open_issues_count,
                private: item.private,
                archived: item.archived,
                license: item.license?.name,
                topics: [],
            })),
        };
    }

    // ---- Issues -----------------------------------------------------------

    private mapIssue(item: GitHubIssueRaw): GitHubIssueView {
        return {
            number: item.number,
            title: item.title,
            state: item.state,
            htmlUrl: item.html_url,
            user: item.user?.login,
            createdAt: item.created_at ?? undefined,
            updatedAt: item.updated_at ?? undefined,
            closedAt: item.closed_at ?? undefined,
            labels: item.labels.map((label) => label.name ?? '').filter((name) => name !== ''),
            body: item.body ?? undefined,
            pullRequest: item.pull_request !== undefined,
            comments: item.comments,
        };
    }

    /** GET /repos/{owner}/{repo}/issues?state=... */
    listIssues(
        owner: string,
        repo: string,
        options: { state?: string; perPage?: number; sort?: string; direction?: string; labels?: string },
        signal?: AbortSignal,
    ): Promise<GitHubIssueView[]> {
        const params = new URLSearchParams();
        if (options.state !== undefined) params.set('state', options.state);
        if (options.perPage !== undefined) params.set('per_page', String(options.perPage));
        if (options.sort !== undefined) params.set('sort', options.sort);
        if (options.direction !== undefined) params.set('direction', options.direction);
        if (options.labels !== undefined) params.set('labels', options.labels);
        const qs = params.toString();
        const path = `/repos/${owner}/${repo}/issues${qs === '' ? '' : `?${qs}`}`;
        return this.request<GitHubIssueRaw[]>(path, { signal, repo: `${owner}/${repo}` }).then(
            (items) => items?.map((item) => this.mapIssue(item)) ?? [],
        );
    }

    /** GET /search/issues?q=... (issue and PR results). */
    async searchIssues(
        query: string,
        perPage: number,
        signal?: AbortSignal,
    ): Promise<GitHubSearchResult<GitHubIssueView>> {
        const raw = await this.request<{
            total_count: number;
            items: GitHubIssueRaw[];
        }>(`/search/issues?q=${encodeURIComponent(query)}&per_page=${perPage}`, { signal });
        if (raw === undefined) throw new Error('GitHub search/issues returned no body');
        return {
            totalCount: raw.total_count,
            items: raw.items.map((item) => this.mapIssue(item)),
        };
    }

    /** GET /repos/{owner}/{repo}/issues/{issue_number} */
    async getIssue(owner: string, repo: string, issueNumber: number, signal?: AbortSignal): Promise<GitHubIssueView> {
        const raw = await this.request<GitHubIssueRaw>(`/repos/${owner}/${repo}/issues/${issueNumber}`, {
            signal,
            repo: `${owner}/${repo}`,
        });
        if (raw === undefined) {
            throw new GitHubApiError({
                status: 404,
                method: 'GET',
                path: `/repos/${owner}/${repo}/issues/${issueNumber}`,
                message: `issue ${owner}/${repo}#${issueNumber} not found`,
            });
        }
        return this.mapIssue(raw);
    }

    /** POST /repos/{owner}/{repo}/issues */
    createIssue(
        owner: string,
        repo: string,
        input: { title: string; body?: string; labels?: string[]; assignees?: string[]; draft?: boolean },
        signal?: AbortSignal,
    ): Promise<GitHubIssueView> {
        const path = `/repos/${owner}/${repo}/issues`;
        return this.request<GitHubIssueRaw>(path, {
            method: 'POST',
            body: input,
            signal,
            repo: `${owner}/${repo}`,
        }).then((raw) => {
            if (raw === undefined) throw new Error('GitHub returned an empty issue response');
            return this.mapIssue(raw);
        });
    }

    /** PATCH /repos/{owner}/{repo}/issues/{issue_number} */
    updateIssue(
        owner: string,
        repo: string,
        issueNumber: number,
        input: { title?: string; body?: string; state?: string; labels?: string[]; assignees?: string[] },
        signal?: AbortSignal,
    ): Promise<GitHubIssueView> {
        const path = `/repos/${owner}/${repo}/issues/${issueNumber}`;
        return this.request<GitHubIssueRaw>(path, {
            method: 'PATCH',
            body: input,
            signal,
            repo: `${owner}/${repo}`,
        }).then((raw) => {
            if (raw === undefined) throw new Error('GitHub returned an empty issue response');
            return this.mapIssue(raw);
        });
    }

    /** POST /repos/{owner}/{repo}/issues/{issue_number}/comments */
    commentOnIssue(
        owner: string,
        repo: string,
        issueNumber: number,
        body: string,
        signal?: AbortSignal,
    ): Promise<GitHubCommentView> {
        const path = `/repos/${owner}/${repo}/issues/${issueNumber}/comments`;
        return this.request<GitHubCommentView>(path, {
            method: 'POST',
            body: { body },
            signal,
            repo: `${owner}/${repo}`,
        }).then((raw) => {
            if (raw === undefined) throw new Error('GitHub returned an empty comment response');
            return raw;
        });
    }

    // ---- Pull requests ----------------------------------------------------

    private mapPull(item: GitHubPullRaw): GitHubPullView {
        return {
            number: item.number,
            title: item.title,
            state: item.state,
            htmlUrl: item.html_url,
            user: item.user?.login,
            createdAt: item.created_at ?? undefined,
            updatedAt: item.updated_at ?? undefined,
            mergedAt: item.merged_at ?? undefined,
            draft: item.draft,
            merged: item.merged,
            mergeable: item.mergeable ?? undefined,
            head: { ref: item.head.ref, sha: item.head.sha, repo: item.head.repo?.full_name },
            base: { ref: item.base.ref, sha: item.base.sha, repo: item.base.repo?.full_name },
            body: item.body ?? undefined,
        };
    }

    /** GET /repos/{owner}/{repo}/pulls */
    listPulls(
        owner: string,
        repo: string,
        options: { state?: string; perPage?: number; sort?: string; direction?: string },
        signal?: AbortSignal,
    ): Promise<GitHubPullView[]> {
        const params = new URLSearchParams();
        if (options.state !== undefined) params.set('state', options.state);
        if (options.perPage !== undefined) params.set('per_page', String(options.perPage));
        if (options.sort !== undefined) params.set('sort', options.sort);
        if (options.direction !== undefined) params.set('direction', options.direction);
        const qs = params.toString();
        const path = `/repos/${owner}/${repo}/pulls${qs === '' ? '' : `?${qs}`}`;
        return this.request<GitHubPullRaw[]>(path, { signal, repo: `${owner}/${repo}` }).then(
            (items) => items?.map((item) => this.mapPull(item)) ?? [],
        );
    }

    /** GET /repos/{owner}/{repo}/pulls/{pull_number} */
    async getPull(owner: string, repo: string, pullNumber: number, signal?: AbortSignal): Promise<GitHubPullView> {
        const raw = await this.request<GitHubPullRaw>(`/repos/${owner}/${repo}/pulls/${pullNumber}`, {
            signal,
            repo: `${owner}/${repo}`,
        });
        if (raw === undefined) {
            throw new GitHubApiError({
                status: 404,
                method: 'GET',
                path: `/repos/${owner}/${repo}/pulls/${pullNumber}`,
                message: `pull request ${owner}/${repo}#${pullNumber} not found`,
            });
        }
        return this.mapPull(raw);
    }

    /** POST /repos/{owner}/{repo}/pulls */
    createPull(
        owner: string,
        repo: string,
        input: { title: string; head: string; base: string; body?: string; draft?: boolean },
        signal?: AbortSignal,
    ): Promise<GitHubPullView> {
        const path = `/repos/${owner}/${repo}/pulls`;
        return this.request<GitHubPullRaw>(path, {
            method: 'POST',
            body: input,
            signal,
            repo: `${owner}/${repo}`,
        }).then((raw) => {
            if (raw === undefined) throw new Error('GitHub returned an empty pull-request response');
            return this.mapPull(raw);
        });
    }

    /** PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge */
    async mergePull(
        owner: string,
        repo: string,
        pullNumber: number,
        input: { commitTitle?: string; commitMessage?: string; mergeMethod?: 'merge' | 'squash' | 'rebase' },
        signal?: AbortSignal,
    ): Promise<{ number: number; merged: boolean; message?: string }> {
        const raw = await this.request<{ merged: boolean; message?: string }>(
            `/repos/${owner}/${repo}/pulls/${pullNumber}/merge`,
            { method: 'PUT', body: input, signal, repo: `${owner}/${repo}` },
        );
        if (raw === undefined) throw new Error('GitHub returned an empty merge response');
        return { number: pullNumber, ...raw };
    }

    // ---- Contents ---------------------------------------------------------

    /** GET /repos/{owner}/{repo}/contents/{path} (decodes text files). */
    async getContents(
        owner: string,
        repo: string,
        path: string,
        options: { ref?: string } = {},
        signal?: AbortSignal,
    ): Promise<GitHubFileView | GitHubFileView[]> {
        const query = options.ref === undefined ? '' : `?ref=${encodeURIComponent(options.ref)}`;
        const apiPath = `/repos/${owner}/${repo}/contents/${path.replace(/^\/+/, '')}${query}`;
        const raw = await this.request<unknown>(apiPath, { signal, repo: `${owner}/${repo}` });
        if (raw === undefined) {
            throw new GitHubApiError({
                status: 404,
                method: 'GET',
                path: apiPath,
                message: `path ${path} not found in ${owner}/${repo}`,
            });
        }
        if (Array.isArray(raw)) {
            return (raw as Array<{ path: string; size: number; sha: string; type: string; html_url?: string }>).map(
                (entry) => ({
                    path: entry.path,
                    size: entry.size,
                    sha: entry.sha,
                    type: entry.type,
                    htmlUrl: entry.html_url,
                }),
            );
        }
        const file = raw as {
            path: string;
            size: number;
            sha: string;
            type: string;
            html_url?: string;
            encoding?: string;
            content?: string;
        };
        let content: string | undefined;
        if (file.type === 'file' && typeof file.content === 'string' && file.encoding === 'base64') {
            content = Buffer.from(file.content, 'base64').toString('utf8');
        }
        return {
            path: file.path,
            size: file.size,
            sha: file.sha,
            type: file.type,
            htmlUrl: file.html_url,
            content,
        };
    }

    // ---- Actions ----------------------------------------------------------

    /** GET /repos/{owner}/{repo}/actions/workflows */
    async listWorkflows(owner: string, repo: string, signal?: AbortSignal): Promise<GitHubSearchResult<GitHubWorkflowView>> {
        const raw = await this.request<{
            total_count: number;
            workflows: Array<{
                id: number;
                name: string;
                path: string;
                state: string;
                created_at: string | null;
                updated_at: string | null;
            }>;
        }>(`/repos/${owner}/${repo}/actions/workflows`, { signal, repo: `${owner}/${repo}` });
        if (raw === undefined) throw new Error('GitHub returned no workflows body');
        return {
            totalCount: raw.total_count,
            items: raw.workflows.map((workflow) => ({
                id: workflow.id,
                name: workflow.name,
                path: workflow.path,
                state: workflow.state,
                createdAt: workflow.created_at ?? undefined,
                updatedAt: workflow.updated_at ?? undefined,
            })),
        };
    }

    /** POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches */
    async dispatchWorkflow(
        owner: string,
        repo: string,
        workflowId: number | string,
        input: { ref: string; inputs?: Record<string, string> },
        signal?: AbortSignal,
    ): Promise<GitHubDispatchView> {
        await this.request<unknown>(`/repos/${owner}/${repo}/actions/workflows/${workflowId}/dispatches`, {
            method: 'POST',
            body: { ref: input.ref, ...(input.inputs === undefined ? {} : { inputs: input.inputs }) },
            signal,
            repo: `${owner}/${repo}`,
        });
        return { ok: true, workflowId: String(workflowId), ref: input.ref };
    }

    // ---- V1.1 Level-3: Contents write / delete + Branch --------------------

    /** PUT /repos/{owner}/{repo}/contents/{path} — create or update a file. */
    async writeContents(
        owner: string,
        repo: string,
        path: string,
        input: { message: string; content: string; sha?: string; branch?: string },
        signal?: AbortSignal,
    ): Promise<GitHubContentsEntryView> {
        const raw = await this.request<{
            content: { path: string; sha: string; type: string };
            commit: { sha: string };
        }>(`/repos/${owner}/${repo}/contents/${path.replace(/^\/+/, '')}`, {
            method: 'PUT',
            body: {
                message: input.message,
                content: Buffer.from(input.content, 'utf8').toString('base64'),
                ...(input.sha === undefined ? {} : { sha: input.sha }),
                ...(input.branch === undefined ? {} : { branch: input.branch }),
            },
            signal,
            repo: `${owner}/${repo}`,
        });
        if (raw === undefined) throw new Error('GitHub returned an empty contents-write response');
        return {
            path: raw.content.path,
            sha: raw.content.sha,
            type: raw.content.type,
            commitSha: raw.commit?.sha,
            content: 'updated',
        };
    }

    /** DELETE /repos/{owner}/{repo}/contents/{path} — delete a file (requires SHA). */
    async deleteContents(
        owner: string,
        repo: string,
        path: string,
        input: { message: string; sha: string; branch?: string },
        signal?: AbortSignal,
    ): Promise<GitHubContentsDeleteView> {
        const raw = await this.request<{ commit: { sha: string } }>(
            `/repos/${owner}/${repo}/contents/${path.replace(/^\/+/, '')}`,
            {
                method: 'DELETE',
                body: { message: input.message, sha: input.sha, ...(input.branch === undefined ? {} : { branch: input.branch }) },
                signal,
                repo: `${owner}/${repo}`,
            },
        );
        if (raw === undefined) throw new Error('GitHub returned an empty contents-delete response');
        return { path, commitSha: raw.commit?.sha, deleted: true };
    }

    /** GET /repos/{owner}/{repo}/branches */
    async listBranches(owner: string, repo: string, signal?: AbortSignal): Promise<GitHubBranchView[]> {
        const raw = await this.request<Array<{ name: string; protected: boolean; commit: { sha: string } }>>(
            `/repos/${owner}/${repo}/branches`,
            { signal, repo: `${owner}/${repo}` },
        );
        return (raw ?? []).map((branch) => ({ name: branch.name, protected: branch.protected, sha: branch.commit.sha }));
    }

    /** GET /repos/{owner}/{repo}/branches/{branch} */
    async getBranch(owner: string, repo: string, branch: string, signal?: AbortSignal): Promise<GitHubBranchView | undefined> {
        const raw = await this.request<{ name: string; protected: boolean; commit: { sha: string } }>(
            `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`,
            { signal, repo: `${owner}/${repo}`, notFoundIsUndefined: true },
        );
        if (raw === undefined) return undefined;
        return { name: raw.name, protected: raw.protected, sha: raw.commit.sha };
    }

    /** POST /repos/{owner}/{repo}/git/refs — create a branch from a base SHA. */
    async createBranch(
        owner: string,
        repo: string,
        branch: string,
        baseSha: string,
        signal?: AbortSignal,
    ): Promise<GitHubRefView> {
        const raw = await this.request<{ ref: string; object: { sha: string } }>(
            `/repos/${owner}/${repo}/git/refs`,
            { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: baseSha }, signal, repo: `${owner}/${repo}` },
        );
        if (raw === undefined) throw new Error('GitHub returned an empty git-refs response');
        return { ref: raw.ref, sha: raw.object.sha };
    }

    // ---- V1.1 Level-3: Workflow runs / jobs / logs --------------------------

    /** GET /repos/{o}/{r}/actions/runs */
    async listWorkflowRuns(
        owner: string,
        repo: string,
        options: { workflowId?: string; branch?: string; status?: string; perPage?: number; event?: string },
        signal?: AbortSignal,
    ): Promise<GitHubSearchResult<GitHubWorkflowRunView>> {
        const params = new URLSearchParams();
        if (options.workflowId !== undefined) params.set('workflow_id', options.workflowId);
        if (options.branch !== undefined) params.set('branch', options.branch);
        if (options.status !== undefined) params.set('status', options.status);
        if (options.event !== undefined) params.set('event', options.event);
        if (options.perPage !== undefined) params.set('per_page', String(options.perPage));
        const qs = params.toString();
        const raw = await this.request<{
            total_count: number;
            workflow_runs: Array<{
                id: number; name?: string; run_number: number; status: string; conclusion?: string | null;
                head_branch: string; head_sha: string; workflow_id?: number; display_title?: string;
                created_at: string | null; updated_at: string | null; run_started_at: string | null;
                html_url: string; event?: string;
            }>;
        }>(`/repos/${owner}/${repo}/actions/runs${qs === '' ? '' : `?${qs}`}`, { signal, repo: `${owner}/${repo}` });
        if (raw === undefined) throw new Error('GitHub returned no workflow-runs body');
        return {
            totalCount: raw.total_count,
            items: raw.workflow_runs.map((run) => ({
                id: run.id,
                name: run.display_title ?? run.name,
                runNumber: run.run_number,
                status: run.status,
                conclusion: run.conclusion ?? undefined,
                headBranch: run.head_branch,
                headSha: run.head_sha,
                workflowId: run.workflow_id,
                createdAt: run.created_at ?? undefined,
                updatedAt: run.updated_at ?? undefined,
                runStartedAt: run.run_started_at ?? undefined,
                htmlUrl: run.html_url,
                event: run.event,
            })),
        };
    }

    /** GET /repos/{o}/{r}/actions/runs/{run_id} */
    async getWorkflowRun(
        owner: string,
        repo: string,
        runId: number,
        signal?: AbortSignal,
    ): Promise<GitHubWorkflowRunView> {
        const raw = await this.request<{
            id: number; name?: string; run_number: number; status: string; conclusion?: string | null;
            head_branch: string; head_sha: string; workflow_id?: number; display_title?: string;
            created_at: string | null; updated_at: string | null; run_started_at: string | null;
            html_url: string; event?: string;
        }>(`/repos/${owner}/${repo}/actions/runs/${runId}`, { signal, repo: `${owner}/${repo}` });
        if (raw === undefined) throw new Error('GitHub returned no workflow-run body');
        return {
            id: raw.id,
            name: raw.display_title ?? raw.name,
            runNumber: raw.run_number,
            status: raw.status,
            conclusion: raw.conclusion ?? undefined,
            headBranch: raw.head_branch,
            headSha: raw.head_sha,
            workflowId: raw.workflow_id,
            createdAt: raw.created_at ?? undefined,
            updatedAt: raw.updated_at ?? undefined,
            runStartedAt: raw.run_started_at ?? undefined,
            htmlUrl: raw.html_url,
            event: raw.event,
        };
    }

    /** GET /repos/{o}/{r}/actions/runs/{run_id}/jobs */
    async listWorkflowJobs(
        owner: string,
        repo: string,
        runId: number,
        signal?: AbortSignal,
    ): Promise<GitHubWorkflowJobView[]> {
        const raw = await this.request<{
            jobs: Array<{
                id: number; name: string; run_id: number; status: string; conclusion?: string | null;
                started_at: string | null; completed_at: string | null; html_url: string;
            }>;
        }>(`/repos/${owner}/${repo}/actions/runs/${runId}/jobs`, { signal, repo: `${owner}/${repo}` });
        return (raw?.jobs ?? []).map((job) => ({
            id: job.id,
            name: job.name,
            runId: job.run_id,
            status: job.status,
            conclusion: job.conclusion ?? undefined,
            startedAt: job.started_at ?? undefined,
            completedAt: job.completed_at ?? undefined,
            htmlUrl: job.html_url,
        }));
    }

    /** GET /repos/{o}/{r}/actions/runs/{run_id}/jobs/{job_id}/logs — raw, external/untrusted. */
    async getJobLogs(owner: string, repo: string, jobId: number, runId: number, signal?: AbortSignal): Promise<GitHubWorkflowLogsView> {
        // The logs endpoint returns text/plain; request() JSON-parses, so fetch
        // the raw bytes through a dedicated call that never JSON-parses.
        const controller = new AbortController();
        const forwardSignal = signal;
        const onOuterAbort = (): void => controller.abort(forwardSignal?.reason);
        if (forwardSignal !== undefined) {
            if (forwardSignal.aborted) onOuterAbort();
            else forwardSignal.addEventListener('abort', onOuterAbort, { once: true });
        }
        const timer = setTimeout(() => controller.abort(new Error(`GitHub logs timeout after ${this.timeoutMs}ms`)), this.timeoutMs);
        timer.unref?.();
        try {
            const response = await fetch(`${this.apiBaseUrl}/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`, {
                headers: { accept: 'text/plain', 'x-github-api-version': GITHUB_API_VERSION, authorization: `Bearer ${this.token}` },
                signal: controller.signal,
            });
            if (!response.ok) {
                throw new GitHubApiError({
                    status: response.status,
                    method: 'GET',
                    path: `/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`,
                    message: `failed to fetch workflow logs (HTTP ${response.status})`,
                });
            }
            const log = await response.text();
            return { runId, log };
        } finally {
            clearTimeout(timer);
            if (forwardSignal !== undefined) forwardSignal.removeEventListener('abort', onOuterAbort);
        }
    }

    /** POST /repos/{o}/{r}/actions/runs/{run_id}/rerun — high-risk CI trigger. */
    async rerunWorkflow(owner: string, repo: string, runId: number, signal?: AbortSignal): Promise<{ ok: true; runId: number }> {
        await this.request<unknown>(`/repos/${owner}/${repo}/actions/runs/${runId}/rerun`, {
            method: 'POST', body: {}, signal, repo: `${owner}/${repo}`,
        });
        return { ok: true, runId };
    }

    /** POST /repos/{o}/{r}/actions/runs/{run_id}/rerun-failed-jobs */
    async rerunFailedJobs(owner: string, repo: string, runId: number, signal?: AbortSignal): Promise<{ ok: true; runId: number }> {
        await this.request<unknown>(`/repos/${owner}/${repo}/actions/runs/${runId}/rerun-failed-jobs`, {
            method: 'POST', body: {}, signal, repo: `${owner}/${repo}`,
        });
        return { ok: true, runId };
    }

    /** POST /repos/{o}/{r}/actions/runs/{run_id}/cancel — high-risk CI control. */
    async cancelWorkflow(owner: string, repo: string, runId: number, signal?: AbortSignal): Promise<{ ok: true; runId: number }> {
        await this.request<unknown>(`/repos/${owner}/${repo}/actions/runs/${runId}/cancel`, {
            method: 'POST', body: {}, signal, repo: `${owner}/${repo}`,
        });
        return { ok: true, runId };
    }

    // ---- V1.1 Level-3: Pull request reviews / files -------------------------

    /** GET /repos/{o}/{r}/pulls/{n}/reviews */
    async listReviews(owner: string, repo: string, pullNumber: number, signal?: AbortSignal): Promise<GitHubReviewView[]> {
        const raw = await this.request<Array<{
            id: number; user: { login?: string } | null; state: GitHubReviewState;
            submitted_at: string | null; body: string | null; commit_id: string | null;
        }>>(`/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`, { signal, repo: `${owner}/${repo}` });
        return (raw ?? []).map((r) => ({
            id: r.id,
            user: r.user?.login,
            state: r.state,
            submittedAt: r.submitted_at ?? undefined,
            body: r.body ?? undefined,
            commitId: r.commit_id ?? undefined,
        }));
    }

    /** GET /repos/{o}/{r}/pulls/{n}/reviews/{review_id} */
    async getReview(owner: string, repo: string, pullNumber: number, reviewId: number, signal?: AbortSignal): Promise<GitHubReviewView> {
        const raw = await this.request<{
            id: number; user: { login?: string } | null; state: GitHubReviewState;
            submitted_at: string | null; body: string | null; commit_id: string | null;
        }>(`/repos/${owner}/${repo}/pulls/${pullNumber}/reviews/${reviewId}`, { signal, repo: `${owner}/${repo}` });
        if (raw === undefined) throw new Error('GitHub returned no review body');
        return {
            id: raw.id, user: raw.user?.login, state: raw.state,
            submittedAt: raw.submitted_at ?? undefined, body: raw.body ?? undefined, commitId: raw.commit_id ?? undefined,
        };
    }

    /** POST /repos/{o}/{r}/pulls/{n}/reviews — submit approve/comment/request_changes. HIGH-risk. */
    async submitReview(
        owner: string,
        repo: string,
        pullNumber: number,
        input: { body?: string; event: 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES' },
        signal?: AbortSignal,
    ): Promise<GitHubReviewView> {
        const raw = await this.request<{
            id: number; user: { login?: string } | null; state: GitHubReviewState;
            submitted_at: string | null; body: string | null; commit_id: string | null;
        }>(`/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`, {
            method: 'POST', body: input, signal, repo: `${owner}/${repo}`,
        });
        if (raw === undefined) throw new Error('GitHub returned no review body');
        return {
            id: raw.id, user: raw.user?.login, state: raw.state,
            submittedAt: raw.submitted_at ?? undefined, body: raw.body ?? undefined, commitId: raw.commit_id ?? undefined,
        };
    }

    /** POST /repos/{o}/{r}/pulls/{n}/requested_reviewers — HIGH-risk. */
    async requestReviewers(
        owner: string,
        repo: string,
        pullNumber: number,
        reviewers: readonly string[],
        signal?: AbortSignal,
    ): Promise<{ ok: true; pullNumber: number; reviewers: readonly string[] }> {
        await this.request<unknown>(`/repos/${owner}/${repo}/pulls/${pullNumber}/requested_reviewers`, {
            method: 'POST', body: { reviewers: [...reviewers] }, signal, repo: `${owner}/${repo}`,
        });
        return { ok: true, pullNumber, reviewers };
    }

    /** GET /repos/{o}/{r}/pulls/{n}/requested_reviewers */
    async listRequestedReviewers(owner: string, repo: string, pullNumber: number, signal?: AbortSignal): Promise<string[]> {
        const raw = await this.request<{ users: Array<{ login?: string }> }>(
            `/repos/${owner}/${repo}/pulls/${pullNumber}/requested_reviewers`,
            { signal, repo: `${owner}/${repo}` },
        );
        return (raw?.users ?? []).map((u) => u.login ?? '').filter((n) => n !== '');
    }

    /** GET /repos/{o}/{r}/pulls/{n}/files */
    async listPullFiles(owner: string, repo: string, pullNumber: number, signal?: AbortSignal): Promise<GitHubPullFileView[]> {
        const raw = await this.request<Array<{
            filename: string; status: string; additions: number; deletions: number; changes: number;
            patch?: string; raw_url?: string; sha: string;
        }>>(`/repos/${owner}/${repo}/pulls/${pullNumber}/files`, { signal, repo: `${owner}/${repo}` });
        return (raw ?? []).map((f) => ({
            filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions,
            changes: f.changes, patch: f.patch, rawUrl: f.raw_url, sha: f.sha,
        }));
    }

    // ---- V1.1 Level-3: Code search + Commits --------------------------------

    /** GET /search/code?q=... (requires authentication; repo-scoped by the caller). */
    async searchCode(query: string, perPage: number, signal?: AbortSignal): Promise<GitHubSearchResult<GitHubCodeSearchHitView>> {
        const raw = await this.request<{
            total_count: number;
            items: Array<{
                name: string; path: string; html_url?: string;
                repository?: { full_name?: string };
                text_matches?: Array<{ fragment?: string }>;
            }>;
        }>(`/search/code?q=${encodeURIComponent(query)}&per_page=${perPage}`, { signal });
        if (raw === undefined) throw new Error('GitHub search/code returned no body');
        return {
            totalCount: raw.total_count,
            items: raw.items.map((i) => ({
                name: i.name,
                path: i.path,
                repo: i.repository?.full_name,
                htmlUrl: i.html_url,
                textMatches: i.text_matches?.map((tm) => tm.fragment ?? '').filter((f) => f !== ''),
            })),
        };
    }

    /** GET /repos/{o}/{r}/commits */
    async listCommits(owner: string, repo: string, options: { branch?: string; perPage?: number; path?: string }, signal?: AbortSignal): Promise<GitHubCommitView[]> {
        const params = new URLSearchParams();
        if (options.branch !== undefined) params.set('sha', options.branch);
        if (options.path !== undefined) params.set('path', options.path);
        if (options.perPage !== undefined) params.set('per_page', String(options.perPage));
        const qs = params.toString();
        const raw = await this.request<Array<{
            sha: string; commit: { message: string; author: { name?: string; date?: string } | null };
            html_url?: string;
        }>>(`/repos/${owner}/${repo}/commits${qs === '' ? '' : `?${qs}`}`, { signal, repo: `${owner}/${repo}` });
        return (raw ?? []).map((c) => ({
            sha: c.sha, message: c.commit.message, author: c.commit.author?.name,
            committedAt: c.commit.author?.date, htmlUrl: c.html_url,
        }));
    }

    /** GET /repos/{o}/{r}/commits/{ref} */
    async getCommit(owner: string, repo: string, ref: string, signal?: AbortSignal): Promise<GitHubCommitView> {
        const raw = await this.request<{
            sha: string; commit: { message: string; author: { name?: string; date?: string } | null };
            html_url?: string;
        }>(`/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`, { signal, repo: `${owner}/${repo}` });
        if (raw === undefined) throw new Error('GitHub returned no commit body');
        return { sha: raw.sha, message: raw.commit.message, author: raw.commit.author?.name, committedAt: raw.commit.author?.date, htmlUrl: raw.html_url };
    }

    // ---- V1.1 Level-3: Releases / Labels / Milestones -----------------------

    /** GET /repos/{o}/{r}/releases */
    async listReleases(owner: string, repo: string, perPage: number, signal?: AbortSignal): Promise<GitHubReleaseView[]> {
        const raw = await this.request<Array<{
            id: number; tag_name: string; name: string | null; body: string | null; draft: boolean;
            prerelease: boolean; published_at: string | null; html_url: string;
            assets: Array<{ name: string; size: number }>;
        }>>(`/repos/${owner}/${repo}/releases?per_page=${perPage}`, { signal, repo: `${owner}/${repo}` });
        return (raw ?? []).map((r) => ({
            id: r.id, tagName: r.tag_name, name: r.name ?? undefined, body: r.body ?? undefined,
            draft: r.draft, prerelease: r.prerelease, publishedAt: r.published_at ?? undefined,
            htmlUrl: r.html_url, assets: r.assets.map((a) => ({ name: a.name, size: a.size })),
        }));
    }

    /** GET /repos/{o}/{r}/releases/{release_id} */
    async getRelease(owner: string, repo: string, releaseId: number, signal?: AbortSignal): Promise<GitHubReleaseView> {
        const raw = await this.request<{
            id: number; tag_name: string; name: string | null; body: string | null; draft: boolean;
            prerelease: boolean; published_at: string | null; html_url: string;
            assets: Array<{ name: string; size: number }>;
        }>(`/repos/${owner}/${repo}/releases/${releaseId}`, { signal, repo: `${owner}/${repo}` });
        if (raw === undefined) throw new Error('GitHub returned no release body');
        return {
            id: raw.id, tagName: raw.tag_name, name: raw.name ?? undefined, body: raw.body ?? undefined,
            draft: raw.draft, prerelease: raw.prerelease, publishedAt: raw.published_at ?? undefined,
            htmlUrl: raw.html_url, assets: raw.assets.map((a) => ({ name: a.name, size: a.size })),
        };
    }

    /** POST /repos/{o}/{r}/releases — HIGH-risk. */
    async createRelease(
        owner: string,
        repo: string,
        input: { tagName: string; name?: string; body?: string; draft?: boolean; prerelease?: boolean },
        signal?: AbortSignal,
    ): Promise<GitHubReleaseView> {
        const raw = await this.request<{
            id: number; tag_name: string; name: string | null; body: string | null; draft: boolean;
            prerelease: boolean; published_at: string | null; html_url: string; assets: [];
        }>(`/repos/${owner}/${repo}/releases`, { method: 'POST', body: input, signal, repo: `${owner}/${repo}` });
        if (raw === undefined) throw new Error('GitHub returned no release body');
        const r = raw;
        return {
            id: r.id, tagName: r.tag_name, name: r.name ?? undefined, body: r.body ?? undefined, draft: r.draft,
            prerelease: r.prerelease, publishedAt: r.published_at ?? undefined, htmlUrl: r.html_url, assets: r.assets ?? [],
        };
    }

    /** PATCH /repos/{o}/{r}/releases/{release_id} — HIGH-risk. */
    async updateRelease(
        owner: string,
        repo: string,
        releaseId: number,
        input: { name?: string; body?: string; draft?: boolean; prerelease?: boolean },
        signal?: AbortSignal,
    ): Promise<GitHubReleaseView> {
        const raw = await this.request<{
            id: number; tag_name: string; name: string | null; body: string | null; draft: boolean;
            prerelease: boolean; published_at: string | null; html_url: string; assets: [];
        }>(`/repos/${owner}/${repo}/releases/${releaseId}`, { method: 'PATCH', body: input, signal, repo: `${owner}/${repo}` });
        if (raw === undefined) throw new Error('GitHub returned no release body');
        const r = raw;
        return {
            id: r.id, tagName: r.tag_name, name: r.name ?? undefined, body: r.body ?? undefined, draft: r.draft,
            prerelease: r.prerelease, publishedAt: r.published_at ?? undefined, htmlUrl: r.html_url, assets: r.assets ?? [],
        };
    }

    /** GET /repos/{o}/{r}/labels */
    async listLabels(owner: string, repo: string, signal?: AbortSignal): Promise<GitHubLabelView[]> {
        const raw = await this.request<Array<{ name: string; color: string; description?: string }>>(
            `/repos/${owner}/${repo}/labels`, { signal, repo: `${owner}/${repo}` },
        );
        return (raw ?? []).map((l) => ({ name: l.name, color: l.color, description: l.description }));
    }

    /** POST /repos/{o}/{r}/labels — HIGH-risk. */
    async createLabel(
        owner: string, repo: string, input: { name: string; color: string; description?: string }, signal?: AbortSignal,
    ): Promise<GitHubLabelView> {
        const raw = await this.request<{ name: string; color: string; description?: string }>(
            `/repos/${owner}/${repo}/labels`, { method: 'POST', body: input, signal, repo: `${owner}/${repo}` },
        );
        if (raw === undefined) throw new Error('GitHub returned no label body');
        return raw;
    }

    /** POST /repos/{o}/{r}/issues/{n}/labels — add labels. HIGH-risk. */
    async addIssueLabels(owner: string, repo: string, issueNumber: number, labels: readonly string[], signal?: AbortSignal): Promise<string[]> {
        const raw = await this.request<Array<{ name?: string }>>(
            `/repos/${owner}/${repo}/issues/${issueNumber}/labels`, { method: 'POST', body: { labels: [...labels] }, signal, repo: `${owner}/${repo}` },
        );
        return (raw ?? []).map((l) => l.name ?? '').filter((n) => n !== '');
    }

    /** DELETE /repos/{o}/{r}/issues/{n}/labels/{name} — remove a label. HIGH-risk. */
    async removeIssueLabel(owner: string, repo: string, issueNumber: number, label: string, signal?: AbortSignal): Promise<{ ok: true }> {
        await this.request<unknown>(`/repos/${owner}/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`, {
            method: 'DELETE', signal, repo: `${owner}/${repo}`,
        });
        return { ok: true };
    }

    /** GET /repos/{o}/{r}/milestones */
    async listMilestones(owner: string, repo: string, options: { state?: string; perPage?: number }, signal?: AbortSignal): Promise<GitHubMilestoneView[]> {
        const params = new URLSearchParams();
        if (options.state !== undefined) params.set('state', options.state);
        if (options.perPage !== undefined) params.set('per_page', String(options.perPage));
        const qs = params.toString();
        const raw = await this.request<Array<{
            number: number; title: string; state: string; description?: string; open_issues: number;
            closed_issues: number; due_on?: string;
        }>>(`/repos/${owner}/${repo}/milestones${qs === '' ? '' : `?${qs}`}`, { signal, repo: `${owner}/${repo}` });
        return (raw ?? []).map((m) => ({
            number: m.number, title: m.title, state: m.state, description: m.description,
            openIssues: m.open_issues, closedIssues: m.closed_issues, dueOn: m.due_on,
        }));
    }

    /** GET /repos/{o}/{r}/milestones/{n} */
    async getMilestone(owner: string, repo: string, milestoneNumber: number, signal?: AbortSignal): Promise<GitHubMilestoneView> {
        const raw = await this.request<{
            number: number; title: string; state: string; description?: string; open_issues: number;
            closed_issues: number; due_on?: string;
        }>(`/repos/${owner}/${repo}/milestones/${milestoneNumber}`, { signal, repo: `${owner}/${repo}` });
        if (raw === undefined) throw new Error('GitHub returned no milestone body');
        return {
            number: raw.number, title: raw.title, state: raw.state, description: raw.description,
            openIssues: raw.open_issues, closedIssues: raw.closed_issues, dueOn: raw.due_on,
        };
    }

    /** POST /repos/{o}/{r}/milestones — HIGH-risk. */
    async createMilestone(
        owner: string, repo: string, input: { title: string; description?: string; dueOn?: string; state?: string }, signal?: AbortSignal,
    ): Promise<GitHubMilestoneView> {
        const raw = await this.request<{
            number: number; title: string; state: string; description?: string; open_issues: number;
            closed_issues: number; due_on?: string;
        }>(`/repos/${owner}/${repo}/milestones`, { method: 'POST', body: input, signal, repo: `${owner}/${repo}` });
        if (raw === undefined) throw new Error('GitHub returned no milestone body');
        return {
            number: raw.number, title: raw.title, state: raw.state, description: raw.description,
            openIssues: raw.open_issues, closedIssues: raw.closed_issues, dueOn: raw.due_on,
        };
    }

    /** PATCH /repos/{o}/{r}/milestones/{n} — HIGH-risk (update/close). */
    async updateMilestone(
        owner: string, repo: string, milestoneNumber: number, input: { title?: string; description?: string; dueOn?: string; state?: string }, signal?: AbortSignal,
    ): Promise<GitHubMilestoneView> {
        const raw = await this.request<{
            number: number; title: string; state: string; description?: string; open_issues: number;
            closed_issues: number; due_on?: string;
        }>(`/repos/${owner}/${repo}/milestones/${milestoneNumber}`, { method: 'PATCH', body: input, signal, repo: `${owner}/${repo}` });
        if (raw === undefined) throw new Error('GitHub returned no milestone body');
        return {
            number: raw.number, title: raw.title, state: raw.state, description: raw.description,
            openIssues: raw.open_issues, closedIssues: raw.closed_issues, dueOn: raw.due_on,
        };
    }
}
