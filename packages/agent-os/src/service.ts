/**
 * Agent OS Service —— 组织 / 节点 / 角色 / 绑定 / 委派 / 授权 / 审计 的读写操作
 *
 * 纯逻辑层（不依赖 DSH Cordis Context），便于独立测试。
 * DSH 集成层（plugin.ts）负责把本服务挂到 ctx 并接入 DSH Runtime。
 */
import { randomUUID } from 'node:crypto'

import type {
  Organization,
  OrganizationNode,
  OrganizationNodeId,
  Role,
  RoleId,
  NodeRole,
  AgentBinding,
  Delegation,
  PermissionGrant,
  PermissionName,
  AuthorityAction,
  AuditActorType,
  AuditEvent,
} from './model.js'
import { AgentOsStore } from './store.js'
import type { DshRuntimeAdapter } from './dsh-adapter.js'

/** 创建组织/节点时需要的简单 id 生成（可注入以便测试确定性） */
export type IdGen = () => string

export function defaultIdGen(): string {
  return randomUUID()
}

export interface AgentOsServiceDeps {
  store: AgentOsStore
  /** DSH Runtime 适配（真实 DSH 或 mock）。缺省时 Runtime Binding 仅记录不启动真正 Agent。 */
  runtime?: DshRuntimeAdapter
  idGen?: IdGen
  now?: () => string
}

interface NewNodeInput {
  parentId: OrganizationNodeId | null
  role: NodeRole
  name: string
  description?: string
  roleIds?: RoleId[]
}

/**
 * Agent OS 服务：所有治理/授权/委派操作都经此层，并自动写审计事件。
 * DSH 只负责 Agent 的运行（本服务不实现 Agent Runtime）。
 */
export class AgentOsService {
  private store: AgentOsStore
  private runtime: DshRuntimeAdapter | undefined
  private idGen: IdGen
  private now: () => string
  /** 存活 DSH Agent handle 引用（不入持久化；供 disposal 用，卸载时兜底清理） */
  private liveHandles = new Map<string, import('./dsh-adapter.js').DshAgentHandle>()

  constructor(deps: AgentOsServiceDeps) {
    this.store = deps.store
    this.runtime = deps.runtime
    this.idGen = deps.idGen ?? defaultIdGen
    this.now = deps.now ?? (() => new Date().toISOString())
  }

  private audit(
    actorType: AuditActorType,
    actorId: string,
    action: string,
    targetType?: string,
    targetId?: string,
    detail?: Record<string, unknown>,
  ): void {
    const ts = this.now()
    this.store.appendAudit({
      id: `audit-${ts}-${Math.random().toString(36).slice(2, 8)}` as AuditEvent['id'],
      ts,
      actorType,
      actorId,
      action,
      targetType,
      targetId,
      detail,
    })
  }

  /* ================= 初始化 ================= */

  get isInitialized(): boolean {
    return this.store.getOrganization() !== null
  }

  get organization(): Organization | null {
    return this.store.getOrganization()
  }

  /** 自动初始化默认 Organization + Root/Main OrganizationNode。幂等。 */
  initializeDefault(actorId = 'system'): Organization {
    const existing = this.store.getOrganization()
    if (existing) return existing

    const ts = this.now()
    const rootId = this.nodeId('root')
    const mainId = this.nodeId('main')

    // Root / Main 两个组织节点
    const rootNode: OrganizationNode = {
      id: rootId,
      parentId: null,
      role: 'root',
      name: 'Root',
      description: 'Organization root (User = Root Authority)',
      roleIds: [],
      binding: null,
      children: [mainId],
      createdAt: ts,
      updatedAt: ts,
    }
    const mainNode: OrganizationNode = {
      id: mainId,
      parentId: rootId,
      role: 'main',
      name: 'Main Agent',
      description: '内阁 — main agent under the user',
      roleIds: [],
      binding: null,
      children: [],
      createdAt: ts,
      updatedAt: ts,
    }

    this.store.upsertNode(rootNode)
    this.store.upsertNode(mainNode)
    this.store.setOrganization({
      id: this.nodeId('org'),
      mainNodeId: mainId,
      createdAt: ts,
      updatedAt: ts,
    })

    this.audit('system', actorId, 'org.initialize', 'organization', mainId, {
      rootNodeId: rootId,
      mainNodeId: mainId,
    })
    return this.store.getOrganization()!
  }

