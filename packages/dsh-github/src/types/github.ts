/**
 * Shared type surface for the DSH GitHub plugin.
 *
 * The plugin gives DSH agents a model-facing GitHub toolset (repos, issues,
 * pull requests, workflow dispatch) backed by the GitHub REST API, and — when
 * configured — a signed webhook receiver that feeds repository events into a
 * DSH agent session so the agent can react and reply through the same tools.
 *
 * The plugin deliberately does NOT run an LLM. Agent/LLM execution stays in the
 * DSH runtime; this plugin only calls the GitHub REST API on the agent's behalf
 * and feeds inbound webhook events into an existing DSH agent.
 *
 * @module dsh-github/types
 */

/** A GitHub event name carried by the `X-GitHub-Event` webhook header. */
export type GitHubWebhookEventName =
    | 'issues'
    | 'issue_comment'
    | 'pull_request'
    | 'pull_request_review'
    | 'pull_request_review_comment'
    | 'push'
    | 'workflow_run'
    | 'workflow_job'
    | 'create'
    | 'delete'
    | 'release'
    | 'star'
    | 'fork'
    | 'watch'
    | (string & {});

/** Canonical, model-facing view of one repository (curated REST response). */
export interface GitHubRepoView {
    readonly fullName: string;
    readonly description?: string;
    readonly htmlUrl: string;
    readonly defaultBranch: string;
    readonly language?: string;
    readonly stars: number;
    readonly forks: number;
    readonly openIssues: number;
    readonly private: boolean;
    readonly archived: boolean;
    readonly license?: string;
    readonly topics: string[];
    readonly pushedAt?: string;
    readonly homepage?: string;
}

/** Canonical, model-facing view of one issue or pull request. */
export interface GitHubIssueView {
    readonly number: number;
    readonly title: string;
    readonly state: 'open' | 'closed' | (string & {});
    readonly htmlUrl: string;
    readonly user?: string;
    readonly createdAt?: string;
    readonly updatedAt?: string;
    readonly closedAt?: string;
    readonly labels: string[];
    readonly body?: string;
    /** Present when this issue entry is actually a pull request. */
    readonly pullRequest?: boolean;
    readonly comments?: number;
}

/** Canonical, model-facing view of one issue/PR comment. */
export interface GitHubCommentView {
    readonly id: number;
    readonly user?: string;
    readonly body: string;
    readonly htmlUrl: string;
    readonly createdAt?: string;
}

/** Canonical, model-facing view of one pull request. */
export interface GitHubPullView {
    readonly number: number;
    readonly title: string;
    readonly state: string;
    readonly htmlUrl: string;
    readonly user?: string;
    readonly createdAt?: string;
    readonly updatedAt?: string;
    readonly mergedAt?: string;
    readonly draft: boolean;
    readonly merged: boolean;
    readonly mergeable?: boolean;
    readonly head: { readonly ref: string; readonly sha: string; readonly repo?: string };
    readonly base: { readonly ref: string; readonly sha: string; readonly repo?: string };
    readonly body?: string;
}

/** Canonical, model-facing view of one repository file (contents). */
export interface GitHubFileView {
    readonly path: string;
    readonly size: number;
    readonly sha: string;
    readonly type: 'file' | 'dir' | 'submodule' | 'symlink' | (string & {});
    readonly htmlUrl?: string;
    /** Decoded UTF-8 text content, present only for regular files. */
    readonly content?: string;
}

/** Canonical result of a search. */
export interface GitHubSearchResult<T> {
    readonly totalCount: number;
    readonly items: T[];
}

/** Canonical, model-facing view of one Actions workflow. */
export interface GitHubWorkflowView {
    readonly id: number;
    readonly name: string;
    readonly path: string;
    readonly state: string;
    readonly createdAt?: string;
    readonly updatedAt?: string;
}

/** Canonical result of a workflow-dispatch call (GitHub returns 204). */
export interface GitHubDispatchView {
    readonly ok: true;
    /** The dispatched workflow id or file name (string form). */
    readonly workflowId: string;
    readonly ref: string;
}

// ---- V1.1 Level-3 views ----------------------------------------------------

/** Canonical, model-facing view of one branch. */
export interface GitHubBranchView {
    readonly name: string;
    readonly protected: boolean;
    /** Head commit SHA of the branch. */
    readonly sha: string;
}

/** Canonical, model-facing view of a branch reference mutation (create). */
export interface GitHubRefView {
    readonly ref: string;
    readonly sha: string;
}

/** Canonical, model-facing view of one file mutation (create/update). */
export interface GitHubContentsEntryView {
    readonly path: string;
    readonly sha: string;
    /** 'file' on success; mutation responses return the committed entry. */
    readonly type: string;
    /** Commit SHA from the mutation response's `commit.sha`, when present. */
    readonly commitSha?: string;
    /** `updated` when the mutating call succeeded. */
    readonly content: string;
}

/** Canonical result of a file delete (GitHub returns a commit object). */
export interface GitHubContentsDeleteView {
    readonly path: string;
    /** The delete commit SHA. */
    readonly commitSha: string;
    readonly deleted: true;
}

