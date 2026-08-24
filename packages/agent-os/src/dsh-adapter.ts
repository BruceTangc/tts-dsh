/**
 * DSH Runtime Adapter —— Agent OS 与 DSH Agent Runtime 的边界层
 *
 * Agent OS 通过本接口调用 DSH 的已有 Runtime API，禁止重实现 Agent Runtime。
 *
 * 本接口对齐 DSH 实际 API（依据 DSH 源码审计结论）：
 *   - createAgent(ownerCtx)        —— 以某个 owner 上下文创建一个 Agent + Session
 *   - resume(ownerCtx)             —— 从持久化恢复一个 Agent
 *   - AgentRegistry.enter(agent, owner) —— 以指定运行时 owner 注册一个 Agent
 *   - isOwnedBy(childId, owner)    —— 校验父子运行时 ownership
 *   - AgentHandle.dispose()        —— 销毁 Agent
 *   - delegationDepth              —— 委派深度
 *
 * 本目录下区分两种实现：
 *   - DshRuntimeAdapter   : 真实 DSH 的适配（结构对齐，但需真实 DSH host 才能运行）
 *   - MockDshRuntimeAdapter : 测试用 mock（仅验证接口契约，明确标记 MOCK）
 *
 * ⚠️ 最终状态标记：
 *   Runtime integration implementation: READY
 *   Real DSH runtime validation: PENDING LOCAL TEST
 */

/** DSH 侧 AgentHandle 的最小契约（对齐 Agent OS 所需子集，不重实现） */
export interface DshAgentHandle {
  /** 运行实例的 agent/session id（DSH 中 agent.id === session.id） */
  readonly id: string
  /** 销毁该 Agent（DSH AgentHandle.dispose()） */
  dispose(): Promise<void>
  /** 判断该 Agent 是否仍存活（回调包装） */
  isAlive(): boolean
  /** 下发一条真实运行任务（DSH Agent.send/steer/followup 的窄适配） */
  runTask?(prompt: string): Promise<unknown>
}

/** 创建 Agent 时的输入（对齐 DSH 的 owner 语义） */
export interface CreateDshAgentOptions {
  /** 运行 identity（agent/session 共用）；缺省时由 adapter 生成 */
  requestedId?: string
  /** 模型/provider（可选，对齐 DSH AgentOptions） */
  provider?: string
  model?: string
  maxTokens?: number
  /** 额外可选配置 */
  prompt?: string
}

/** 恢复（resume）Agent 时的输入 */
export interface ResumeDshAgentOptions {
  /** 要恢复的持久化 session id */
  sessionId: string
}

/**
 * DSH Runtime Adapter 接口
 *
 * 这是 Agent OS（治理层）与 DSH（运行层）之间的唯一边界。
 * 所有 Agent 的创建/恢复/销毁/ownership 都以 owner 上下文表达。
 */
export interface DshRuntimeAdapter {
  readonly name: string

  /**
   * 以 owner 上下文创建一个真实 DSH Agent + Session。
   * 返回的 handle 由 Agent OS 记录进 AgentBinding。
   */
  createAgent(
    ownerId: string | undefined,
    options: CreateDshAgentOptions,
  ): Promise<DshAgentHandle>

  /** 从持久化恢复一个 Agent（owner 可为创建时的 parent）。 */
  resume(ownerId: string | undefined, sessionId: string): Promise<DshAgentHandle>

  /** 向 DSH Registry 登记一个运行时 child（enter(agent, owner) 语义）。 */
  enterAgent(handle: DshAgentHandle, ownerId: string | undefined): void

  /** 校验父子运行时 ownership（isOwnedBy 语义）。 */
  isOwnedBy(childRuntimeId: string, ownerRuntimeId: string): boolean

  /** 销毁 Agent（AgentHandle.dispose），返回是否销毁成功。 */
  dispose(handle: DshAgentHandle): Promise<boolean>

  /** 委派深度（delegationDepth 语义）。 */
  get delegationDepth(): number
}
