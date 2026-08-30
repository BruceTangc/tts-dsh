/**
 * dsh-obsidian — VaultFs: safe file operations inside an Obsidian vault.
 *
 * The vault is a plain local directory (markdown notes + `.obsidian` config).
 * Every operation resolves the requested path against the vault root and
 * refuses paths that escape it (`..`, absolute paths, drive prefixes), so the
 * agent can only touch notes inside the vault.
 *
 * @module dsh-obsidian/vault
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Max note size we are willing to read (8 MiB). */
const MAX_NOTE_BYTES = 8 * 1024 * 1024;
/** Max files visited by a search. */
const MAX_SEARCH_FILES = 2000;

export class VaultFs {
    readonly root: string;

    constructor(root: string) {
        this.root = path.resolve(root);
    }

    /** Resolve a vault-relative path to an absolute path; throws when it escapes. */
    resolve(relative: string): string {
        const normalized = relative.replace(/\\/g, '/').replace(/^\/+/, '');
        const absolute = path.resolve(this.root, normalized);
        const rel = path.relative(this.root, absolute);
        // rel === '' means the path resolves to the vault root itself (allowed);
        // anything starting with '..' or absolute escapes the vault.
        if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) {
            throw new Error(`obsidian: path "${relative}" escapes the vault root`);
        }
        return absolute;
    }

    /** Relative (vault-rooted) form of an absolute path, or undefined when outside. */
    relative(absolute: string): string | undefined {
        const rel = path.relative(this.root, path.resolve(absolute));
        if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
        return rel.split(path.sep).join('/');
    }

    async read(relative: string): Promise<string> {
        const absolute = this.resolve(relative);
        const stat = await fs.stat(absolute).catch(() => undefined);
        if (stat === undefined || !stat.isFile()) {
            throw new Error(`obsidian: note not found: ${relative}`);
        }
        if (stat.size > MAX_NOTE_BYTES) {
            throw new Error(`obsidian: note too large to read: ${relative} (${stat.size} bytes)`);
        }
        return fs.readFile(absolute, 'utf8');
    }

    async write(relative: string, content: string): Promise<void> {
        const absolute = this.resolve(relative);
        await fs.mkdir(path.dirname(absolute), { recursive: true });
        await fs.writeFile(absolute, content, 'utf8');
    }

    async append(relative: string, content: string): Promise<void> {
        const absolute = this.resolve(relative);
        await fs.mkdir(path.dirname(absolute), { recursive: true });
        await fs.appendFile(absolute, `\n${content}\n`, 'utf8');
    }

    /** List markdown notes under a vault-relative directory (recursive). */
    async listNotes(dir = ''): Promise<string[]> {
        const base = this.resolve(dir);
        const out: string[] = [];
        const walk = async (absolute: string): Promise<void> => {
            const entries = await fs.readdir(absolute, { withFileTypes: true }).catch(() => [] as Array<{ name: string; isDirectory(): boolean }>);
            for (const entry of entries) {
                if (entry.name.startsWith('.')) continue; // skip .obsidian etc.
                const full = path.join(absolute, entry.name);
                if (entry.isDirectory()) {
                    await walk(full);
                } else if (entry.name.toLowerCase().endsWith('.md')) {
                    const rel = this.relative(full);
                    if (rel !== undefined) out.push(rel);
                }
            }
        };
        await walk(base);
        return out.sort();
    }

    /**
     * Search note contents for `query` (case-insensitive substring).
     * Returns up to `limit` matches with a snippet around the hit.
     */
    async search(query: string, limit = 20): Promise<Array<{ path: string; snippet: string }>> {
        const needles = query.toLowerCase();
        const hits: Array<{ path: string; snippet: string }> = [];
        let visited = 0;
        const walk = async (absolute: string): Promise<void> => {
            if (hits.length >= limit || visited >= MAX_SEARCH_FILES) return;
            const entries = await fs.readdir(absolute, { withFileTypes: true }).catch(() => [] as Array<{ name: string; isDirectory(): boolean }>);
            for (const entry of entries) {
                if (hits.length >= limit || visited >= MAX_SEARCH_FILES) return;
                if (entry.name.startsWith('.')) continue;
                const full = path.join(absolute, entry.name);
                if (entry.isDirectory()) {
                    await walk(full);
                } else if (entry.name.toLowerCase().endsWith('.md')) {
                    visited += 1;
                    const rel = this.relative(full);
                    if (rel === undefined) continue;
                    let text: string;
                    try {
                        const stat = await fs.stat(full);
                        if (stat.size > MAX_NOTE_BYTES) continue;
                        text = await fs.readFile(full, 'utf8');
                    } catch {
                        continue;
                    }
                    const lower = text.toLowerCase();
                    const index = lower.indexOf(needles);
                    if (index >= 0) {
                        const start = Math.max(0, index - 80);
                        const end = Math.min(text.length, index + needles.length + 160);
                        hits.push({ path: rel, snippet: text.slice(start, end).replace(/\s+/g, ' ').trim() });
                        if (hits.length >= limit) return;
                    }
                }
            }
        };
        await walk(this.root);
        return hits;
    }
}