/** Canonical, model-facing view of one workflow run. */
export interface GitHubWorkflowRunView {
    readonly id: number;
    readonly name?: string;
    readonly runNumber: number;
    readonly status: string;
    readonly conclusion?: string;
    readonly headBranch: string;
    readonly headSha: string;
    readonly workflowId?: number;
    readonly workflowName?: string;
    readonly createdAt?: string;
    readonly updatedAt?: string;
    readonly runStartedAt?: string;
    readonly htmlUrl: string;
    readonly event?: string;
}

/** Canonical, model-facing view of one Actions job. */
export interface GitHubWorkflowJobView {
    readonly id: number;
    readonly name: string;
    readonly runId: number;
    readonly status: string;
    readonly conclusion?: string;
    readonly startedAt?: string;
    readonly completedAt?: string;
    readonly htmlUrl: string;
}

/** Raw log output from a workflow job (external/untrusted content). */
export interface GitHubWorkflowLogsView {
    readonly runId: number;
    readonly log: string;
}

/** GitHub Review states. */
export type GitHubReviewState = 'approved' | 'changes_requested' | 'commented' | 'dismissed' | (string & {});

/** Canonical, model-facing view of one PR review. */
export interface GitHubReviewView {
    readonly id: number;
    readonly user?: string;
    readonly state: GitHubReviewState;
    readonly submittedAt?: string;
    readonly body?: string;
    readonly commitId?: string;
}

/** Canonical, model-facing view of one PR file change. */
export interface GitHubPullFileView {
    readonly filename: string;
    readonly status: string;
    readonly additions: number;
    readonly deletions: number;
    readonly changes: number;
    readonly patch?: string;
    readonly rawUrl?: string;
    readonly sha: string;
}

/** Canonical, model-facing view of one commit. */
export interface GitHubCommitView {
    readonly sha: string;
    readonly message: string;
    readonly author?: string;
    readonly committedAt?: string;
    readonly htmlUrl?: string;
}

/** Canonical, model-facing view of a code search hit. */
export interface GitHubCodeSearchHitView {
    readonly name: string;
    readonly path: string;
    readonly repo?: string;
    readonly htmlUrl?: string;
    readonly textMatches?: readonly string[];
}

/** Canonical, model-facing view of one release. */
export interface GitHubReleaseView {
    readonly id: number;
    readonly tagName: string;
    readonly name?: string;
    readonly body?: string;
    readonly draft: boolean;
    readonly prerelease: boolean;
    readonly publishedAt?: string;
    readonly htmlUrl: string;
    readonly assets: readonly { name: string; size: number }[];
}

/** Canonical, model-facing view of one label. */
export interface GitHubLabelView {
    readonly name: string;
    readonly color: string;
    readonly description?: string;
}

/** Canonical, model-facing view of one milestone. */
export interface GitHubMilestoneView {
    readonly number: number;
    readonly title: string;
    readonly state: string;
    readonly description?: string;
    readonly openIssues: number;
    readonly closedIssues: number;
    readonly dueOn?: string;
}

/** Options for constructing the GitHub REST client. */
export interface GitHubClientOptions {
    /** GitHub API base URL; defaults to https://api.github.com (GHES override). */
    readonly apiBaseUrl?: string;
    /** Fine-grained or classic PAT. Falls back to the `tokenEnv` variable. */
    readonly token?: string;
    /** Environment variable holding the token when `token` is unset (default `GITHUB_TOKEN`). */
    readonly tokenEnv?: string;
    /** Per-request cooperative timeout in milliseconds (default 30000). */
    readonly requestTimeoutMs?: number;
}

/**
 * A GitHub REST error normalized for the model: HTTP status, method, path, the
 * API's `message` (with a rate-limit notice when the limit was exhausted), and
 * the `documentation_url` when GitHub supplied one.
 */
export class GitHubApiError extends Error {
    readonly status: number;
    readonly method: string;
    readonly path: string;
    readonly documentationUrl?: string;
    readonly rateLimited: boolean;

    constructor(options: {
        status: number;
        method: string;
        path: string;
        message: string;
        documentationUrl?: string;
        rateLimited?: boolean;
    }) {
        super(`GitHub API ${options.method} ${options.path} -> ${options.status}: ${options.message}`);
        this.name = 'GitHubApiError';
        this.status = options.status;
        this.method = options.method;
        this.path = options.path;
        this.documentationUrl = options.documentationUrl;
        this.rateLimited = options.rateLimited ?? false;
    }
}

/**
 * Provenance attached to inbound user messages this plugin feeds into a DSH
 * agent. Registered as a merge-extensible entry of `MessageSourceMap`, so the
 * agent's durable transcript records *which GitHub event* a message came from.
 */
export interface GitHubMessageSource {
    readonly kind: 'github';
    /** The webhook event name (`issues`, `pull_request`, ...). */
    readonly event: GitHubWebhookEventName;
    /** GitHub delivery id from the `X-GitHub-Delivery` header, when known. */
    readonly deliveryId?: string;
    /** `owner/repo` the event concerns, when known. */
    readonly repo?: string;
    /** URL of the affected item, when known. */
    readonly htmlUrl?: string;
}

declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        github: GitHubMessageSource;
    }
}
