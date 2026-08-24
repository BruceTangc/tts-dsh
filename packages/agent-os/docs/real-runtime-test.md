# Real DSH Runtime Test —— 真实运行验证指南

> 本文件说明如何在**真实 DSH + Cordis** 环境中验证 Agent OS Plugin 的 Runtime Activation。
> ⚠️ 当前状态：**Runtime integration implementation: READY** / **Real DSH runtime validation: PENDING LOCAL TEST**
>
> Agent OS 已在 mock 环境做了接口契约测试（`test/runtime-contract.test.ts`），
> 但**尚未**在真实 DSH Runtime 上跑过。本文是上真实环境时的操作手册。

---

## 1. 需要什么环境

- 一台能完整构建 DSH 的机器（**≥4GB 内存**；DSH 是 246 包 monorepo，1.6GB 机器 install 会 OOM）
- Node.js ≥ 20 / pnpm ≥ 9
- 已 clone：
  - `deepseek-ai/deepseek-harness`（DSH 本体）
  - `BruceTangc/tts-dsh`（本插件 `packages/agent-os`）

```bash
# DSH 本体
cd deepseek-harness && pnpm install
pnpm build:lib        # 产出各 package 的 dist

# Agent OS 插件
cd tts-dsh/packages/agent-os && pnpm install
pnpm build
```

---

## 2. 如何启动 DSH + Cordis

DSH 是一条 cordis 插件树，通过 profile/bundle 组合。启动 `dsh web`（或 `dsh --profile headless`）。

```bash
cd deepseek-harness
pnpm --filter @deepseek-ai/dsh-cli run ...   # 或直接 dsh web
# 实际命令以 DSH 官方 dev 指南为准
```

临时验证可参考 cordis 教程的轻量 loader：

```bash
cd <scratch-dir>
cat > cordis.yml <<'YML'
- name: '@tts-dsh/agent-os'
  config:
    autoInit: true
YML
node --import tsx <dsh>/vendor/cordis/bin.js
```

---

## 3. 如何加载 Agent OS Plugin

把 Agent OS 加进 DSH 的 profile 补丁（`cordis.patch.yml`）或对应 bundle：

```yaml
# 追加一条插件行
- name: '@tts-dsh/agent-os'
  config:
    statePath: ~/.dsh/agent-os/state.json   # 可选
    autoInit: true
```

加载成功后应看到日志：
```
[agent-os] initialized organization <orgId>, main=<mainNodeId>
```

DSH 侧需提供 `ctx.agents` / `ctx.sessions`（真实 DSH 默认就有），
Agent OS 通过 `DshRuntimeAdapter`（`src/dsh-adapter.ts`）调用它们。

---

## 4. 如何初始化 Main

```ts
import { AgentOsService } from '@tts-dsh/agent-os'
// 插件已自动初始化 Organization(root+main)；这里把 Main 激活为真实 DSH Agent：
const mainNode = agentOs.listNodes().find(n => n.role === 'main')!
const binding = await agentOs.activateNode('system', mainNode.id, {
  requestedId: undefined,            // 让 DSH 分配 session id
  prompt: 'I am the Main Agent',
})
// binding.runtimeAgentId === DSH agent/session id；ctx.agents.get(id) 应可拿到真实 handle
```

---

## 5. 如何创建 Department

```ts
const main = agentOs.listNodes().find(n => n.role === 'main')!
// Main 需要有 create-node + bind + delegate 权限（root 授予）
const eng = agentOs.createNode('system', {
  parentId: main.id,
  role: 'department',
  name: 'Engineering',
})
const engBinding = await agentOs.activateNode('system', eng.id, {
  parentRuntimeId: mainBinding.runtimeAgentId,   // owner = Main
})
```

断言（真实环境）：
- `ctx.agents.get(engBinding.runtimeAgentId)` 非空（DSH Registry 真实存在）
- DSH `isOwnedBy(engId, mainId) === true`（owner 正确）

---

## 6. 如何创建 Specialist

与 Department 相同流程，挂到 Department 之下、owner 为 Department：

```ts
const coding = agentOs.createNode('system', {
  parentId: eng.id,
  role: 'specialist',
  name: 'Coding',
})
const codingBinding = await agentOs.activateNode('system', coding.id, {
  parentRuntimeId: engBinding.runtimeAgentId,   // owner = Department
})
```

---

## 7. 如何执行真实任务

让 Main 委派一个简单任务沿链下传（如“计算 12 + 30 并返回”）：

```ts
// Main 委派给 Department
agentOs.delegate(main.id, main.id, eng.id, ['tool:task'])
// Department 委派给 Specialist
agentOs.delegate(eng.id, eng.id, coding.id, ['tool:task'])

// Specialist 真实执行（用 DSH Agent handle 下发任务）
const specAgent = ctx.agents.get(codingBinding.runtimeAgentId)!
await specAgent.followup(createUserMessage('计算 12 + 30，只返回结果'))
// 等 quiescence，读 assistant/message
await specAgent.whenIdle()
```

结果逐级返回：Specialist 输出 → Department → Main（用 DSH 的 session/消息机制传递，
Agent OS 侧用 `Audit` / `Delegation.status` 记录链路）。

---

## 8. 如何验证 owner relationship

```ts
// DSH Registry：createAgent(ownerCtx) / enter(agent, owner) / isOwnedBy
const agents = ctx.agents
assert(agents.get(codingId))
assert(agents.isOwnedBy(codingId, engId))   // 必须是 true
assert(agents.isOwnedBy(codingId, mainId))  // false（owner 是 Eng）
```

---

## 9. 如何验证 AgentBinding

每个组织节点上检查 `binding`：

```ts
const n = agentOs.getNode(coding.id)!
assert(n.binding.organizationNodeId === coding.id)   // 组织身份
assert(n.binding.runtimeAgentId === codingId)        // DSH runtime 实例
assert(n.binding.status === 'active')
```

重启后组织身份不丢：`resumeNode()` 会 attempt resume，失败则重新 `createAgent` 并更新 binding。

---

## 10. 如何验证 reload / recovery

```bash
# 1. 启动 → 建树 → 激活全部 → 落盘（自动）
# 2. 退出进程（Plugin unload → disposeAll 清理存活 handle → persist）
# 3. 重启 → Agent OS load → initializeDefault（幂等）
# 4. 调 resumeNode() / 遍历节点 bind
```

断言：
- 组织身份（node id / tree）reload 后不变
- 旧 runtime agent 若不存在 → 重新创建 → binding 更新为新的 runtimeAgentId
- 无重复 Agent、无孤儿 Agent、无 listener/registry 泄漏（`disposeAll` 兜底）

---

## 已完成的自动化验证（mock）

- `pnpm test` → 16 项全 PASS（含 7 项 `CONTRACT[RUNTIME]` / `CONTRACT[PERSIST]` 契约测试）
- `pnpm typecheck` / `pnpm build` → 通过
- 覆盖：激活/owner 关系/委派深度/dispose/持久化读回/旧 Runtime 失效重绑/disposeAll

> mock 测试只验证**接口契约**，不代表真实 DSH 已验证。上真实环境按本文执行后方可更新状态标记为 REAL VALIDATED。
