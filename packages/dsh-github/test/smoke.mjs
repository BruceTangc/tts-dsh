/**
 * Offline smoke test for @dsh/github. No network: a local node:http stub
 * stands in for api.github.com, and the webhook receiver is exercised against
 * a fake DSH `webServer`/`agents` context.
 *
 * Run: `node test/smoke.mjs` (after `pnpm build`).
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
    GitHubClient,
    GitHubApiError,
    verifyGitHubSignature,
    normalizeWebhookEvent,
    GitHubWebhookHandler,
} from '../lib/index.js';

process.on('unhandledRejection', (reason) => {
    console.error('UNHANDLED REJECTION:', reason);
});
process.on('uncaughtException', (error) => {
    console.error('UNCAUGHT EXCEPTION:', error);
});

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let passed = 0;
let failed = 0;

function ok(name) {
    passed += 1;
    console.log(`  ok - ${name}`);
}

function check(name, fn) {
    try {
        fn();
        ok(name);
    } catch (error) {
        failed += 1;
        console.error(`  FAIL - ${name}: ${error.message}`);
    }
}

async function checkAsync(name, fn) {
    try {
        await fn();
        ok(name);
    } catch (error) {
        failed += 1;
        console.error(`  FAIL - ${name}: ${error.message}`);
    }
}

// ---------------------------------------------------------------------------
// GitHub API stub
// ---------------------------------------------------------------------------

const token = 'ghp_fake_test_token';
const commonIssue = {
    number: 42,
    title: 'Smoke issue',
    state: 'open',
    html_url: 'https://github.com/acme/widget/issues/42',
    user: { login: 'octocat' },
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-02T00:00:00Z',
    closed_at: null,
    labels: [{ name: 'bug' }],
    body: 'Please fix.',
    comments: 3,
};
const commonPull = {
    number: 7,
    title: 'Smoke PR',
    state: 'open',
    html_url: 'https://github.com/acme/widget/pull/7',
    user: { login: 'octocat' },
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-02T00:00:00Z',
    merged_at: null,
    draft: false,
    merged: false,
    mergeable: true,
    head: { ref: 'feature/x', sha: 'abc123', repo: { full_name: 'acme/widget' } },
    base: { ref: 'main', sha: 'def456', repo: { full_name: 'acme/widget' } },
    body: 'Please merge.',
};
const commonFile = {
    path: 'README.md',
    size: 11,
    sha: 'aaaa',
    type: 'file',
    encoding: 'base64',
    content: Buffer.from('hello world').toString('base64'),
    html_url: 'https://github.com/acme/widget/blob/main/README.md',
};

/** Endpoint table: (method, pattern) -> response (or {status, body}). */
const routes = [
    {
        match: (req) => req.method === 'GET' && req.url === '/repos/acme/widget',
        respond: () => ({
            full_name: 'acme/widget',
            description: 'The widget',
            html_url: 'https://github.com/acme/widget',
            default_branch: 'main',
            language: 'TypeScript',
            stargazers_count: 123,
            forks_count: 12,
            open_issues_count: 5,
            private: false,
            archived: false,
            license: { name: 'MIT' },
            topics: ['typescript'],
            pushed_at: '2024-01-03T00:00:00Z',
            homepage: null,
        }),
    },
    {
        match: (req) => req.method === 'GET' && req.url.startsWith('/search/repositories?q='),
        respond: () => ({ total_count: 1, items: [] }),
    },
    {
        match: (req) => req.method === 'GET' && req.url === '/repos/acme/widget/issues?state=open&per_page=5',
        respond: () => [commonIssue],
    },
    {
        match: (req) => req.method === 'GET' && req.url === '/repos/acme/widget/issues/42',
        respond: () => commonIssue,
    },
    {
        match: (req) => req.method === 'POST' && req.url === '/repos/acme/widget/issues',
        respond: () => ({ ...commonIssue, number: 43, title: 'New issue' }),
    },
    {
        match: (req) => req.method === 'PATCH' && req.url === '/repos/acme/widget/issues/42',
        respond: () => ({ ...commonIssue, state: 'closed' }),
    },
    {
        match: (req) => req.method === 'POST' && req.url === '/repos/acme/widget/issues/42/comments',
        respond: () => ({
            id: 99,
            user: { login: 'octocat' },
            body: 'On it.',
            html_url: 'https://github.com/acme/widget/issues/42#issuecomment-99',
            created_at: '2024-01-04T00:00:00Z',
        }),
    },
    {
        match: (req) => req.method === 'GET' && req.url.startsWith('/repos/acme/widget/pulls?'),
        respond: () => [commonPull],
    },
    {
        match: (req) => req.method === 'GET' && req.url === '/repos/acme/widget/pulls/7',
        respond: () => commonPull,
    },
    {
        match: (req) => req.method === 'POST' && req.url === '/repos/acme/widget/pulls',
        respond: () => ({ ...commonPull, number: 8, title: 'Created PR' }),
    },
    {
        match: (req) => req.method === 'PUT' && req.url === '/repos/acme/widget/pulls/7/merge',
        respond: () => ({ merged: true, message: 'Pull Request successfully merged' }),
    },
    {
        match: (req) => req.method === 'GET' && req.url === '/repos/acme/widget/contents/README.md',
        respond: () => commonFile,
    },
    {
        match: (req) => req.method === 'GET' && req.url === '/repos/acme/widget/contents/src',
        respond: () => [{ path: 'src/main.ts', size: 5, sha: 'bbbb', type: 'file', html_url: 'https://x' }],
    },
    {
        match: (req) => req.method === 'GET' && req.url === '/repos/acme/widget/actions/workflows',
        respond: () => ({
            total_count: 1,
            workflows: [{ id: 5, name: 'CI', path: '.github/workflows/ci.yml', state: 'active', created_at: null, updated_at: null }],
        }),
    },
    {
        match: (req) => req.method === 'POST' && req.url.startsWith('/repos/acme/widget/actions/workflows/') && req.url.endsWith('/dispatches'),
        respond: () => null, // 204
        status: 204,
    },
    {
        // Error cases
        match: (req) => req.method === 'GET' && req.url === '/repos/acme/missing',
        respond: () => ({ message: 'Not Found', documentation_url: 'https://docs.github.com/rest' }),
        status: 404,
    },
    {
        match: (req) => req.method === 'GET' && req.url === '/repos/acme/ratelimited',
        respond: () => ({ message: 'API rate limit exceeded' }),
        status: 403,
        headers: { 'x-ratelimit-remaining': '0' },
    },
];