  /** 生成稳定组织节点 id（可读 + 防碰撞） */
  private nodeId(role: string): OrganizationNodeId {
    const ts = Date.now().toString(36)
    return `node-${role}-${ts}-${Math.random().toString(36).slice(2, 8)}` as OrganizationNodeId
  }

  private newRoleId(): RoleId {
    return `role-${this.idGen()}` as RoleId
  }

  /* ================= OrganizationNode ================= */

  getNode(id: OrganizationNodeId): OrganizationNode | undefined {
    return this.store.getNode(id)
  }

  listNodes(): OrganizationNode[] {
    return this.store.listNodes()
  }

  rootNode(): OrganizationNode | undefined {
    return this.store.rootNode()
  }

  /** 创建组织节点（必须有权限 create-node，或为 root 初始化内部调用） */
  createNode(actorId: string, input: NewNodeInput): OrganizationNode {
    if (!this.store.getOrganization()) {
      throw new Error('organization not initialized; call initializeDefault() first')
    }
    if (input.parentId !== null) {
      const parent = this.store.getNode(input.parentId)
      if (!parent) throw new Error(`parent node not found: ${input.parentId}`)
      if (!this.can(actorId, 'create-node', input.parentId)) {
        throw new Error(`actor ${actorId} lacks authority create-node on ${input.parentId}`)
      }
    }
    const ts = this.now()
    const id = this.nodeId(input.role)
    const node: OrganizationNode = {
      id,
      parentId: input.parentId,
      role: input.role,
      name: input.name,
      description: input.description,
      roleIds: (input.roleIds ?? []).filter((r) => this.store.getRole(r) !== undefined),
      binding: null,
      children: [],
      createdAt: ts,
      updatedAt: ts,
    }
    this.store.upsertNode(node)

    // 挂到父节点 children
    if (input.parentId) {
      const parent = this.store.getNode(input.parentId)!
      this.store.upsertNode({ ...parent, children: [...parent.children, id], updatedAt: ts })
    }
    this.audit('agent', actorId, 'node.create', 'node', id, {
      role: input.role,
      parentId: input.parentId,
      name: input.name,
    })
    return node
  }

  /** 绑定组织节点到一个 DSH Agent/Session（Runtime Binding）。幂等，替换旧绑定。 */
  bindNode(
    actorId: string,
    nodeId: OrganizationNodeId,
    runtimeAgentId: string,
    sessionId?: string,
  ): AgentBinding {
    if (!this.can(actorId, 'bind', nodeId)) {
      throw new Error(`actor ${actorId} lacks authority bind on ${nodeId}`)
    }
    const node = this.store.getNode(nodeId)
    if (!node) throw new Error(`node not found: ${nodeId}`)

    const ts = this.now()
    const binding: AgentBinding = {
      id: `binding-${this.idGen()}`,
      organizationNodeId: nodeId,
      runtimeAgentId,
      sessionId,
      status: 'active',
      createdAt: ts,
      updatedAt: ts,
    }
    this.store.upsertNode({ ...node, binding, updatedAt: ts })
    this.audit('agent', actorId, 'node.bind', 'node', nodeId, { runtimeAgentId, sessionId })
    return binding
  }

  /** 解绑（组织身份保留，仅移除 runtime 绑定） */
  detachNode(actorId: string, nodeId: OrganizationNodeId): void {
    if (!this.can(actorId, 'detach', nodeId)) {
      throw new Error(`actor ${actorId} lacks authority detach on ${nodeId}`)
    }
    const node = this.store.getNode(nodeId)
    if (!node) throw new Error(`node not found: ${nodeId}`)
    const ts = this.now()
    this.store.upsertNode({ ...node, binding: null, updatedAt: ts })
    this.audit('agent', actorId, 'node.detach', 'node', nodeId)
  }

  /** 返回当前注入的 runtime adapter（未注入返回 undefined） */
  get runtimeAdapter(): DshRuntimeAdapter | undefined {
    return this.runtime
  }

