/**
 * agent-os 核心类型与数据模型
 *
 * 依据冻结架构（DSH × Agent OS）：
 *   User = Root Authority
 *   DSH = Agent Runtime Platform（Agent/Session/Workspace/Model/Tool/Plugin/Channel/Event/Subagent Runtime）
 *   Agent OS = DSH Plugin（Organization/Hierarchy/Role/Authority/Capability/Permission/Policy/
 *              Delegation/Approval/Constraint/Risk/Audit/Lifecycle/Runtime Binding）
 *
 * 组织树：User → Main Agent → Department Agent → Specialist Agent
 *
 * 核心原则：
 *   - Agent 怎么运行 = DSH
 *   - Agent 怎么组织、授权、治理、委派 = Agent OS
 *   - OrganizationNode 是稳定组织身份；DSH Agent/Session 是运行实例，两者分离
 *   - Workspace 与 Agent OS Organization 是两个独立维度
 */

/** 组织节点稳定身份（与 DSH Agent/Session 的 runtime id 分离） */
export type OrganizationNodeId = string & { readonly __brand: 'OrganizationNodeId' }

/** 组织角色 */
export type RoleId = string & { readonly __brand: 'RoleId' }

/** 委派记录 id */
export type DelegationId = string & { readonly __brand: 'DelegationId' }

/** 权限授予记录 id */
export type GrantId = string & { readonly __brand: 'GrantId' }

/** 审计事件 id */
export type AuditEventId = string & { readonly __brand: 'AuditEventId' }

/* ---------------------------------------------------------------------------
 * OrganizationNode 角色类型
 * ------------------------------------------------------------------------- */

/** 组织节点角色：根 / 主 agent（内阁）/ 部门 / 专业 agent */
export type NodeRole = 'root' | 'main' | 'department' | 'specialist'

export const ALL_ORG_NODE_ROLES: readonly NodeRole[] = [
  'root',
  'main',
  'department',
  'specialist',
]

/* ---------------------------------------------------------------------------
 * AgentBinding —— 组织节点到运行时实体的绑定
 *
 * OrganizationNode（稳定） → AgentBinding → DSH Agent / Session（运行实例）
 * 如果 DSH Agent 重启，OrganizationNode 不消失，可重新绑定到新的 DSH Agent/Session。
 * ------------------------------------------------------------------------- */

export type BindingStatus = 'active' | 'detached' | 'stale'

/** Agent 与 DSH 运行实例的绑定 */
export interface AgentBinding {
  /** 本绑定记录 id（每次绑定唯一） */
  readonly id: string
  /** 组织节点 id（稳定身份） */
  readonly organizationNodeId: OrganizationNodeId
  /** 绑定的 DSH runtime agent/session id（可随重启变化） */
  readonly runtimeAgentId: string
  /** 绑定时可选的 sessionId（DSH 中 agent.id === session.id） */
  readonly sessionId?: string
  /** 绑定状态 */
  readonly status: BindingStatus
  /** 绑定创建时间 ISO-8601 */
  readonly createdAt: string
  /** 最近更新 ISO-8601 */
  readonly updatedAt: string
}

/* ---------------------------------------------------------------------------
 * Role —— 组织角色（一组权限模板）
 * ------------------------------------------------------------------------- */

/** 权限名称（与 DSH 工具/动作对齐） */
export type PermissionName = string

/**
 * 权限声明。Capability ≠ Permission：
 *  - Capability = Agent 理论上能做的
 *  - Permission = 当前允许做的
 */
export interface PermissionGrant {
  /** 权限名称（如 'delegate' / 'tool:exec' / 'tool:fs.write'） */
  readonly permission: PermissionName
  /** 影响范围（可选的资源 scope） */
  readonly scope?: string
  /** 是否允许（默认允许；deny 用于显式排除） */
  readonly effect: 'allow' | 'deny'
}