// ---- V1.1 Level-3 stub routes ----------------------------------------------
const v11routes = {
    writeContents: () => ({
        content: { path: 'src/a.ts', sha: 'newsha', type: 'file' },
        commit: { sha: 'commitwrite' },
    }),
    deleteContents: () => ({ commit: { sha: 'commitdel' } }),
    listBranches: () => [
        { name: 'main', protected: true, commit: { sha: 'aaa111' } },
        { name: 'feature/x', protected: false, commit: { sha: 'bbb222' } },
    ],
    getBranch: () => ({ name: 'main', protected: true, commit: { sha: 'aaa111' } }),
    createBranch: () => ({ ref: 'refs/heads/feature/new', object: { sha: 'aaa111' } }),
    listRuns: () => ({
        total_count: 2,
        workflow_runs: [
            { id: 100, display_title: 'CI', run_number: 5, status: 'completed', conclusion: 'success', head_branch: 'main', head_sha: 'aaabbb', created_at: '2024-01-01T00:00:00Z', updated_at: null, run_started_at: null, html_url: 'u', event: 'push' },
            { id: 99, display_title: 'CI', run_number: 4, status: 'completed', conclusion: 'failure', head_branch: 'main', head_sha: 'aaabbb', created_at: '2024-01-02T00:00:00Z', updated_at: null, run_started_at: null, html_url: 'u', event: 'push' },
        ],
    }),
    getRun: () => ({ id: 99, run_number: 4, status: 'completed', conclusion: 'failure', head_branch: 'main', head_sha: 'aaabbb', created_at: '2024-01-02T00:00:00Z', updated_at: null, run_started_at: null, html_url: 'u', event: 'push' }),
    listJobs: () => ({ jobs: [{ id: 1, name: 'build', run_id: 99, status: 'completed', conclusion: 'failure', started_at: null, completed_at: null, html_url: 'j' }] }),
    rerun: () => null,
    rerunFailed: () => null,
    cancel: () => null,
    listReviews: () => [{ id: 1, user: { login: 'alice' }, state: 'APPROVED', submitted_at: '2024-01-01T00:00:00Z', body: 'lgtm', commit_id: 'aaabbb' }],
    getReview: () => ({ id: 1, user: { login: 'alice' }, state: 'APPROVED', submitted_at: '2024-01-01T00:00:00Z', body: 'lgtm', commit_id: 'aaabbb' }),
    submitReview: () => ({ id: 2, user: { login: 'alice' }, state: 'APPROVED', submitted_at: '2024-01-01T00:00:00Z', body: 'ok', commit_id: 'aaabbb' }),
    requestReviewers: () => ({ users: [] }),
    listRequestedReviewers: () => ({ users: [{ login: 'bob' }] }),
    listPullFiles: () => [{ filename: 'src/a.ts', status: 'modified', additions: 3, deletions: 1, changes: 4, patch: '@@ -1 @@', raw_url: 'r', sha: 'aaabbb' }],
    searchCode: () => ({ total_count: 1, items: [{ name: 'a.ts', path: 'src/a.ts', repository: { full_name: 'acme/widget' }, html_url: 'h', text_matches: [{ fragment: 'match' }] }] }),
    listCommits: () => [{ sha: 'aaabbb', commit: { message: 'fix', author: { name: 'alice', date: '2024-01-01T00:00:00Z' } }, html_url: 'c' }],
    getCommit: () => ({ sha: 'aaabbb', commit: { message: 'fix', author: { name: 'alice', date: '2024-01-01T00:00:00Z' } }, html_url: 'c' }),
    listReleases: () => [{ id: 1, tag_name: 'v1.0', name: 'v1', body: 'release body', draft: false, prerelease: false, published_at: '2024-01-01T00:00:00Z', html_url: 'r', assets: [] }],
    getRelease: () => ({ id: 1, tag_name: 'v1.0', name: 'v1', body: 'release body', draft: false, prerelease: false, published_at: '2024-01-01T00:00:00Z', html_url: 'r', assets: [] }),
    createRelease: () => ({ id: 2, tag_name: 'v2', name: null, body: null, draft: false, prerelease: false, published_at: null, html_url: 'r', assets: [] }),
    updateRelease: () => ({ id: 1, tag_name: 'v1.0', name: 'v1', body: 'updated', draft: false, prerelease: false, published_at: '2024-01-01T00:00:00Z', html_url: 'r', assets: [] }),
    listLabels: () => [{ name: 'bug', color: 'B60205', description: 'bug label' }],
    createLabel: () => ({ name: 'todo', color: 'FFFFFF' }),
    addIssueLabels: () => [{ name: 'bug' }],
    removeIssueLabel: () => null,
    listMilestones: () => [{ number: 1, title: 'v1', state: 'open', description: 'm', open_issues: 2, closed_issues: 1, due_on: null }],
    getMilestone: () => ({ number: 1, title: 'v1', state: 'open', description: 'm', open_issues: 2, closed_issues: 1, due_on: null }),
    createMilestone: () => ({ number: 2, title: 'v2', state: 'open', description: null, open_issues: 0, closed_issues: 0, due_on: null }),
    updateMilestone: () => ({ number: 1, title: 'v1', state: 'closed', description: 'm', open_issues: 2, closed_issues: 1, due_on: null }),
};
const apiPath = (owner, repo, tail) => `/repos/${owner}/${repo}/${tail}`;
const pathOf = (r) => String(r.url).split('?')[0];
routes.push(
    { match: (r) => r.method === 'PUT' && r.url === apiPath('acme', 'widget', 'contents/src/a.ts'), respond: v11routes.writeContents },
    { match: (r) => r.method === 'DELETE' && r.url === apiPath('acme', 'widget', 'contents/src/del.ts'), respond: v11routes.deleteContents },
    { match: (r) => r.method === 'GET' && r.url === apiPath('acme', 'widget', 'branches'), respond: v11routes.listBranches },
    { match: (r) => r.method === 'GET' && r.url === apiPath('acme', 'widget', 'branches/main'), respond: v11routes.getBranch },
    { match: (r) => r.method === 'POST' && r.url === apiPath('acme', 'widget', 'git/refs'), respond: v11routes.createBranch },
    { match: (r) => r.method === 'GET' && pathOf(r) === apiPath('acme', 'widget', 'actions/runs'), respond: v11routes.listRuns },
    { match: (r) => r.method === 'GET' && r.url === apiPath('acme', 'widget', 'actions/runs/99'), respond: v11routes.getRun },
    { match: (r) => r.method === 'GET' && r.url === apiPath('acme', 'widget', 'actions/runs/99/jobs'), respond: v11routes.listJobs },
    { match: (r) => r.method === 'POST' && r.url.endsWith('actions/runs/99/rerun'), status: 204, respond: () => null },
    { match: (r) => r.method === 'POST' && r.url.endsWith('actions/runs/99/rerun-failed-jobs'), status: 204, respond: () => null },
    { match: (r) => r.method === 'POST' && r.url.endsWith('actions/runs/99/cancel'), status: 204, respond: () => null },
    { match: (r) => r.method === 'GET' && r.url === apiPath('acme', 'widget', 'pulls/7/reviews'), respond: v11routes.listReviews },
    { match: (r) => r.method === 'GET' && r.url === apiPath('acme', 'widget', 'pulls/7/reviews/1'), respond: v11routes.getReview },
    { match: (r) => r.method === 'POST' && r.url === apiPath('acme', 'widget', 'pulls/7/reviews'), respond: v11routes.submitReview },
    { match: (r) => r.method === 'POST' && r.url === apiPath('acme', 'widget', 'pulls/7/requested_reviewers'), respond: v11routes.requestReviewers },
    { match: (r) => r.method === 'GET' && r.url === apiPath('acme', 'widget', 'pulls/7/requested_reviewers'), respond: v11routes.listRequestedReviewers },
    { match: (r) => r.method === 'GET' && r.url === apiPath('acme', 'widget', 'pulls/7/files'), respond: v11routes.listPullFiles },
    { match: (r) => r.method === 'GET' && /^\/search\/code\?/.test(r.url), respond: v11routes.searchCode },
    { match: (r) => r.method === 'GET' && pathOf(r) === apiPath('acme', 'widget', 'commits'), respond: v11routes.listCommits },
    { match: (r) => r.method === 'GET' && r.url === apiPath('acme', 'widget', 'commits/aaabbb'), respond: v11routes.getCommit },
    { match: (r) => r.method === 'GET' && pathOf(r) === apiPath('acme', 'widget', 'releases'), respond: v11routes.listReleases },
    { match: (r) => r.method === 'GET' && r.url === apiPath('acme', 'widget', 'releases/1'), respond: v11routes.getRelease },
    { match: (r) => r.method === 'POST' && r.url === apiPath('acme', 'widget', 'releases'), respond: v11routes.createRelease },
    { match: (r) => r.method === 'PATCH' && r.url === apiPath('acme', 'widget', 'releases/1'), respond: v11routes.updateRelease },
    { match: (r) => r.method === 'GET' && r.url === apiPath('acme', 'widget', 'labels'), respond: v11routes.listLabels },
    { match: (r) => r.method === 'POST' && r.url === apiPath('acme', 'widget', 'labels'), respond: v11routes.createLabel },
    { match: (r) => r.method === 'POST' && r.url === apiPath('acme', 'widget', 'issues/42/labels'), respond: v11routes.addIssueLabels },
    { match: (r) => r.method === 'DELETE' && r.url === apiPath('acme', 'widget', 'issues/42/labels/bug'), status: 204, respond: () => null },
    { match: (r) => r.method === 'GET' && pathOf(r) === apiPath('acme', 'widget', 'milestones'), respond: v11routes.listMilestones },
    { match: (r) => r.method === 'GET' && r.url === apiPath('acme', 'widget', 'milestones/1'), respond: v11routes.getMilestone },
    { match: (r) => r.method === 'POST' && r.url === apiPath('acme', 'widget', 'milestones'), respond: v11routes.createMilestone },
    { match: (r) => r.method === 'PATCH' && r.url === apiPath('acme', 'widget', 'milestones/1'), respond: v11routes.updateMilestone },
);

