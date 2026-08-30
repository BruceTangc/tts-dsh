/**
 * dsh-obsidian — DSH Obsidian plugin (cordis entry).
 *
 * Direct vault access for DSH agents: the vault is a plain local directory of
 * markdown notes, and this plugin registers `obsidian_*` tools that read /
 * write / append / list / search notes inside it — no Obsidian desktop app and
 * no ACP required.
 *
 * @module dsh-obsidian
 */
import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-tools';

import { VaultFs } from './vault.ts';
import { registerObsidianTools } from './tools.ts';

/** Stable Cordis plugin name. */
export const name = 'obsidian';

/** Services the plugin requires before it can load. */
export const inject = ['tools'];

/** Configuration schema for the obsidian plugin. */
export const Config: z<ObsidianConfig> = z.object({
    /** Absolute path of the Obsidian vault directory. */
    vaultPath: z.string().required(),
});

/** Validated config shape (mirrors {@link Config}). */
export interface ObsidianConfig {
    vaultPath: string;
}

/** Plugin body: open the vault and register the tools. */
export function apply(ctx: Context, config: ObsidianConfig): void {
    const vault = new VaultFs(config.vaultPath);
    const disposers = registerObsidianTools(ctx, vault);
    ctx.logger.info(`obsidian: vault tools registered; vault=${vault.root}`);
    ctx.effect(() => {
        return () => {
            for (const dispose of disposers) dispose();
        };
    }, 'obsidian: dispose tools');
}

export { VaultFs } from './vault.ts';
export { registerObsidianTools } from './tools.ts';

export default { name, Config, inject, apply };
