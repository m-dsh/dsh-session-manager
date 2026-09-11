import { describe, expect, it } from 'vitest'
import {
  assistantMessageId,
  collectBaselineAssistantIds,
  computeRetryContext,
  computeUserRefreshTargets,
  waitForNewAssistant,
} from '../src/client/index'

// ── 测试夹具：仿照 0.1.2 chat 视图的结构 ──

interface NodeOpts {
  key?: string
  turn?: number
  messageId?: string
  status?: string
  text?: string
  visible?: boolean
}

function userNode(opts: NodeOpts) {
  return {
    key: opts.key ?? 'u',
    kind: 'user',
    visibility: opts.visible === false ? 'hidden' : 'visible',
    location: opts.turn === undefined ? undefined : { turn: { turn: opts.turn } },
    data: { content: [{ type: 'text', text: opts.text ?? '' }] },
  }
}

function assistantNode(opts: NodeOpts) {
  const data: Record<string, unknown> = {}
  if (opts.status !== undefined) data.status = opts.status
  if (opts.messageId !== undefined) data.finalNode = { messageId: opts.messageId }
  return {
    key: opts.key ?? 'a',
    kind: 'assistant-step', // 0.1.2 的实际助手节点 kind
    location: opts.turn === undefined ? undefined : { turn: { turn: opts.turn } },
    data,
  }
}

function makeChat(nodes: unknown[], turnEnds?: Array<[number, number]>) {
  return {
    order: nodes.map((node) => (node as { key?: string }).key ?? ''),
    nodes: { values: () => nodes },
    legacy: turnEnds ? { turnEnds: new Map(turnEnds) } : undefined,
  }
}

function resolverFor(chat: unknown) {
  return () =>
    ({
      binding: () => ({
        snapshot: {
          getSnapshot: () => ({ views: { get: () => chat } }),
        },
      }),
    }) as never
}

// ── legacy 切片夹具：computeRetryContext 的数据源（0.1.2 会话快照无消息节点） ──

function legacyUser(opts: { seq: number; turn?: number; text: string }) {
  return { kind: 'user', seq: opts.seq, turn: opts.turn, content: [{ type: 'text', text: opts.text }] }
}

function legacyAssistant(opts: { seq: number; turn?: number; messageId: string }) {
  return {
    kind: 'assistant',
    seq: opts.seq,
    turn: opts.turn,
    messageId: opts.messageId,
    content: [{ type: 'text', text: '回答' }],
  }
}

function legacy(flat: unknown[], turnEnds?: Array<[number, number]>) {
  return { nodes: flat, turnEnds: turnEnds ? new Map(turnEnds) : undefined }
}