const server = http.createServer((req, res) => {
    const route = routes.find((r) => r.match(req));
    if (!route) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: `stub: no route for ${req.method} ${req.url}` }));
        return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'bad credentials' }));
        return;
    }
    const body = route.respond();
    res.writeHead(route.status ?? 200, {
        'content-type': 'application/json',
        ...(route.headers ?? {}),
    });
    res.end(body === null ? '' : JSON.stringify(body));
});

function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) {
    return new Promise((resolve) => server.close(resolve));
}

// ---------------------------------------------------------------------------
// Client tests
// ---------------------------------------------------------------------------

const port = await listen(server);
const client = new GitHubClient({
    apiBaseUrl: `http://127.0.0.1:${port}`,
    token,
    requestTimeoutMs: 5000,
});

console.log('\n[GitHubClient]');
await checkAsync('repo info', async () => {
    const repo = await client.getRepo('acme', 'widget');
    assert.equal(repo.fullName, 'acme/widget');
    assert.equal(repo.stars, 123);
    assert.equal(repo.defaultBranch, 'main');
    assert.deepEqual(repo.topics, ['typescript']);
    assert.equal(repo.license, 'MIT');
});
await checkAsync('search repos', async () => {
    const result = await client.searchRepos('widget stars:>100', 10);
    assert.equal(result.totalCount, 1);
});
await checkAsync('list issues', async () => {
    const issues = await client.listIssues('acme', 'widget', { state: 'open', perPage: 5 });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].labels[0], 'bug');
});
await checkAsync('get issue', async () => {
    const issue = await client.getIssue('acme', 'widget', 42);
    assert.equal(issue.number, 42);
    assert.equal(issue.user, 'octocat');
});
await checkAsync('create issue', async () => {
    const issue = await client.createIssue('acme', 'widget', { title: 'New issue', labels: ['bug'] });
    assert.equal(issue.number, 43);
});
await checkAsync('update issue', async () => {
    const issue = await client.updateIssue('acme', 'widget', 42, { state: 'closed' });
    assert.equal(issue.state, 'closed');
});
await checkAsync('comment on issue', async () => {
    const comment = await client.commentOnIssue('acme', 'widget', 42, 'On it.');
    assert.equal(comment.id, 99);
    assert.equal(comment.body, 'On it.');
});
await checkAsync('list pulls', async () => {
    const pulls = await client.listPulls('acme', 'widget', { state: 'open' });
    assert.equal(pulls.length, 1);
    assert.equal(pulls[0].head.ref, 'feature/x');
});
await checkAsync('get pull', async () => {
    const pull = await client.getPull('acme', 'widget', 7);
    assert.equal(pull.mergeable, true);
    assert.equal(pull.base.ref, 'main');
});
await checkAsync('create pull', async () => {
    const pull = await client.createPull('acme', 'widget', { title: 'Created PR', head: 'feature/x', base: 'main' });
    assert.equal(pull.number, 8);
});
await checkAsync('merge pull', async () => {
    const merge = await client.mergePull('acme', 'widget', 7, { mergeMethod: 'squash' });
    assert.equal(merge.merged, true);
    assert.equal(merge.number, 7);
});
await checkAsync('get file contents (decoded)', async () => {
    const file = await client.getContents('acme', 'widget', 'README.md');
    assert.equal(Array.isArray(file), false);
    assert.equal(file.content, 'hello world');
});
await checkAsync('list directory contents', async () => {
    const entries = await client.getContents('acme', 'widget', 'src');
    assert.equal(Array.isArray(entries), true);
    assert.equal(entries[0].path, 'src/main.ts');
});
await checkAsync('list workflows', async () => {
    const workflows = await client.listWorkflows('acme', 'widget');
    assert.equal(workflows.totalCount, 1);
    assert.equal(workflows.items[0].name, 'CI');
});
await checkAsync('dispatch workflow', async () => {
    const result = await client.dispatchWorkflow('acme', 'widget', 'ci.yml', { ref: 'main' });
    assert.equal(result.ok, true);
    assert.equal(result.workflowId, 'ci.yml');
    assert.equal(result.ref, 'main');
});

