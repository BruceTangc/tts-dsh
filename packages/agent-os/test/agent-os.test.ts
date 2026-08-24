/**
 * Agent OS 服务单元测试（不依赖 DSH 运行时，纯逻辑测试）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { AgentOsStore } from '../src/store.js'
import { AgentOsService } from '../src/service.js'
import type { OrganizationNodeId, RoleId } from '../src/model.js'

function makeService() {
  const store = new AgentOsStore() // 内存态，不落盘
  let seq = 0
  const service = new AgentOsService({
    store,
    idGen: () => `id${++seq}`,
    now: () => `2026-08-24T00:00:00.000Z`,
  })
  return { store, service }
}

test('自动初始化默认 Organization => Root + Main', () => {
  const { service } = makeService()
  assert.equal(service.isInitialized, false)
  const org = service.initializeDefault()
  assert.equal(service.isInitialized, true)
  const root = service.rootNode()
  assert.ok(root)
  assert.equal(root!.role, 'root')
  const nodes = service.listNodes()
  assert.equal(nodes.length, 2) // root + main
  const main = nodes.find((n) => n.role === 'main')
  assert.ok(main)
  assert.equal(org.mainNodeId, main!.id)
})

test('initializeDefault 幂等', () => {
  const { service } = makeService()
  const a = service.initializeDefault()
  const b = service.initializeDefault()
  assert.equal(a.mainNodeId, b.mainNodeId)
  assert.equal(service.listNodes().length, 2)
})

test('创建 Department + Specialist 层级', () => {
  const { service } = makeService()
  service.initializeDefault()
  const root = service.rootNode()!
  const main = service.listNodes().find((n) => n.role === 'main')!

  // root（治理方）授予 main 建部门权限
  service.grantPermission(root.id, main.id, 'create-node')

  const eng = service.createNode('system', {
    parentId: main.id,
    role: 'department',
    name: 'Engineering',
  })
  assert.equal(eng.role, 'department')
  const coding = service.createNode('system', {
    parentId: eng.id,
    role: 'specialist',
    name: 'Coding',
  })
  assert.equal(coding.role, 'specialist')

  // 树结构验证
  const mainAfter = service.getNode(main.id)!
  assert.ok(mainAfter.children.includes(eng.id))
  const engAfter = service.getNode(eng.id)!
  assert.ok(engAfter.children.includes(coding.id))
  assert.equal(engAfter.parentId, main.id)

  // 子树：main 应该包含 main/eng/coding
  const sub = service.subtree(main.id)
  assert.equal(sub.length, 3)
})

// 组织节点做治理时可用（root 天然有权；main 需被授予 grant 权限）
test('node 作为治理方 grant 需先被 root 授权', () => {
  const { service } = makeService()
  service.initializeDefault()
  const root = service.rootNode()!
  const main = service.listNodes().find((n) => n.role === 'main')!
  // main 没有 grant 权限，作为治理方会被拒
  assert.throws(() => service.grantPermission(main.id, main.id, 'delegate'))
  // root 授予 main grant 权限
  service.grantPermission(root.id, main.id, 'grant')
  service.grantPermission(main.id, main.id, 'delegate')
  assert.equal(service.hasPermission(main.id, 'delegate'), true)
})

test('Runtime Binding: 组织身份与 DSH Agent 分离', () => {
  const { service } = makeService()
  service.initializeDefault()
  const root = service.rootNode()!
  const main = service.listNodes().find((n) => n.role === 'main')!
  assert.equal(main.binding, null)

  // root 授予 main bind 权限，再绑定到一个 DSH session
  service.grantPermission(root.id, main.id, 'bind')
  const b1 = service.bindNode(main.id, main.id, 'session-aaa')
  assert.equal(b1.status, 'active')
  assert.equal(b1.organizationNodeId, main.id)
  assert.equal(b1.runtimeAgentId, 'session-aaa')
  assert.equal(service.getNode(main.id)!.binding!.runtimeAgentId, 'session-aaa')

  // 重启后重新绑定到新 session，组织身份不消失
  const b2 = service.bindNode(main.id, main.id, 'session-bbb')
  assert.equal(b2.runtimeAgentId, 'session-bbb')
  const node = service.getNode(main.id)!
  assert.equal(node.id, main.id) // 组织身份保持
  assert.equal(node.binding!.runtimeAgentId, 'session-bbb')
})

test('Role: 权限模板 + 继承', () => {
  const { service } = makeService()
  service.initializeDefault()
  const dept = service.listNodes().find((n) => n.role === 'main')!
  const base = service.createRole({
    name: 'base',
    permissions: [{ permission: 'tool:fs.read', effect: 'allow' }],
  })
  const citizen = service.createRole({
    name: 'citizen',
    inherits: [base.id],
    permissions: [{ permission: 'tool:fs.write', effect: 'allow' }],
  })
  // 给 dept 直接附加角色（通过 store 内部路径，模拟绑定角色）
  const node = service.getNode(dept.id)!
  service['store'].upsertNode({ ...node, roleIds: [citizen.id] })

  const perms = service.effectivePermissions(dept.id)
  assert.equal(perms.get('tool:fs.read')?.effect, 'allow') // 继承
  assert.equal(perms.get('tool:fs.write')?.effect, 'allow')
  assert.equal(service.hasPermission(dept.id, 'tool:fs.read'), true)
  assert.equal(service.hasPermission(dept.id, 'not-granted'), false)
})

test('Delegation: Agent OS 判权，DSH 负责运行', () => {
  const { service } = makeService()
  service.initializeDefault()
  const root = service.rootNode()!
  const main = service.listNodes().find((n) => n.role === 'main')!
  const eng = service.createNode('system', {
    parentId: main.id,
    role: 'department',
    name: 'Engineering',
  })

  // 无 delegate 权限 → 委派拒绝
  assert.throws(() =>
    service.delegate(main.id, main.id, eng.id, ['tool:fs.write']),
    /lacks delegate permission/,
  )

  // root 授予 main delegate 权限后委派成功
  service.grantPermission(root.id, main.id, 'delegate')
  const d = service.delegate(main.id, main.id, eng.id, ['tool:fs.write'], {
    parentRuntimeAgentId: 'session-parent',
    childRuntimeAgentId: 'session-child',
    depth: 1,
  })
  assert.equal(d.status, 'active')
  assert.equal(d.fromNodeId, main.id)
  assert.equal(d.toNodeId, eng.id)
  assert.ok(service.listDelegations().length === 1)

  // 撤销
  service.revokeDelegation(main.id, d.id)
  assert.equal(service.listDelegations()[0].status, 'revoked')
})

test('Authority: 组织层级不自动等于全部权限', () => {
  const { service } = makeService()
  service.initializeDefault()
  const main = service.listNodes().find((n) => n.role === 'main')!

  // main 是 root 的子节点，但默认没有 delegate/grant 权限
  assert.equal(service.hasPermission(main.id, 'delegate'), false)
  assert.equal(service.hasPermission(main.id, 'grant'), false)
  // root 天然有治理权
  const root = service.rootNode()!
  assert.equal(service.hasPermission(root.id, 'delegate'), true)

  // 必须通过 root 显式授予
  service.grantPermission(root.id, main.id, 'delegate')
  assert.equal(service.hasPermission(main.id, 'delegate'), true)
})

test('审计: 治理操作留痕', () => {
  const { service } = makeService()
  service.initializeDefault()
  const root = service.rootNode()!
  const arr = service.listAudit()
  // initializeDefault 已产生至少 1 条
  assert.ok(arr.length >= 1)
  // 创建节点产生审计
  const main = service.listNodes().find((n) => n.role === 'main')!
  service.grantPermission(root.id, main.id, 'create-node')
  service.createNode('system', { parentId: main.id, role: 'specialist', name: 'X' })
  const acts = service.listAudit().map((e) => e.action)
  assert.ok(acts.includes('node.create'))
  assert.ok(acts.includes('permission.grant'))
})
