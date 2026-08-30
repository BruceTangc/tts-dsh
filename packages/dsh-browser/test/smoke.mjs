/**
 * Offline smoke test for @dsh/browser (V1.1 Level 2) against a local HTTP
 * stub server. Covers the URL Security Gate (SSRF), navigation
 * (open/read/click variants/back/forward/reload/wait), per-agent-session
 * isolation, untrusted content flag, redirect handling, error model, and tool
 * registration.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { BrowserService } from '../lib/core/browser.js';
import { fetchResource, assertSafeHttpUrl, BrowserError, statusToErrorKind } from '../lib/core/fetch.js';
import { registerBrowserTools } from '../lib/core/registry.js';

const HOME_HTML = `<!doctype html><html><head><title>Home</title></head><body><h1>Hello</h1><p>Intro text.</p>
  <nav><a href="/page2">Next page</a><a href="/redirect">Redirect link</a><a href="relative">Relative link</a>
  <a href="javascript:void(0)">JS link</a><a href="#frag">Anchor</a><a href="/">Self</a></nav>
  <script>malicious()</script></body></html>`;
const PAGE2_HTML = `<!doctype html><html><head><title>Page Two</title></head><body><p>Second page body.</p><a href="/">Back home</a></body></html>`;
const RELATIVE_HTML = `<!doctype html><html><head><title>Relative</title></head><body><p>Relative page body.</p><a href="/">Home</a></body></html>`;

const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(HOME_HTML); }
    else if (url === '/page2') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE2_HTML); }
    else if (url === '/relative') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(RELATIVE_HTML); }
    else if (url === '/redirect') { res.writeHead(302, { location: '/page2' }); res.end(); }
    // Redirect target is a private IPv4 (192.168) — must be SSRF-blocked on the
    // hop even when allowLoopback permits the initial 127.0.0.1 stub host.
    else if (url === '/redirect-ssrf') { res.writeHead(302, { location: 'http://192.168.50.10/steal' }); res.end(); }
    else if (url === '/notfound') { res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }); res.end('<html><head><title>Not Found</title></head><body><p>Missing.</p></body></html>'); }
    else if (url === '/server-error') { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('boom'); }
    else if (url === '/plain.txt') { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end('plain text body'); }
    else { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('no route'); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const origin = `http://127.0.0.1:${port}`;

// allowLoopback:true lets the local 127.0.0.1 stub server bypass the SSRF gate
// for the INITIAL URL only; redirect hops stay strict (a redirect into
// loopback/private is still denied), which the dedicated redirect-ssrf test asserts.
const service = new BrowserService({ maxTextChars: 8000, maxLinks: 100, timeoutMs: 2000, maxBodyBytes: 1024 * 1024, userAgent: 'dsh-browser-test', waitTimeoutMs: 1500, maxRetries: 1, allowLoopback: true });

let passed = 0;
let failed = 0;
function check(name, fn) { try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { failed += 1; console.error(`FAIL  ${name}: ${err.message}`); } }
async function checkAsync(name, fn) { try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { failed += 1; console.error(`FAIL  ${name}: ${err.message}`); } }
const signal = () => new AbortController().signal;

console.log('--- 1. URL Security Gate (SSRF) ---');
check('http/https allowed', () => { assert.ok(assertSafeHttpUrl('https://example.com/a')); assert.ok(assertSafeHttpUrl('https://sub.example.org:8080/x')); });
check('file: → UNSUPPORTED_SCHEME', () => { assert.throws(() => assertSafeHttpUrl('file:///etc/passwd'), /UNSUPPORTED_SCHEME/); });
check('javascript: → UNSUPPORTED_SCHEME', () => { assert.throws(() => assertSafeHttpUrl('javascript:alert(1)'), /UNSUPPORTED_SCHEME/); });
check('data: → UNSUPPORTED_SCHEME', () => { assert.throws(() => assertSafeHttpUrl('data:text/html,<b>x</b>'), /UNSUPPORTED_SCHEME/); });
check('blob: → UNSUPPORTED_SCHEME', () => { assert.throws(() => assertSafeHttpUrl('blob:https://x/y'), /UNSUPPORTED_SCHEME/); });
check('localhost → SSRF_BLOCKED', () => { assert.throws(() => assertSafeHttpUrl('http://localhost/x'), /SSRF_BLOCKED/); });
check('127.0.0.1 → SSRF_BLOCKED', () => { assert.throws(() => assertSafeHttpUrl('http://127.0.0.1/x'), /SSRF_BLOCKED/); });
check('private 192.168.1.1 → SSRF_BLOCKED', () => { assert.throws(() => assertSafeHttpUrl('http://192.168.1.1/x'), /SSRF_BLOCKED/); });
check('private 10.0.0.1 → SSRF_BLOCKED', () => { assert.throws(() => assertSafeHttpUrl('http://10.0.0.1/x'), /SSRF_BLOCKED/); });
check('metadata 169.254.169.254 → SSRF_BLOCKED', () => { assert.throws(() => assertSafeHttpUrl('http://169.254.169.254/latest/meta-data/'), /SSRF_BLOCKED/); });
check('URL with credentials → SSRF_BLOCKED', () => { assert.throws(() => assertSafeHttpUrl('http://user:pass@example.com/'), /SSRF_BLOCKED/); });
check('malformed URL → INVALID_URL', () => { assert.throws(() => assertSafeHttpUrl('http://[::1'), /INVALID_URL/); });
check('statusToErrorKind 429→RATE_LIMITED, 404→NOT_FOUND', () => { assert.equal(statusToErrorKind(429), 'RATE_LIMITED'); assert.equal(statusToErrorKind(404), 'NOT_FOUND'); });
check('BrowserError has typed kind', () => { const e = new BrowserError('SSRF_BLOCKED', 'x'); assert.equal(e.kind, 'SSRF_BLOCKED'); assert.equal(e.name, 'BrowserError'); });

console.log('--- 2. open / read / untrusted ---');
await checkAsync('open sets page + untrusted=true', async () => {
    const view = await service.open('s1', `${origin}/`, signal());
    assert.equal(view.title, 'Home');
    assert.equal(view.untrusted, true);
    assert.equal(view.forwardSize, 0);
    assert.equal(view.historySize, 0);
});
await checkAsync('read returns cached page', async () => {
    const view = service.read('s1');
    assert.equal(view.title, 'Home');
    assert.ok(view.links.some((l) => l.text === 'Next page'));
    assert.equal(view.untrusted, true);
});

console.log('--- 3. click variants ---');
await checkAsync('click by link_id', async () => {
    const home = service.read('s1');
    const link = home.links.find((c) => c.text === 'Next page');
    assert.ok(link, 'Next page present');
    const view = await service.click('s1', { linkId: link.id }, signal());
    assert.equal(view.title, 'Page Two');
    assert.equal(view.historySize, 1);
});
await checkAsync('click by href (relative)', async () => {
    await service.open('s8', `${origin}/`, signal());
    const view = await service.click('s8', { href: '/relative' }, signal());
    assert.equal(view.title, 'Relative');
});
await checkAsync('click by index', async () => {
    await service.open('s9', `${origin}/`, signal());
    const home = service.read('s9');
    const idx = home.links.findIndex((c) => c.text === 'Next page');
    const view = await service.click('s9', { index: idx }, signal());
    assert.equal(view.title, 'Page Two');
});
await checkAsync('click by text', async () => {
    await service.open('s10', `${origin}/`, signal());
    const view = await service.click('s10', { text: 'Next page' }, signal());
    assert.equal(view.title, 'Page Two');
});
await checkAsync('click unknown id fails', async () => { await assert.rejects(() => service.click('s1', { linkId: '999' }, signal()), /not found/); });
await checkAsync('click javascript: refused', async () => { await assert.rejects(() => service.click('s1', { href: 'javascript:void(0)' }, signal()), /refusing/); });
await checkAsync('click data: refused', async () => { await assert.rejects(() => service.click('s1', { href: 'data:text/html,x' }, signal()), /refusing/); });

console.log('--- 4. back / forward / reload ---');
await checkAsync('back then forward', async () => {
    const viewed = await service.back('s1', signal());
    assert.equal(viewed.title, 'Home');
    assert.equal(viewed.historySize, 0);
    assert.equal(viewed.forwardSize, 1);
    const forwardView = await service.forward('s1', signal());
    assert.equal(forwardView.title, 'Page Two');
    assert.equal(forwardView.forwardSize, 0);
});
await checkAsync('back with empty history fails', async () => { await assert.rejects(() => service.back('s12', signal()), /no previous page/); });
await checkAsync('forward with empty history fails', async () => { await assert.rejects(() => service.forward('s12', signal()), /no forward page/); });
await checkAsync('reload keeps URL & history', async () => {
    await service.open('s13', `${origin}/`, signal());
    await service.open('s13', `${origin}/page2`, signal());
    const view = await service.reload('s13', signal());
    assert.equal(view.url, `${origin}/page2`);
    assert.equal(view.title, 'Page Two');
    assert.equal(view.historySize, 1);
});

console.log('--- 5. wait ---');
await checkAsync('wait ms', async () => { const r = await service.wait('s13', { ms: 80 }, signal()); assert.equal(r.ok, true); });
await checkAsync('wait until text present', async () => {
    await service.open('s14', `${origin}/`, signal());
    const r = await service.wait('s14', { until: 'text', text: 'Intro text' }, signal());
    assert.equal(r.ok, true);
});
await checkAsync('wait until text absent → timeout', async () => {
    const r = await service.wait('s14', { until: 'text', text: 'NONEXISTENT', maxWaitMs: 250 }, signal());
    assert.equal(r.ok, false);
});

console.log('--- 6. SSRF per redirect hop ---');
await checkAsync('redirect → public passes', async () => {
    const view = await service.open('s15', `${origin}/redirect`, signal());
    assert.equal(view.url, `${origin}/page2`);
    assert.equal(view.title, 'Page Two');
});
await checkAsync('redirect → private IP is SSRF-blocked on the hop', async () => {
    await assert.rejects(() => service.open('s15x', `${origin}/redirect-ssrf`, signal()), (err) => err?.kind === 'SSRF_BLOCKED');
});

console.log('--- 7. error model & HTTP status ---');
await checkAsync('404 is a result (status), not throw', async () => {
    const view = await service.open('s16', `${origin}/notfound`, signal());
    assert.equal(view.statusCode, 404);
    assert.equal(view.untrusted, true);
});
await checkAsync('500 surfaced as result after retry exhausted', async () => {
    const view = await service.open('s17', `${origin}/server-error`, signal());
    assert.equal(view.statusCode, 500);
});
await checkAsync('fetchResource returns status/body', async () => {
    const res = await fetchResource(`${origin}/plain.txt`, { timeoutMs: 2000, maxBodyBytes: 1024 * 1024, userAgent: 'x', maxRetries: 1, allowLoopback: true });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, 'plain text body');
});

console.log('--- 8. session isolation ---');
await checkAsync('A/B independent with distinct pages', async () => {
    await service.open('A', `${origin}/`, signal());
    await service.open('B', `${origin}/page2`, signal());
    assert.equal(service.read('A').title, 'Home');
    assert.equal(service.read('B').title, 'Page Two');
});
await checkAsync('A history distinct: A back does not touch B', async () => {
    // Give A a two-entry history so back is well-defined.
    await service.open('A', `${origin}/page2`, signal()); // pushes '/'
    const bUrlBefore = service.read('B').url;
    const aView = await service.back('A', signal());       // returns to '/'
    assert.equal(aView.title, 'Home');
    assert.equal(service.read('B').url, bUrlBefore);        // B unchanged
});

console.log('--- 9. tool registration ---');
check('seven tools register', () => {
    const names = [];
    const fakeCtx = { tools: { register: (def) => { names.push(def.name); return () => {}; } } };
    const disposers = registerBrowserTools(fakeCtx, service);
    const expect = ['browser_open', 'browser_read', 'browser_click', 'browser_back', 'browser_forward', 'browser_reload', 'browser_wait'];
    for (const e of expect) assert.ok(names.includes(e), `missing ${e}`);
    for (const dispose of disposers) dispose();
});

await new Promise((resolve) => server.close(resolve));
console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