// ---- V1.1 Level-3 client methods -----------------------------------------
await checkAsync('write contents (create/update)', async () => {
    const written = await client.writeContents('acme', 'widget', 'src/a.ts', { message: 'add', content: 'new', sha: 'oldsha' });
    assert.equal(written.path, 'src/a.ts');
    assert.equal(written.commitSha, 'commitwrite');
});
await checkAsync('delete contents', async () => {
    const deleted = await client.deleteContents('acme', 'widget', 'src/del.ts', { message: 'del', sha: 'sha' });
    assert.equal(deleted.deleted, true);
    assert.equal(deleted.commitSha, 'commitdel');
});
await checkAsync('list branches', async () => {
    const branches = await client.listBranches('acme', 'widget');
    assert.equal(branches.length, 2);
    assert.equal(branches[0].name, 'main');
    assert.equal(branches[0].protected, true);
});
await checkAsync('get branch', async () => {
    const branch = await client.getBranch('acme', 'widget', 'main');
    assert.equal(branch.sha, 'aaa111');
});
await checkAsync('create branch', async () => {
    const ref = await client.createBranch('acme', 'widget', 'feature/new', 'aaa111');
    assert.equal(ref.ref, 'refs/heads/feature/new');
});
await checkAsync('list workflow runs', async () => {
    const runs = await client.listWorkflowRuns('acme', 'widget', {});
    assert.equal(runs.totalCount, 2);
    assert.equal(runs.items[1].conclusion, 'failure');
});
await checkAsync('get workflow run', async () => {
    const run = await client.getWorkflowRun('acme', 'widget', 99);
    assert.equal(run.conclusion, 'failure');
    assert.equal(run.headBranch, 'main');
});
await checkAsync('list workflow jobs', async () => {
    const jobs = await client.listWorkflowJobs('acme', 'widget', 99);
    assert.equal(jobs[0].name, 'build');
    assert.equal(jobs[0].conclusion, 'failure');
});
await checkAsync('rerun / rerun-failed / cancel workflow', async () => {
    assert.equal((await client.rerunWorkflow('acme', 'widget', 99)).ok, true);
    assert.equal((await client.rerunFailedJobs('acme', 'widget', 99)).ok, true);
    assert.equal((await client.cancelWorkflow('acme', 'widget', 99)).ok, true);
});
await checkAsync('list / get reviews', async () => {
    const reviews = await client.listReviews('acme', 'widget', 7);
    assert.equal(reviews[0].state, 'APPROVED');
    const review = await client.getReview('acme', 'widget', 7, 1);
    assert.equal(review.body, 'lgtm');
});
await checkAsync('submit review / request reviewers', async () => {
    const submitted = await client.submitReview('acme', 'widget', 7, { event: 'APPROVE', body: 'ok' });
    assert.equal(submitted.state, 'APPROVED');
    assert.equal((await client.requestReviewers('acme', 'widget', 7, ['bob'])).ok, true);
    const requested = await client.listRequestedReviewers('acme', 'widget', 7);
    assert.equal(requested[0], 'bob');
});
await checkAsync('list PR files', async () => {
    const files = await client.listPullFiles('acme', 'widget', 7);
    assert.equal(files[0].filename, 'src/a.ts');
    assert.equal(files[0].additions, 3);
    assert.equal(files[0].deletions, 1);
});
await checkAsync('search code', async () => {
    const result = await client.searchCode('findme repo:acme/widget', 10);
    assert.equal(result.totalCount, 1);
    assert.equal(result.items[0].path, 'src/a.ts');
});
await checkAsync('list / get commits', async () => {
    const commits = await client.listCommits('acme', 'widget', {});
    assert.equal(commits[0].sha, 'aaabbb');
    const commit = await client.getCommit('acme', 'widget', 'aaabbb');
    assert.equal(commit.message, 'fix');
});
await checkAsync('list / get / create / update releases', async () => {
    const releases = await client.listReleases('acme', 'widget', 30);
    assert.equal(releases[0].tagName, 'v1.0');
    assert.equal((await client.getRelease('acme', 'widget', 1)).name, 'v1');
    const created = await client.createRelease('acme', 'widget', { tagName: 'v2' });
    assert.equal(created.tagName, 'v2');
    assert.equal((await client.updateRelease('acme', 'widget', 1, { body: 'updated' })).body, 'updated');
});
await checkAsync('labels: list/create/add/remove', async () => {
    const labels = await client.listLabels('acme', 'widget');
    assert.equal(labels[0].name, 'bug');
    assert.equal((await client.createLabel('acme', 'widget', { name: 'todo', color: 'FFFFFF' })).name, 'todo');
    assert.deepEqual(await client.addIssueLabels('acme', 'widget', 42, ['bug']), ['bug']);
    assert.deepEqual(await client.removeIssueLabel('acme', 'widget', 42, 'bug'), { ok: true });
});
await checkAsync('milestones: list/get/create/update', async () => {
    const milestones = await client.listMilestones('acme', 'widget', {});
    assert.equal(milestones[0].title, 'v1');
    assert.equal((await client.getMilestone('acme', 'widget', 1)).openIssues, 2);
    assert.equal((await client.createMilestone('acme', 'widget', { title: 'v2' })).title, 'v2');
    assert.equal((await client.updateMilestone('acme', 'widget', 1, { state: 'closed' })).state, 'closed');
});

