/**
 * dsh-obsidian — vault tools registered on `ctx.tools`.
 *
 * Every tool operates inside the configured vault root through {@link VaultFs}
 * (path-escape safe). No Obsidian desktop app or ACP is involved.
 *
 * @module dsh-obsidian/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { Context } from '@deepseek-ai/cordis';

import type { VaultFs } from './vault.ts';

/** One model-facing text block. */
function text(content: string): ContentBlock[] {
    return [{ type: 'text', text: content }];
}

/** Path parameter shared by every vault tool. */
const pathParam = {
    type: 'string',
    required: true,
    description: 'Vault-relative path of the note, e.g. "Projects/Ideas.md" (leading slash optional).',
} as const;

/** Register the vault tools. Returns disposers. */
export function registerObsidianTools(ctx: Context, vault: VaultFs): Array<() => void> {
    const disposers: Array<() => void> = [];

    disposers.push(ctx.tools.register(defineTool({
        name: 'obsidian_read_note',
        description: 'Read the content of a markdown note in the Obsidian vault.',
        parameters: { path: pathParam },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => text(value),
        },
        isConcurrencySafe: () => true,
        async execute(args) {
            return vault.read(args.path);
        },
    })));

    disposers.push(ctx.tools.register(defineTool({
        name: 'obsidian_write_note',
        description: 'Create or overwrite a markdown note in the Obsidian vault (creates parent folders as needed).',
        parameters: {
            path: pathParam,
            content: { type: 'string', required: true, description: 'Full markdown content to write.' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => text(value),
        },
        async execute(args) {
            await vault.write(args.path, args.content);
            return `wrote ${args.path}`;
        },
    })));

    disposers.push(ctx.tools.register(defineTool({
        name: 'obsidian_append_note',
        description: 'Append markdown content to an existing note in the Obsidian vault (creates it if missing).',
        parameters: {
            path: pathParam,
            content: { type: 'string', required: true, description: 'Markdown content to append.' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => text(value),
        },
        async execute(args) {
            await vault.append(args.path, args.content);
            return `appended to ${args.path}`;
        },
    })));

    disposers.push(ctx.tools.register(defineTool({
        name: 'obsidian_list_notes',
        description: 'List markdown notes in the Obsidian vault (optionally under a folder), recursive, sorted.',
        parameters: {
            path: { type: 'string', description: 'Vault-relative folder to list; empty = whole vault.' },
        },
        output: {
            schema: { type: 'array', items: { type: 'string' } },
            render: (_args, value) => {
                const list = value as string[];
                if (list.length === 0) return text('No notes found.');
                return text(list.join('\n'));
            },
        },
        isConcurrencySafe: () => true,
        async execute(args) {
            return vault.listNotes(args.path ?? '');
        },
    })));

    disposers.push(ctx.tools.register(defineTool({
        name: 'obsidian_search',
        description: 'Search note contents in the Obsidian vault (case-insensitive substring). Returns matching note paths with a snippet around each hit.',
        parameters: {
            query: { type: 'string', required: true, description: 'Text to search for.' },
            limit: { type: 'integer', description: 'Max results (default 20).' },
        },
        output: {
            schema: {
                type: 'array',
                items: { type: 'object', additionalProperties: false, properties: { path: { type: 'string' }, snippet: { type: 'string' } } },
            },
            render: (_args, value) => {
                const hits = value as Array<{ path: string; snippet: string }>;
                if (hits.length === 0) return text('No matches found.');
                return text(hits.map((h) => `${h.path}\n  …${h.snippet}…`).join('\n'));
            },
        },
        isConcurrencySafe: () => true,
        async execute(args) {
            return vault.search(args.query, args.limit ?? 20);
        },
    })));

    return disposers;
}