  /**
   * 激活组织节点 —— 创建/恢复一个真实 DSH Runtime Agent 并建立 AgentBinding。
   *
   * Agent OS 判断「该组织是否应启动 Agent」，DSH 负责「创建/恢复 Agent + 绑定 + Ownership」。
   * 若未注入 runtime adapter，则退化为“仅记录待绑定”（binding=null，返回 null）。
   *
   * parentRuntimeId：父 Agent 的 runtime id（用于 DSH ownership：createAgent(ownerCtx)）。
   */
  async activateNode(
    actorId: string,
    nodeId: OrganizationNodeId,
    options?: {
      parentRuntimeId?: string
      requestedId?: string
      provider?: string
      model?: string
      prompt?: string
    },
  ): Promise<AgentBinding | null> {
    if (!this.can(actorId, 'bind', nodeId)) {
      throw new Error(`actor ${actorId} lacks authority bind on ${nodeId}`)
    }
    const node = this.store.getNode(nodeId)
    if (!node) throw new Error(`node not found: ${nodeId}`)
    if (!this.runtime) return null // 无 runtime host：仅记录不拉起

    const handle = await this.runtime.createAgent(options?.parentRuntimeId, {
      requestedId: options?.requestedId,
      provider: options?.provider,
      model: options?.model,
      prompt: options?.prompt,
    })
    // enter(agent, owner)：向 DSH Registry 登记运行时 child
    this.runtime.enterAgent(handle, options?.parentRuntimeId)

    const ts = this.now()
    const binding: AgentBinding = {
      id: `binding-${this.idGen()}`,
      organizationNodeId: nodeId,
      runtimeAgentId: handle.id,
      sessionId: handle.id,
      status: 'active',
      createdAt: ts,
      updatedAt: ts,
    }
    // 附带记录 runtime handle 引用（供 disposal 用，不入持久化）
    this.liveHandles.set(handle.id, handle)
    this.store.upsertNode({ ...node, binding, updatedAt: ts })
    this.audit('agent', actorId, 'node.activate', 'node', nodeId, {
      runtimeAgentId: handle.id,
      parentRuntimeId: options?.parentRuntimeId,
    })
    return binding
  }

  /**
   * 恢复组织节点的 Runtime 绑定（持久化加载后：OrganizationTree 恢复 → 重新绑定）。
   * 若旧 Runtime Agent 已不存在，则通过 resume/create 重新建立。
   */
  async resumeNode(actorId: string, nodeId: OrganizationNodeId): Promise<AgentBinding | null> {
    if (!this.runtime) return null
    const node = this.store.getNode(nodeId)
    if (!node) throw new Error(`node not found: ${nodeId}`)
    if (node.binding && node.binding.status === 'active') {
      // 尝试恢复已存在的 runtime agent
      try {
        const handle = await this.runtime.resume(undefined, node.binding.runtimeAgentId)
        this.liveHandles.set(handle.id, handle)
        return node.binding
      } catch {
        // 旧 runtime 不存在 → 走重新创建
      }
    }
    return this.activateNode(actorId, nodeId, {
      parentRuntimeId: this.parentRuntimeId(node),
    })
  }

  /** 找出某节点的父节点已激活的 runtime agent id（用于 ownership）。 */
  private parentRuntimeId(node: OrganizationNode): string | undefined {
    if (!node.parentId) return undefined
    const parent = this.store.getNode(node.parentId)
    return parent?.binding?.runtimeAgentId
  }

  /**
   * 销毁组织节点的 Runtime Agent（AgentHandle.dispose），保留组织身份。
   * DSH 负责实际 dispose，Agent OS 只更新 binding 状态。
   */
  async disposeNode(actorId: string, nodeId: OrganizationNodeId): Promise<boolean> {
    if (!this.can(actorId, 'bind', nodeId)) {
      throw new Error(`actor ${actorId} lacks authority bind on ${nodeId}`)
    }
    const node = this.store.getNode(nodeId)
    if (!node) return false
    if (!this.runtime || !node.binding) return false
    const handle = this.liveHandles.get(node.binding.runtimeAgentId)
    let ok = false
    if (handle) {
      ok = await this.runtime.dispose(handle)
      this.liveHandles.delete(node.binding.runtimeAgentId)
    }
    const ts = this.now()
    this.store.upsertNode({
      ...node,
      binding: node.binding ? { ...node.binding, status: 'stale', updatedAt: ts } : null,
      updatedAt: ts,
    })
    this.audit('agent', actorId, 'node.dispose', 'node', nodeId, { ok })
    return ok
  }