await checkAsync('404 becomes GitHubApiError', async () => {
    await assert.rejects(
        client.getRepo('acme', 'missing'),
        (error) => error instanceof GitHubApiError && error.status === 404 && error.documentationUrl !== undefined,
    );
});
await checkAsync('rate limit surfaced', async () => {
    await assert.rejects(
        client.getRepo('acme', 'ratelimited'),
        (error) => error instanceof GitHubApiError && error.rateLimited === true,
    );
});
await checkAsync('no token fails fast', async () => {
    const old = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
        const bare = new GitHubClient({ apiBaseUrl: `http://127.0.0.1:${port}` });
        await assert.rejects(bare.getRepo('acme', 'widget'), /GitHub token not configured/);
    } finally {
        if (old !== undefined) process.env.GITHUB_TOKEN = old;
    }
});

// ---------------------------------------------------------------------------
// Webhook signature + normalization
// ---------------------------------------------------------------------------

console.log('\n[webhook signature]');
const secret = 'whsec_smoke';
const payload = JSON.stringify({ action: 'opened', issue: { number: 1, title: 'X' } });
const good = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
check('valid signature passes', () => assert.equal(verifyGitHubSignature(secret, Buffer.from(payload), good), true));
check('tampered body fails', () => assert.equal(verifyGitHubSignature(secret, Buffer.from(payload + 'x'), good), false));
check('tampered header fails', () => assert.equal(verifyGitHubSignature(secret, Buffer.from(payload), 'sha256=' + '0'.repeat(64)), false));
check('missing header fails', () => assert.equal(verifyGitHubSignature(secret, Buffer.from(payload), undefined), false));
check('wrong scheme fails', () => assert.equal(verifyGitHubSignature(secret, Buffer.from(payload), `md5=${'0'.repeat(32)}`), false));