/** 一个角色 = 一组权限模板 */
export interface Role {
  readonly id: RoleId
  /** 展示名，如 "内阁" / "工程部" */
  readonly name: string
  readonly description?: string
  /** 角色继承的其他角色（权限叠加） */
  readonly inherits?: readonly RoleId[]
  /** 角色权限模板 */
  readonly permissions: readonly PermissionGrant[]
  readonly createdAt: string
  readonly updatedAt?: string
}

/* ---------------------------------------------------------------------------
 * OrganizationNode —— 组织树节点
 * ------------------------------------------------------------------------- */

/** 组织树节点 */
export interface OrganizationNode {
  /** 稳定组织身份（与 DSH Agent runtime id 分离） */
  readonly id: OrganizationNodeId
  /** 父节点 id（root 为 null） */
  readonly parentId: OrganizationNodeId | null
  /** 节点角色 */
  readonly role: NodeRole
  /** 节点名，如 "Engineering" / "Coding" */
  readonly name: string
  readonly description?: string
  /** 绑定的角色 id 列表 */
  readonly roleIds: readonly RoleId[]
  /** 当前运行时绑定（与 DSH Agent 的绑定；可 detached） */
  readonly binding: AgentBinding | null
  /** 子节点 id 列表（顺序保留） */
  readonly children: readonly OrganizationNodeId[]
  readonly createdAt: string
  readonly updatedAt: string
}

/* ---------------------------------------------------------------------------
 * Organization —— 组织根
 * ------------------------------------------------------------------------- */

export interface Organization {
  readonly id: OrganizationNodeId
  readonly mainNodeId: OrganizationNodeId | null
  readonly createdAt: string
  readonly updatedAt: string
}

/* ---------------------------------------------------------------------------
 * Delegation —— 委派
 *
 * Agent OS 判断「该组织节点有无权力委派」；DSH 负责「怎么创建/运行子 Agent」。
 * 本记录是 Agent OS 侧的治理/审计记录，指向 DSH 的运行时所有权关系
 * （DSH: AgentRegistry.enter(agent, owner) / isOwnedBy / createAgent(ownerCtx) / delegationDepth）。
 * ------------------------------------------------------------------------- */

export type DelegationStatus = 'active' | 'revoked' | 'completed'

export interface Delegation {
  readonly id: DelegationId
  /** 委派方组织节点 */
  readonly fromNodeId: OrganizationNodeId
  /** 被委派组织节点 */
  readonly toNodeId: OrganizationNodeId
  /** 委派的权限范围 */
  readonly permissions: readonly PermissionName[]
  /** DSH 运行时——父 agent id（由 DSH 裁决如何 spawn） */
  readonly parentRuntimeAgentId?: string
  /** DSH 运行时——子 agent id */
  readonly childRuntimeAgentId?: string
  /** 委派深度（DSH delegationDepth 镜像） */
  readonly depth: number
  readonly status: DelegationStatus
  readonly createdAt: string
  readonly updatedAt?: string
}

/* ---------------------------------------------------------------------------
 * Authority —— 谁有权授予/撤销/委派权限，以及治理决策
 *
 * 组织层级不能自动等于全部权限。Authority 是独立于 Permission 的治理层。
 * ------------------------------------------------------------------------- */

/** 治理操作：授予权限 / 撤销权限 / 委派 / 创建组织节点 / 绑定 */
export type AuthorityAction =
  | 'grant'
  | 'revoke'
  | 'delegate'
  | 'create-node'
  | 'bind'
  | 'detach'

/** Authority 声明：某个组织节点对某治理操作是否有权 */
export interface AuthorityGrant {
  readonly nodeId: OrganizationNodeId
  readonly action: AuthorityAction
  readonly granted: boolean
}

/* ---------------------------------------------------------------------------
 * Audit —— 审计事件（append-only 式）
 * ------------------------------------------------------------------------- */

export type AuditActorType = 'user' | 'agent' | 'system'

export interface AuditEvent {
  readonly id: AuditEventId
  readonly ts: string
  readonly actorType: AuditActorType
  /** actor：user id / agent runtime id / 'system' */
  readonly actorId: string
  readonly action: string
  readonly targetType?: string
  readonly targetId?: string
  readonly detail?: Record<string, unknown>
}
