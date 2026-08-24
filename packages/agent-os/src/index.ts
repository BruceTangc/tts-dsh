/**
 * Agent OS —— DSH (cordis) Plugin 入口
 *
 * 把 AgentOsService 挂到 ctx（`ctx.agentOs`），并接入 DSH Runtime：
 *   - 用本地 JSON 文件持久化状态（第一版；后续可换 DSH storageDomain）
 *   - 自动初始化 Organization（装插件即用，免手动建库）
 *
 * 遵守边界：
 *   - 不修改 DSH Core，不重实现 Agent/Session/Subagent/Workspace Runtime
 *   - DSH 负责「Agent 怎么运行」；本插件负责「Agent 怎么组织、授权、治理、委派」
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { AgentOsService } from './service.js'
import { AgentOsStore } from './store.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Agent OS 治理服务（Organization / Node / Role / Binding / Delegation / Authority / Permission / Audit） */
    agentOs: AgentOsService
  }
}

/** 插件配置 */
export interface Config {
  /** 状态持久化路径；缺省时放进 DSH home 下的 agent-os 目录 */
  statePath?: string
  /** 是否自动初始化默认 Organization（默认 true） */
  autoInit?: boolean
  /** 初始化时使用的 actor id（默认 'system'） */
  initActor?: string
}

export const Config: z<Config> = z.object({
  statePath: z.string().description('状态持久化路径（可选）'),
  autoInit: z.boolean().default(true).description('是否自动初始化默认 Organization'),
  initActor: z.string().default('system').description('初始化 actor id'),
})

/** Agent OS plugin：给 ctx 提供 agentOs 服务 */
export function apply(ctx: Context, config: Config): () => void {
  const statePath =
    config.statePath ?? join(homedir(), '.dsh', 'agent-os', 'state.json')

  const store = new AgentOsStore(statePath)
  const service = new AgentOsService({ store })

  ctx.provide('agentOs', service)

  // 自动初始化默认 Organization（普通用户免手动建库/建树）
  if (config.autoInit !== false) {
    const org = service.initializeDefault(config.initActor ?? 'system')
    ctx.logger.info(
      `[agent-os] initialized organization ${org.id}, main=${org.mainNodeId}`,
    )
  }

  // 卸载时兜底落盘（作为插件 effect 的 disposer）
  return (): void => store.persist()
}

export const name = 'agent-os'