describe('重新生成 / 刷新核心', () => {
  it('assistantMessageId 优先取 finalNode.messageId', () => {
    expect(assistantMessageId(assistantNode({ messageId: 'm1', status: 'settled' }) as never)).toBe('m1')
    expect(assistantMessageId(assistantNode({ status: 'running' }) as never)).toBeUndefined()
  })

  it('computeRetryContext 按同回合定位用户消息（而非最近的前置 user）', () => {
    const chat = makeChat(
      [
        userNode({ key: 'u1', turn: 1, text: '第一问' }),
        assistantNode({ key: 'a1', turn: 1, messageId: 'm1', status: 'settled' }),
        userNode({ key: 'u2', turn: 2, text: '第二问' }),
        assistantNode({ key: 'a2', turn: 2, messageId: 'm2', status: 'settled' }),
      ],
      [
        [1, 10],
        [2, 20],
      ],
    )
    const ctx = computeRetryContext(chat as never, 'm2')
    expect(ctx?.content).toEqual([{ type: 'text', text: '第二问' }])
    expect(ctx?.previousTurnEnd).toBe(10)
    expect(ctx?.turn).toBe(2)
    expect(ctx?.assistantStatus).toBe('settled')
  })

  it('computeRetryContext 无 turn 信息时退回最近的前置 user', () => {
    const chat = makeChat([
      userNode({ key: 'u1', turn: 1, text: '第一问' }),
      assistantNode({ key: 'a1', turn: 1, messageId: 'm1', status: 'settled' }),
      userNode({ key: 'u2', turn: 2, text: '第二问' }),
      assistantNode({ key: 'a2', messageId: 'm2', status: 'settled' }),
    ])
    const ctx = computeRetryContext(chat as never, 'm2')
    expect(ctx?.content).toEqual([{ type: 'text', text: '第二问' }])
    expect(ctx?.previousTurnEnd).toBeUndefined()
  })

  it('computeRetryContext 对 order 缺失的最新节点仍能定位（排到末尾而非最前）', () => {
    const nodes = [
      userNode({ key: 'u1', turn: 1, text: '第一问' }),
      assistantNode({ key: 'a1', turn: 1, messageId: 'm1', status: 'settled' }),
      userNode({ key: 'u2', turn: 2, text: '第二问' }),
      assistantNode({ key: 'a2', turn: 2, messageId: 'm2', status: 'settled' }),
    ]
    const chat = makeChat(nodes, [
      [1, 10],
      [2, 20],
    ])
    ;(chat as { order: string[] }).order = ['u1', 'a1', 'u2'] // a2 缺失
    const ctx = computeRetryContext(chat as never, 'm2')
    expect(ctx?.content).toEqual([{ type: 'text', text: '第二问' }])
    expect(ctx?.turn).toBe(2)
  })

  it('computeRetryContext 找不到匹配 messageId 时返回 undefined', () => {
    const chat = makeChat([
      userNode({ key: 'u1', turn: 1, text: '第一问' }),
      assistantNode({ key: 'a1', turn: 1, messageId: 'm1', status: 'settled' }),
    ])
    expect(computeRetryContext(chat as never, '不存在')).toBeUndefined()
  })

  it('computeRetryContext 前置用户无内容时返回 undefined', () => {
    const chat = makeChat([
      { key: 'u1', kind: 'user', visibility: 'visible', data: { content: [] } },
      assistantNode({ key: 'a1', turn: 1, messageId: 'm1', status: 'settled' }),
    ])
    expect(computeRetryContext(chat as never, 'm1')).toBeUndefined()
  })

  it('computeUserRefreshTargets 计算内容、边界，并标记生成中的回合', () => {
    const chat = makeChat(
      [
        userNode({ key: 'u1', turn: 1, text: '第一问' }),
        assistantNode({ key: 'a1', turn: 1, messageId: 'm1', status: 'settled' }),
        userNode({ key: 'u2', turn: 2, text: '第二问' }),
        assistantNode({ key: 'a2', turn: 2, status: 'running' }),
      ],
      [
        [1, 10],
        [2, 20],
      ],
    )
    const targets = computeUserRefreshTargets(chat as never)
    expect(targets.get('u1')).toMatchObject({ turn: 1, previousTurnEnd: undefined, generating: false })
    expect(targets.get('u2')).toMatchObject({ turn: 2, previousTurnEnd: 10, generating: true })
    expect(targets.get('u2')?.content).toEqual([{ type: 'text', text: '第二问' }])
    expect(targets.get('u1')?.assistantKeys).toEqual(['a1'])
    expect(targets.get('u2')?.assistantKeys).toEqual(['a2'])
  })

  it('collectBaselineAssistantIds 只收集已有 assistant 的 messageId', () => {
    const chat = makeChat([
      assistantNode({ key: 'a1', messageId: 'm1', status: 'settled' }),
      assistantNode({ key: 'a2', messageId: 'm2', status: 'settled' }),
      userNode({ key: 'u1', turn: 1, text: 'hi' }),
    ])
    const ids = collectBaselineAssistantIds(resolverFor(chat), 'sess')
    expect([...ids].sort()).toEqual(['m1', 'm2'])
  })

  it('waitForNewAssistant：本次新增的 settled 才放行', async () => {
    const chat = makeChat([
      assistantNode({ key: 'a1', messageId: 'm1', status: 'settled' }),
      assistantNode({ key: 'a2', messageId: 'm2', status: 'settled' }),
    ])
    await expect(
      waitForNewAssistant(resolverFor(chat), 'sess', new Set(['m1']), undefined, 500),
    ).resolves.toBeUndefined()
  })

  it('waitForNewAssistant：历史 assistant 的 settled 不能顶包（超时兜底）', async () => {
    // 只有基线 a1（settled），没有任何新增 assistant → 绝不该被当成"新回复生成完成"。
    const chat = makeChat([assistantNode({ key: 'a1', messageId: 'm1', status: 'settled' })])
    await expect(
      waitForNewAssistant(resolverFor(chat), 'sess', new Set(['m1']), undefined, 250),
    ).rejects.toThrow('等待新回复超时')
  })

  it('waitForNewAssistant：新增 assistant 被中断视为失败', async () => {
    const chat = makeChat([
      assistantNode({ key: 'a1', messageId: 'm1', status: 'settled' }),
      assistantNode({ key: 'a2', messageId: 'm2', status: 'interrupted' }),
    ])
    await expect(
      waitForNewAssistant(resolverFor(chat), 'sess', new Set(['m1']), undefined, 500),
    ).rejects.toThrow('重新生成已被中断')
  })

  it('waitForNewAssistant：外部取消立即中止', async () => {
    const controller = new AbortController()
    controller.abort(new Error('用户取消'))
    await expect(
      waitForNewAssistant(resolverFor(makeChat([])), 'sess', new Set(['m1']), controller.signal, 500),
    ).rejects.toThrow('用户取消')
  })
})