  /** 组织树：给定节点，返回其所有后代 id（含自身）。 */
  subtree(nodeId: OrganizationNodeId): OrganizationNodeId[] {
    const acc: OrganizationNodeId[] = []
    const visit = (id: OrganizationNodeId) => {
      const n = this.store.getNode(id)
      if (!n) return
      acc.push(id)
      for (const c of n.children) visit(c)
    }
    visit(nodeId)
    return acc
  }

  /* ================= Role ================= */

  createRole(input: { name: string; description?: string; inherits?: RoleId[]; permissions: PermissionGrant[] }): Role {
    const id = this.newRoleId()
    const role: Role = {
      id,
      name: input.name,
      description: input.description,
      inherits: input.inherits,
      permissions: input.permissions,
      createdAt: this.now(),
    }
    this.store.upsertRole(role)
    this.audit('system', 'system', 'role.create', 'role', id, { name: input.name })
    return role
  }

  getRole(id: RoleId): Role | undefined {
    return this.store.getRole(id)
  }

  /** 收集一个节点的全部有效权限（含角色继承，deny 优先于 allow）。 */
  effectivePermissions(nodeId: OrganizationNodeId): Map<PermissionName, PermissionGrant> {
    const node = this.store.getNode(nodeId)
    const result = new Map<PermissionName, PermissionGrant>()
    if (!node) return result
    for (const roleId of node.roleIds) this.collectRole(roleId, result, new Set())
    return result
  }

  private collectRole(
    roleId: RoleId,
    acc: Map<PermissionName, PermissionGrant>,
    seen: Set<RoleId>,
  ): void {
    if (seen.has(roleId)) return
    seen.add(roleId)
    const role = this.store.getRole(roleId)
    if (!role) return
    for (const g of role.permissions) acc.set(g.permission, g)
    for (const inh of role.inherits ?? []) this.collectRole(inh, acc, seen)
  }

  /** 判断某组织节点是否有某权限（Capability ≠ Permission）。 */
  hasPermission(nodeId: OrganizationNodeId, permission: PermissionName): boolean {
    const node = this.store.getNode(nodeId)
    if (!node) return false
    // root 节点天然拥有治理权（User = Root Authority 的运行时代理）
    if (node.role === 'root') return true
    const perms = this.effectivePermissions(nodeId)
    const g = perms.get(permission)
    return !!g && g.effect === 'allow'
  }

  /** 简单 Authority 判定：治理动作（grant/revoke/delegate/create-node/bind/detach）。 */
  can(actorId: string, action: AuthorityAction, targetNodeId?: OrganizationNodeId): boolean {
    const node = this.store.getNode(actorId as OrganizationNodeId)
    if (!node) return true // 未知 actor（如外部）默认放行，交给 DSH/上层策略
    if (node.role === 'root') return true
    // 治理动作：有 delegate 权限即可 grant/revoke/delegate/create-node/bind/detach
    return this.hasPermission(node.id, action)
  }

  /* ================= Delegation ================= */

  listDelegations(): Delegation[] {
    return this.store.listDelegations()
  }

  /**
   * 发起一次委派。Agent OS 只判断「委派方是否有权委派」(hasPermission delegate)，
   * DSH 负责实际 spawn 子 Agent（本服务只落审计/治理记录）。
   */
  delegate(
    actorId: string,
    fromNodeId: OrganizationNodeId,
    toNodeId: OrganizationNodeId,
    permissions: PermissionName[],
    options?: { parentRuntimeAgentId?: string; childRuntimeAgentId?: string; depth?: number },
  ): Delegation {
    if (!this.hasPermission(fromNodeId, 'delegate')) {
      throw new Error(`node ${fromNodeId} lacks delegate permission`)
    }
    const fromNode = this.store.getNode(fromNodeId)
    const toNode = this.store.getNode(toNodeId)
    if (!fromNode || !toNode) throw new Error('delegation requires both nodes to exist')
    const ts = this.now()
    const d: Delegation = {
      id: `delegation-${this.idGen()}` as Delegation['id'],
      fromNodeId,
      toNodeId,
      permissions,
      parentRuntimeAgentId: options?.parentRuntimeAgentId,
      childRuntimeAgentId: options?.childRuntimeAgentId,
      depth: options?.depth ?? 1,
      status: 'active',
      createdAt: ts,
    }
    this.store.createDelegation(d)
    this.audit('agent', actorId, 'delegation.create', 'delegation', d.id, {
      fromNodeId,
      toNodeId,
      permissions,
    })
    return d
  }