console.log('\n[webhook normalization]');
const normalized = normalizeWebhookEvent('issues', {
    action: 'opened',
    repository: { full_name: 'acme/widget' },
    sender: { login: 'alice' },
    issue: { number: 1, title: 'Bug here', html_url: 'https://github.com/acme/widget/issues/1' },
});
check('issues event summary', () => {
    assert.match(normalized.text, /issue opened #1 — Bug here by alice/);
    assert.equal(normalized.repo, 'acme/widget');
    assert.equal(normalized.htmlUrl, 'https://github.com/acme/widget/issues/1');
});
const commentEvent = normalizeWebhookEvent('issue_comment', {
    action: 'created',
    repository: { full_name: 'acme/widget' },
    sender: { login: 'bob' },
    issue: { number: 2, title: 'Second' },
    comment: { body: 'Please look into this' },
});
check('issue_comment event summary carries body', () => {
    assert.match(commentEvent.text, /comment created #2 — Second by bob/);
    assert.match(commentEvent.text, /Comment: Please look into this/);
});
const pushEvent = normalizeWebhookEvent('push', {
    ref: 'refs/heads/main',
    repository: { full_name: 'acme/widget' },
    sender: { login: 'carol' },
    commits: [{}, {}],
    head_commit: { message: 'Fix the thing' },
});
check('push event summary', () => {
    assert.match(pushEvent.text, /push to acme\/widget \(refs\/heads\/main\) by carol: 2 commit\(s\)/);
    assert.match(pushEvent.text, /Head commit: Fix the thing/);
});
const runEvent = normalizeWebhookEvent('workflow_run', {
    repository: { full_name: 'acme/widget' },
    workflow_run: { id: 5, name: 'CI', status: 'completed', conclusion: 'success' },
});
check('workflow_run event summary', () => {
    assert.match(runEvent.text, /workflow run CI #5 \(completed → success\)/);
});
const fallbackEvent = normalizeWebhookEvent('totally_unknown', { repository: { full_name: 'acme/widget' } });
check('unknown event degrades to JSON dump', () => {
    assert.match(fallbackEvent.text, /totally_unknown/);
    assert.match(fallbackEvent.text, /acme\/widget/);
});

// ---------------------------------------------------------------------------
// Full webhook handler → agent delivery
// ---------------------------------------------------------------------------

console.log('\n[webhook handler → agent]');
let delivered = [];
const fakeAgent = { followup: (message) => delivered.push(message) };
const registered = {};
const fakeCtx = {
    webServer: {
        register: (route) => {
            registered.route = route;
            return () => { registered.route = undefined; };
        },
    },
    agents: {
        get: () => fakeAgent,
    },
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
};
const handler = new GitHubWebhookHandler({
    ctx: fakeCtx,
    config: { secret, sessionId: 'session-1', path: '/github/webhook', events: ['issues'] },
});

function fakeReq(body, headers) {
    const chunk = Buffer.from(body);
    const req = {
        method: 'POST',
        headers,
        url: '/github/webhook',
        [Symbol.asyncIterator]() {
            let done = false;
            return {
                next: async () => {
                    if (done) return { done: true };
                    done = true;
                    return { done: false, value: chunk };
                },
            };
        },
    };
    return req;
}
function fakeRes() {
    const res = {
        status: 0,
        body: '',
        writeHead(status) { this.status = status; },
        end(text) { this.body = text; },
    };
    res.writableEnded = false;
    return res;
}

const goodHeaders = (body) => ({
    'x-github-event': 'issues',
    'x-github-delivery': 'delivery-1',
    'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
});

await checkAsync('signed issues event reaches the agent', async () => {
    const body = JSON.stringify({ action: 'opened', repository: { full_name: 'acme/widget' }, issue: { number: 5, title: 'Hello' } });
    const res = fakeRes();
    await registered.route.handler(fakeReq(body, goodHeaders(body)), res);
    assert.equal(res.status, 200);
    assert.equal(delivered.length, 1);
    const message = delivered[0];
    assert.equal(message.content[0].type, 'text');
    assert.match(message.content[0].text, /issue opened #5/);
    assert.deepEqual(message.source.kind, 'github');
    assert.equal(message.source.event, 'issues');
    assert.equal(message.source.repo, 'acme/widget');
});
await checkAsync('bad signature -> 401, no delivery', async () => {
    const body = JSON.stringify({ action: 'opened', issue: { number: 9 } });
    const res = fakeRes();
    const before = delivered.length;
    await registered.route.handler(fakeReq(body, { 'x-github-event': 'issues', 'x-hub-signature-256': 'sha256=wrong' }), res);
    assert.equal(res.status, 401);
    assert.equal(delivered.length, before);
});
await checkAsync('filtered event ignored with 200', async () => {
    const body = JSON.stringify({ action: 'opened' });
    const res = fakeRes();
    const headers = goodHeaders(body);
    headers['x-github-event'] = 'push';
    const before = delivered.length;
    await registered.route.handler(fakeReq(body, headers), res);
    assert.equal(res.status, 200);
    assert.equal(delivered.length, before);
});
await checkAsync('oversized body -> 413', async () => {
    const body = JSON.stringify({ big: 'x'.repeat(60) });
    const before = delivered.length;
    const smallRoutes = {};
    const smallCtx = {
        webServer: { register: (route) => { smallRoutes.route = route; return () => {}; } },
        agents: { get: () => fakeAgent },
        logger: { info: () => {}, warn: () => {}, debug: () => {} },
    };
    const smallHandler = new GitHubWebhookHandler({
        ctx: smallCtx,
        config: { secret, sessionId: 'session-1', path: '/github/webhook', maxBodyBytes: 32 },
    });
    const res = fakeRes();
    await smallRoutes.route.handler(fakeReq(body, goodHeaders(body)), res);
    assert.equal(res.status, 413);
    assert.equal(delivered.length, before);
    smallHandler.dispose();
});
await checkAsync('handler disposal unregisters the route', () => {
    handler.dispose();
    assert.equal(registered.route, undefined);
});

await close(server);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
