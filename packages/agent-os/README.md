# @tts-dsh/agent-os

Agent OS — 基于 DeepSeek Harness（DSH）的插件。在 DSH 之上提供组织 / 层级 / 角色 / 运行时绑定 / 委派 / 授权 / 权限 / 治理 / 审计。

## 架构边界（依据冻结架构）

```
User = Root Authority
  ↓
DSH = Agent Runtime Platform   （Agent/Session/Workspace/Model/Tool/Plugin/Subagent/Event/State）
  ↓
Agent OS = DSH Plugin          （Organization/Hierarchy/Role/Authority/Capability/Permission/
                                 Policy/Delegation/Approval/Constraint/Risk/Audit/Lifecycle/Binding）
```

- **Agent 怎么运行 = DSH**（不修改 DSH Core，不重实现任何 Runtime）
- **Agent 怎么组织、授权、治理、委派 = Agent OS**
- `OrganizationNode` 是稳定组织身份（id = engineering/role = department）
- DSH Agent/Session 是运行实例；两者分离，经 `AgentBinding` 绑定，可重启后重新绑定

## 数据模型

```
Organization → OrganizationNode(tree) → Role → AgentBinding → DSH Agent/Session
```

- `OrganizationNode` 角色：`root` / `main`（内阁）/ `department`（部门）/ `specialist`（专业）
- `AgentBinding`：`{ organizationNodeId, runtimeAgentId/sessionId, status, createdAt, updatedAt }`
- `Role`：一组权限模板（支持 `inherits` 继承；deny 优先于 allow）
- `Delegation`：Agent OS 判权（`hasPermission(delegate)`），DSH 负责实际 spawn 子 Agent
- `Authority ≠ Permission ≠ Capability`：组织层级不自动等于全部权限

## 目录

| 文件 | 说明 |
|---|---|
| `src/model.ts` | 核心类型：Organization/OrganizationNode/Role/AgentBinding/Delegation/Authority/Audit |
| `src/store.ts` | 状态存储（内存 + 可选 JSON 落盘） |
| `src/service.ts` | 治理服务：初始化/节点/角色/绑定/委派/授权/审计 |
| `src/index.ts` | cordis 插件入口（挂 `ctx.agentOs`，自动初始化默认 Organization，unload 清理） |
| `src/dsh-adapter.ts` | DSH Runtime Adapter 接口（createAgent/resume/enter/isOwnedBy/dispose/delegationDepth） |
| `src/mock-dsh-adapter.ts` | Mock DSH Runtime（仅测试用，非真实 DSH） |
| `test/agent-os.test.ts` | 单元测试（Organization/Node/Role/Binding/Delegation/Authority/Audit，9 项） |
| `test/runtime-contract.test.ts` | Runtime Integration Contract Tests（mock，7 项） |
| `docs/real-runtime-test.md` | 真实 DSH Runtime 验证指南（preview） |

## Runtime 状态标记

```
Runtime integration implementation: READY
Real DSH runtime validation: PENDING LOCAL TEST
```

Agent OS 已实现 Runtime Activation 接口/适配/生命周期，并通过 mock 契约测试；
真实 DSH 验证需 ≥4GB 机器，操作手册见 `docs/real-runtime-test.md`。

## 使用

作为 cordis 插件加载：

```yaml
# cordis.yml / profile 补丁
- name: '@tts-dsh/agent-os'
  config:
    autoInit: true
    initActor: 'system'
    # statePath 缺省 → ~/.dsh/agent-os/state.json
```

加载后自动：

1. 创建默认 `Organization`（root + main 两个节点）
2. 把 `ctx.agentOs` 服务挂到上下文
3. 可通过 `ctx.agentOs` 创建 Department / Specialist、定义 Role、绑定 DSH Agent、授权/委派、读审计

## 开发

```bash
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm build       # tsc
pnpm test        # node --import tsx --test
```

## 边界说明（第一阶段范围）

本阶段实现：Organization / OrganizationNode / Role / AgentBinding / Delegation 基础 / Authority-Permission 接口 / 默认组织自动初始化 / DSH Runtime Binding。

暂未实现（非第一阶段目标）：Channel Framework、Feishu/Browser 适配、多 Workspace、复杂 UI、大规模动态调度、自我进化、自动组织结构修改、复杂审批工作流。
