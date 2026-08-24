/**
 * Agent OS × DSH Runtime —— Integration Contract Tests
 *
 * ⚠️ 本测试使用 MockDshRuntimeAdapter（测试替身），验证的是【接口契约】，
 *    不是真实 DSH Runtime。真实 DSH 验证见 docs/real-runtime-test.md。
 *    状态标记：Real DSH runtime validation = PENDING LOCAL TEST
 *
 * 覆盖：Runtime Activation 的完整契约（激活/委派归属/销毁/持久化读回/重绑）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AgentOsStore } from '../src/store.js'
import { AgentOsService } from '../src/service.js'
import { MockDshRuntimeAdapter } from '../src/mock-dsh-adapter.js'

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'aos-contract-'))
}

function makeService(filePath?: string, depth = 1) {
  const store = new AgentOsStore(filePath)
  const runtime = new MockDshRuntimeAdapter({ depth })
  let seq = 0
  const service = new AgentOsService({
    store,
    runtime,
    idGen: () => `id${++seq}`,
    now: () => '2026-08-24T00:00:00.000Z',
  })
  return { store, runtime, service }
}

test('CONTRACT[RUNTIME] Main 激活 → 真实 handle + AgentBinding', async () => {
  const { runtime, service } = makeService()
  service.initializeDefault()
  const main = service.listNodes().find((n) => n.role === 'main')!

  // root 授予 main bind 权限
  const root = service.rootNode()!
  service.grantPermission(root.id, main.id, 'bind')

  const binding = await service.activateNode(main.id, main.id, {
    requestedId: 'main-session-1',
    prompt: 'i am main',
  })
  assert.ok(binding)
  assert.equal(binding.runtimeAgentId, 'main-session-1')
  assert.equal(binding.status, 'active')

  // mock registry 里真实存在该 agent
  assert.deepEqual(runtime.listAlive(), ['main-session-1'])
  // OrganizationNode 现在有真实 runtime handle
  const node = service.getNode(main.id)!
  assert.equal(node.binding!.runtimeAgentId, 'main-session-1')
})

test('CONTRACT[RUNTIME] Parent→Child owner 关系正确（enter/isOwnedBy）', async () => {
  const { runtime, service } = makeService()
  service.initializeDefault()
  const root = service.rootNode()!
  const main = service.listNodes().find((n) => n.role === 'main')!
  service.grantPermission(root.id, main.id, 'bind')
  service.grantPermission(root.id, main.id, 'create-node')

  const mainBinding = await service.activateNode(main.id, main.id, { requestedId: 'main-s' })
  const dept = service.createNode('system', { parentId: main.id, role: 'department', name: 'Eng' })
  const deptBinding = await service.activateNode(main.id, dept.id, {
    parentRuntimeId: mainBinding!.runtimeAgentId,
    requestedId: 'dept-s',
  })
  assert.ok(deptBinding)

  // mock: dept agent 的 owner 是 main agent
  assert.equal(runtime.ownerOf('dept-s'), 'main-s')
  assert.equal(runtime.isOwnedBy('dept-s', 'main-s'), true)
  assert.equal(runtime.isOwnedBy('dept-s', 'someone-else'), false)
})

test('CONTRACT[RUNTIME] Specialist 三重链 ownership + 委派深度', async () => {
  const { runtime, service } = makeService(undefined, 3)
  service.initializeDefault()
  const root = service.rootNode()!
  const main = service.listNodes().find((n) => n.role === 'main')!
  service.grantPermission(root.id, main.id, 'bind')
  service.grantPermission(root.id, main.id, 'create-node')
  service.grantPermission(root.id, main.id, 'delegate')

  // Main → Dept → Specialist
  const mainB = await service.activateNode(main.id, main.id, { requestedId: 'main-s' })
  const dept = service.createNode('system', { parentId: main.id, role: 'department', name: 'Eng' })
  const deptB = await service.activateNode(main.id, dept.id, { parentRuntimeId: mainB!.runtimeAgentId, requestedId: 'dept-s' })
  const spec = service.createNode('system', { parentId: dept.id, role: 'specialist', name: 'Coding' })
  const specB = await service.activateNode(main.id, spec.id, { parentRuntimeId: deptB!.runtimeAgentId, requestedId: 'spec-s' })

  assert.ok(specB)
  // ownership 链
  assert.equal(runtime.isOwnedBy('spec-s', 'dept-s'), true)
  assert.equal(runtime.isOwnedBy('dept-s', 'main-s'), true)
  assert.equal(runtime.delegationDepth, 3)

  // 委派记录：Dept 需自己有 delegate 权限（组织层级不自动等于全部权限）
  service.grantPermission(root.id, dept.id, 'delegate')
  const d1 = service.delegate(main.id, main.id, dept.id, ['tool:task'], { parentRuntimeAgentId: 'main-s', childRuntimeAgentId: 'dept-s', depth: 1 })
  // Dept 作为委派方委派给 Specialist（actor 为 dept，from 为 dept）
  const d2 = service.delegate(dept.id, dept.id, spec.id, ['tool:task'], { parentRuntimeAgentId: 'dept-s', childRuntimeAgentId: 'spec-s', depth: 2 })
  assert.equal(d1.status, 'active')
  assert.equal(d2.status, 'active')
  assert.equal(service.listDelegations().length, 2)
})

test('CONTRACT[RUNTIME] dispose 销毁 Agent + binding 置 stale，组织身份保留', async () => {
  const { runtime, service } = makeService()
  service.initializeDefault()
  const root = service.rootNode()!
  const main = service.listNodes().find((n) => n.role === 'main')!
  service.grantPermission(root.id, main.id, 'bind')

  const binding = await service.activateNode(main.id, main.id, { requestedId: 'main-s' })
  assert.ok(binding)
  assert.deepEqual(runtime.listAlive(), ['main-s'])

  const ok = await service.disposeNode(main.id, main.id)
  assert.equal(ok, true)
  assert.deepEqual(runtime.listAlive(), []) // mock registry 无残留
  const node = service.getNode(main.id)!
  assert.equal(node.id, main.id) // 组织身份保留
  assert.equal(node.binding!.status, 'stale')
})

test('CONTRACT[PERSIST] 组织树 + binding 落盘读回（reload 恢复）', async () => {
  const dir = tmpDir()
  const file = join(dir, 'state.json')
  try {
    // 第一次运行：建树 + 激活 + 落盘
    let { runtime, service } = makeService(file)
    service.initializeDefault()
    const root = service.rootNode()!
    const main = service.listNodes().find((n) => n.role === 'main')!
    service.grantPermission(root.id, main.id, 'bind')
    service.grantPermission(root.id, main.id, 'create-node')

    const mainB = await service.activateNode(main.id, main.id, { requestedId: 'main-s' })
    const dept = service.createNode('system', { parentId: main.id, role: 'department', name: 'Eng' })
    await service.activateNode(main.id, dept.id, { parentRuntimeId: mainB!.runtimeAgentId, requestedId: 'dept-s' })
    service.store.persist()

    // 模拟进程停止
    runtime = undefined as unknown as MockDshRuntimeAdapter

    // 重新加载
    const store2 = new AgentOsStore(file)
    const runtime2 = new MockDshRuntimeAdapter()
    // 用新 store + 新 runtime 重建并用持久化的 tree 恢复
    const service2 = new AgentOsService({ store: store2, runtime: runtime2 })
    service2.initializeDefault() // org 已存在，幂等
    const restoredMain = service2.rootNode()!
    assert.equal(restoredMain.role, 'root')
    const restoredNodes = service2.listNodes()
    assert.equal(restoredNodes.length, 3) // root + main + dept
    const deptNode = restoredNodes.find((n) => n.name === 'Eng')
    assert.ok(deptNode)
    assert.equal(deptNode!.role, 'department')

    // binding 恢复：dept 记录还在（旧 runtime id 可能失效，但组织身份不丢）
    assert.equal(deptNode!.binding!.runtimeAgentId, 'dept-s')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CONTRACT[PERSIST] 旧 Runtime 失效 → resumeNode 重新建立绑定', async () => {
  const dir = tmpDir()
  const file = join(dir, 'state.json')
  try {
    let { runtime, service } = makeService(file)
    service.initializeDefault()
    const root = service.rootNode()!
    const main = service.listNodes().find((n) => n.role === 'main')!
    service.grantPermission(root.id, main.id, 'bind')
    const b1 = await service.activateNode(main.id, main.id, { requestedId: 'main-s' })
    assert.ok(b1)
    service.store.persist()

    // 模拟：旧 runtime 消失（新 mock runtime 无此 agent）
    // 重新加载同一持久化文件，resume 时应检测旧 runtime 失效并重新创建
    const store2 = new AgentOsStore(file)
    const runtime2 = new MockDshRuntimeAdapter()
    // 预置：让 resume 找不到 → resumeNode 走 activateNode 重绑
    // 但 activateNode 需要 bind 权限；重载后 root 天然有权，main 需重新授权。
    const service2 = new AgentOsService({ store: store2, runtime: runtime2 })
    service2.initializeDefault()
    // root 天然有 bind 权，直接用 root 作 resolver（真实环境 root/main 是治理方）
    const b2 = await service2.resumeNode('system', main.id)
    assert.ok(b2)
    assert.equal(b2.status, 'active')
    assert.ok(runtime2.listAlive().includes(b2.runtimeAgentId))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CONTRACT[LIFECYCLE] disposeAll 清理所有存活 Agent（防孤儿）', async () => {
  const { runtime, service } = makeService()
  service.initializeDefault()
  const root = service.rootNode()!
  const main = service.listNodes().find((n) => n.role === 'main')!
  service.grantPermission(root.id, main.id, 'bind')
  service.grantPermission(root.id, main.id, 'create-node')

  const mainB = await service.activateNode(main.id, main.id, { requestedId: 'main-s' })
  const dept = service.createNode('system', { parentId: main.id, role: 'department', name: 'Eng' })
  await service.activateNode(main.id, dept.id, { parentRuntimeId: mainB!.runtimeAgentId, requestedId: 'dept-s' })
  assert.equal(runtime.listAlive().length, 2)

  const n = await service.disposeAll()
  assert.equal(n, 2)
  assert.deepEqual(runtime.listAlive(), [])
})
