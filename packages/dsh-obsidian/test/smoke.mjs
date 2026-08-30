/**
 * Smoke test for dsh-obsidian (local vault build) against the BUILT lib.
 *
 * Exercises:
 *   1. Config schema validation.
 *   2. VaultFs: write / read / append / list / search + path-escape guard.
 *   3. Tool registration (stub ctx.tools) and execute() against a temp vault.
 *
 * Run: node test/smoke.mjs  (expect "smoke: OK")
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { Config, VaultFs, registerObsidianTools } = await import('../lib/index.js');

let failed = 0;
function check(label, ok, detail = '') {
    if (ok) {
        console.log(`  ok  ${label}`);
    } else {
        failed += 1;
        console.error(`FAIL  ${label}${detail ? `: ${detail}` : ''}`);
    }
}

// ---- 1. Config ------------------------------------------------------------
const cfg = Config({ vaultPath: 'D:/tmp/vault' });
check('Config requires vaultPath', cfg.vaultPath === 'D:/tmp/vault');
try {
    Config({});
    check('Config without vaultPath rejects', false);
} catch {
    check('Config without vaultPath rejects', true);
}

// ---- 2. VaultFs -----------------------------------------------------------
const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-obsidian-smoke-'));
const vault = new VaultFs(vaultRoot);

await vault.write('Projects/Ideas.md', '# Ideas\n\n- note about cats\n');
await vault.write('Daily/2026-08-29.md', '# 2026-08-29\n\nToday I learned about obsidian.\n');
await vault.append('Projects/Ideas.md', '- more cat thoughts\n');

check('read returns content', (await vault.read('Projects/Ideas.md')).includes('# Ideas'));
check('read is case-insensitive path', (await vault.read('projects/ideas.md')).includes('# Ideas'));
check('append merged content', (await vault.read('Projects/Ideas.md')).includes('more cat thoughts'));

const list = await vault.listNotes();
check('list finds both notes', list.length === 2 && list.includes('Projects/Ideas.md') && list.includes('Daily/2026-08-29.md'));

const hits = await vault.search('cat');
check('search finds matches with snippets',
    hits.some((h) => h.path === 'Projects/Ideas.md' && h.snippet.toLowerCase().includes('cat')));

// Path-escape guards
let escaped = false;
try { await vault.read('../outside.md'); } catch { escaped = true; }
check('read refuses path escape', escaped);
escaped = false;
try { await vault.read('C:/Windows/win.ini'); } catch { escaped = true; }
check('read refuses absolute drive path', escaped);
escaped = false;
try { await vault.write('../../evil.md', 'x'); } catch { escaped = true; }
check('write refuses path escape', escaped);
check('read missing note rejects', await vault.read('Nope.md').then(() => false, () => true));

// ---- 3. Tool registration + execute --------------------------------------
const registered = [];
const ctx = {
    tools: {
        register: (definition) => { registered.push(definition); return () => {}; },
    },
};
const disposers = registerObsidianTools(ctx, vault);
check('registers 5 tools',
    registered.length === 5
    && registered.some((t) => t.name === 'obsidian_read_note')
    && registered.some((t) => t.name === 'obsidian_write_note')
    && registered.some((t) => t.name === 'obsidian_append_note')
    && registered.some((t) => t.name === 'obsidian_list_notes')
    && registered.some((t) => t.name === 'obsidian_search'));

const readTool = registered.find((t) => t.name === 'obsidian_read_note');
const content = await readTool.execute({ path: 'Projects/Ideas.md' });
check('obsidian_read_note execute', content.includes('# Ideas'));

const writeTool = registered.find((t) => t.name === 'obsidian_write_note');
await writeTool.execute({ path: 'New/Note.md', content: '# New note' });
check('obsidian_write_note execute creates note', (await vault.read('New/Note.md')) === '# New note');

const appendTool = registered.find((t) => t.name === 'obsidian_append_note');
await appendTool.execute({ path: 'New/Note.md', content: 'appended line' });
check('obsidian_append_note execute', (await vault.read('New/Note.md')).includes('appended line'));

const listTool = registered.find((t) => t.name === 'obsidian_list_notes');
const listOut = await listTool.execute({});
check('obsidian_list_notes execute', Array.isArray(listOut) && listOut.includes('New/Note.md'));

const searchTool = registered.find((t) => t.name === 'obsidian_search');
const searchOut = await searchTool.execute({ query: 'learned' });
check('obsidian_search execute', Array.isArray(searchOut) && searchOut.some((h) => h.path === 'Daily/2026-08-29.md'));

for (const dispose of disposers) dispose();
await fs.rm(vaultRoot, { recursive: true, force: true });

if (failed > 0) {
    console.error(`smoke: ${failed} check(s) FAILED`);
    process.exit(1);
}
console.log('smoke: OK');
