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
import type { DshRuntimeAdapter } from './dsh-adapter.js'

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

/**
 * 创建 Agent OS 服务（应用层用；插件 apply 内部调用）。
 * runtime 为 DSH Runtime 适配器；缺省时不拉起真实 Agent（Runtime integration READY，
 * Real DSH validation PENDING）。
 */
export function createAgentOs(
  statePath: string,
  runtime?: DshRuntimeAdapter,
  autoInit = true,
  initActor = 'system',
): { service: AgentOsService; store: AgentOsStore } {
  const store = new AgentOsStore(statePath)
  const service = new AgentOsService({ store, runtime })
  if (autoInit) service.initializeDefault(initActor)
  return { service, store }
}

/** Agent OS plugin：给 ctx 提供 agentOs 服务 */
export function apply(
  ctx: Context,
  config: Config,
  runtime?: DshRuntimeAdapter,
): () => Promise<void> {
  const statePath =
    config.statePath ?? join(homedir(), '.dsh', 'agent-os', 'state.json')

  const { service, store } = createAgentOs(
    statePath,
    runtime,
    config.autoInit !== false,
    config.initActor ?? 'system',
  )

  ctx.provide('agentOs', service)

  const org = service.initializeDefault(config.initActor ?? 'system')
  ctx.logger.info(
    `[agent-os] initialized organization ${org.id}, main=${org.mainNodeId}`,
  )

  // 卸载时兜底落盘 + 销毁存活 DSH Agent（防孤儿 Agent）
  return async (): Promise<void> => {
    await service.disposeAll('system')
    store.persist()
  }
}

export const name = 'agent-os'
