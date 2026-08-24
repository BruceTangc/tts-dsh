/**
 * MockDshRuntimeAdapter —— 仅用于测试的 DSH Runtime 假实现
 *
 * ⚠️ MOCK：这是测试替身，不是真实 DSH Runtime。
 * 它只实现 DshRuntimeAdapter 的接口契约（在内存里模拟一个 Agent 注册表），
 * 用于验证 Agent OS 的 Runtime Binding / ownership / create/resume/dispose
 * 逻辑正确。**它不执行真实模型调用，不代表真实 DSH 已验证。**
 *
 * 真实 DSH 适配见 DshRuntimeAdapter（dsh-adapter.ts 的契约），需真实 DSH host 才能跑。
 */
import type {
  DshRuntimeAdapter,
  DshAgentHandle,
  CreateDshAgentOptions,
} from './dsh-adapter.js'

/** Mock: 一个内存 DSH Agent 记录 */
interface MockAgent {
  handle: DshAgentHandle
  ownerId: string | undefined
  alive: boolean
  disposed: boolean
}

/**
 * 内存 DSH Runtime mock。
 * 维护一个注册表，模拟：
 *   - createAgent（生成 id、登记、返回 handle）
 *   - resume（按 id 恢复）
 *   - enter（记录 owner）
 *   - isOwnedBy（按 owner 判定）
 *   - dispose（标记销毁并从 registry 移除）
 *   - delegationDepth（可配置）
 */
export class MockDshRuntimeAdapter implements DshRuntimeAdapter {
  readonly name = 'mock'
  private registry = new Map<string, MockAgent>()
  private seq = 0
  /** 委派深度（测试可调整） */
  depth = 1

  /** 测试钩子：登记时回调，便于断言 enter 是否被调用 */
  onEnter?: (childId: string, ownerId: string | undefined) => void

  constructor(options?: { depth?: number }) {
    if (options?.depth !== undefined) this.depth = options.depth
  }

  get delegationDepth(): number {
    return this.depth
  }

  /** 列出所有存活（未销毁）的 agent id */
  listAlive(): string[] {
    return [...this.registry.values()]
      .filter((a) => a.alive && !a.disposed)
      .map((a) => a.handle.id)
  }

  /** 查一个 agent 的 owner（测试断言用） */
  ownerOf(runtimeId: string): string | undefined {
    return this.registry.get(runtimeId)?.ownerId
  }

  async createAgent(
    ownerId: string | undefined,
    options: CreateDshAgentOptions = {},
  ): Promise<DshAgentHandle> {
    const id = options.requestedId ?? `mock-agent-${++this.seq}`
    // 模拟 DSH：agent.id === session.id
    const handle: DshAgentHandle = {
      id,
      isAlive: () => this.registry.get(id)?.alive ?? false,
      dispose: async () => {
        const a = this.registry.get(id)
        if (a) {
          a.alive = false
          a.disposed = true
          this.registry.delete(id)
        }
      },
      runTask: async (prompt: string) => {
        // MOCK：不执行真实模型调用；仅记录“收到任务”，返回一个占位结果。
        // 真实执行需真实 DSH host。
        return {
          _mock: true,
          agentId: id,
          receivedPrompt: prompt,
          result: 'mock-ack',
        }
      },
    }
    const rec: MockAgent = { handle, ownerId, alive: true, disposed: false }
    this.registry.set(id, rec)
    return handle
  }

  async resume(
    _ownerId: string | undefined,
    sessionId: string,
  ): Promise<DshAgentHandle> {
    const rec = this.registry.get(sessionId)
    if (!rec) {
      throw new Error(`mock: no persisted agent ${sessionId}`)
    }
    return rec.handle
  }

  enterAgent(handle: DshAgentHandle, ownerId: string | undefined): void {
    const rec = this.registry.get(handle.id)
    if (rec) rec.ownerId = ownerId
    this.onEnter?.(handle.id, ownerId)
  }

  isOwnedBy(childRuntimeId: string, ownerRuntimeId: string): boolean {
    return this.registry.get(childRuntimeId)?.ownerId === ownerRuntimeId
  }

  async dispose(handle: DshAgentHandle): Promise<boolean> {
    const rec = this.registry.get(handle.id)
    if (!rec) return false
    await handle.dispose()
    return true
  }
}
