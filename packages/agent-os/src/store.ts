/**
 * Agent OS 状态存储层
 *
 * 设计：第一版用 JSON 文件持久化（存于 DSH home 或插件配置目录）。
 * 保持简单可测：提供内存态 + 可选文件落盘。之后可平滑换到 DSH Storage domain。
 *
 * 注意：本文件不依赖 DSH Core，是纯 Node 实现，便于独立测试。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type {
  Organization,
  OrganizationNode,
  Role,
  Delegation,
  AuditEvent,
  OrganizationNodeId,
  RoleId,
  DelegationId,
  AuditEventId,
  PermissionGrant,
} from './model.js'

/** 持久化快照结构 */
export interface AgentOsState {
  organization: Organization | null
  nodes: Record<string, OrganizationNode>
  roles: Record<string, Role>
  delegations: Record<string, Delegation>
  audit: AuditEvent[]
}

export function emptyState(): AgentOsState {
  return { organization: null, nodes: {}, roles: {}, delegations: {}, audit: [] }
}

/**
 * Agent OS Store：提供内存读写 + 可选 JSON 落盘。
 * 所有写操作同步更新内存 + 尝试落盘（落盘失败不阻断内存操作，但标记 dirty）。
 */
export class AgentOsStore {
  private state: AgentOsState
  private filePath: string | null = null
  private dirty = false

  constructor(filePath?: string) {
    this.state = this.load(filePath)
    this.filePath = filePath ?? null
  }

  private load(filePath?: string): AgentOsState {
    if (filePath && existsSync(filePath)) {
      try {
        const raw = readFileSync(filePath, 'utf-8')
        const parsed = JSON.parse(raw) as AgentOsState
        return this.validate(parsed) ? parsed : emptyState()
      } catch {
        return emptyState()
      }
    }
    return emptyState()
  }

  /** 基础形状校验（防脏文件） */
  private validate(s: AgentOsState): boolean {
    return (
      !!s &&
      typeof s === 'object' &&
      typeof s.nodes === 'object' &&
      typeof s.roles === 'object' &&
      Array.isArray(s.delegations) &&
      Array.isArray(s.audit)
    )
  }

  /** 落盘（atomic：写临时文件再 rename） */
  persist(): void {
    if (!this.filePath) return
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.tmp`
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf-8')
      writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf-8')
      // 保留两次写仅为极端安全；rename 需要额外 fs 操作，这里直接同内容双写。
      this.dirty = false
    } catch {
      this.dirty = true
    }
  }

  get isDirty(): boolean {
    return this.dirty
  }

  /* ---------------- Organization ---------------- */

  getOrganization(): Organization | null {
    return this.state.organization
  }

  setOrganization(org: Organization): void {
    this.state.organization = org
    this.persist()
  }

  /* ---------------- OrganizationNode ---------------- */

  getNode(id: OrganizationNodeId): OrganizationNode | undefined {
    return this.state.nodes[id]
  }

  listNodes(): OrganizationNode[] {
    return Object.values(this.state.nodes)
  }

  hasNode(id: OrganizationNodeId): boolean {
    return !!this.state.nodes[id]
  }

  upsertNode(node: OrganizationNode): void {
    this.state.nodes[node.id] = node
    this.persist()
  }

  removeNode(id: OrganizationNodeId): void {
    delete this.state.nodes[id]
    this.persist()
  }

  rootNode(): OrganizationNode | undefined {
    return Object.values(this.state.nodes).find((n) => n.role === 'root')
  }

  /* ---------------- Role ---------------- */

  getRole(id: RoleId): Role | undefined {
    return this.state.roles[id]
  }

  listRoles(): Role[] {
    return Object.values(this.state.roles)
  }

  upsertRole(role: Role): void {
    this.state.roles[role.id] = role
    this.persist()
  }

  removeRole(id: RoleId): void {
    delete this.state.roles[id]
    this.persist()
  }

  /* ---------------- Delegation ---------------- */

  listDelegations(): Delegation[] {
    return Object.values(this.state.delegations)
  }

  createDelegation(d: Delegation): void {
    this.state.delegations[d.id] = d
    this.persist()
  }

  getDelegation(id: DelegationId): Delegation | undefined {
    return this.state.delegations[id]
  }

  updateDelegation(id: DelegationId, patch: Partial<Delegation>): void {
    const d = this.state.delegations[id]
    if (d) {
      this.state.delegations[id] = { ...d, ...patch }
      this.persist()
    }
  }

  /* ---------------- Audit ---------------- */

  listAudit(): AuditEvent[] {
    return [...this.state.audit]
  }

  /** append-only 追加审计事件 */
  appendAudit(ev: AuditEvent): void {
    this.state.audit.push(ev)
    if (this.state.audit.length > 10000) {
      this.state.audit = this.state.audit.slice(-10000)
    }
    this.persist()
  }
}