  revokeDelegation(actorId: string, delegationId: Delegation['id']): void {
    const d = this.store.getDelegation(delegationId)
    if (!d) throw new Error(`delegation not found: ${delegationId}`)
    if (!this.can(actorId, 'delegate', d.fromNodeId)) {
      throw new Error(`actor ${actorId} lacks authority to revoke delegation`)
    }
    this.store.updateDelegation(delegationId, { status: 'revoked', updatedAt: this.now() })
    this.audit('agent', actorId, 'delegation.revoke', 'delegation', delegationId)
  }

  /* ================= Permission 授予（Grant 记录） ================= */

  grantPermission(
    actorId: string,
    nodeId: OrganizationNodeId,
    permission: PermissionName,
    scope?: string,
  ): void {
    if (!this.can(actorId, 'grant', nodeId)) {
      throw new Error(`actor ${actorId} lacks authority grant on ${nodeId}`)
    }
    const role = this.ensureGrantRole(nodeId, permission, 'allow', scope)
    void role
    this.audit('agent', actorId, 'permission.grant', 'node', nodeId, { permission, scope })
  }

  revokePermission(
    actorId: string,
    nodeId: OrganizationNodeId,
    permission: PermissionName,
  ): void {
    if (!this.can(actorId, 'revoke', nodeId)) {
      throw new Error(`actor ${actorId} lacks authority revoke on ${nodeId}`)
    }
    const role = this.ensureGrantRole(nodeId, permission, 'deny')
    void role
    this.audit('agent', actorId, 'permission.revoke', 'node', nodeId, { permission })
  }

  /** 内部：给节点建/复用一个隐形 grant role 并写入权限（便于持久化 + 审计回放） */
  private ensureGrantRole(
    nodeId: OrganizationNodeId,
    permission: PermissionName,
    effect: 'allow' | 'deny',
    scope?: string,
  ): Role {
    const node = this.store.getNode(nodeId)
    if (!node) throw new Error(`node not found: ${nodeId}`)
    const grantRoleId = `role-grant-${nodeId}` as RoleId
    let role = this.store.getRole(grantRoleId)
    if (!role) {
      role = {
        id: grantRoleId,
        name: `grant[${nodeId}]`,
        permissions: [],
        createdAt: this.now(),
      }
      this.store.upsertRole(role)
    }
    const filtered = role.permissions.filter((g) => g.permission !== permission || g.effect !== effect)
    const updated: Role = {
      ...role,
      permissions: [...filtered, { permission, effect, scope }],
      updatedAt: this.now(),
    }
    this.store.upsertRole(updated)
    if (!node.roleIds.includes(grantRoleId)) {
      this.store.upsertNode({ ...node, roleIds: [...node.roleIds, grantRoleId], updatedAt: this.now() })
    }
    return updated
  }

  /* ================= Audit ================= */

  listAudit(): AuditEvent[] {
    return this.store.listAudit()
  }

  /* ================= 清理（Plugin unload） ================= */

  /**
   * 销毁所有存活 DSH Agent handle（Plugin unload/reload 时兜底，防孤儿 Agent）。
   * 返回销毁的数量。组织身份（nodes）保留，仅清理 runtime 实例。
   */
  async disposeAll(actorId = 'system'): Promise<number> {
    let disposed = 0
    for (const handle of this.liveHandles.values()) {
      try {
        await handle.dispose()
        disposed++
      } catch {
        /* 单个失败不阻断整体清理 */
      }
    }
    this.liveHandles.clear()
    if (disposed > 0) {
      this.audit('system', actorId, 'org.disposeAll', undefined, undefined, { disposed })
    }
    return disposed
  }
}
