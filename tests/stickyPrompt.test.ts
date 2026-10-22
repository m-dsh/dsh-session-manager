import { describe, expect, it } from 'vitest'
import { flattenPromptText, isRowSetReplaced, pickPinnedRow } from '../src/client/stickyPrompt'

describe('flattenPromptText', () => {
  it('折叠换行与连续空白', () => {
    expect(flattenPromptText('第一行\n\n  第二行 \t 制表')).toBe('第一行 第二行 制表')
  })

  it('首尾空白修剪', () => {
    expect(flattenPromptText('  hello  ')).toBe('hello')
  })
})

describe('pickPinnedRow', () => {
  // 行高 100:bottom = top + 100(吸附条件是行底越过视口顶)
  const rows = [
    { key: 'a', top: 100, bottom: 200 },
    { key: 'b', top: 300, bottom: 400 },
    { key: 'c', top: 500, bottom: 600 },
  ]

  it('视口未滚过任何行时不 pin（行顶已过但行底仍在视口内也不 pin）', () => {
    expect(pickPinnedRow(rows, 0)).toBeUndefined()
    expect(pickPinnedRow(rows, 50)).toBeUndefined()
    // a 的行顶(100)已越过 scrollerTop=150,但行底(200)仍在其下 → 主体
    // 还可见,不吸附(长消息不被吸附条遮挡的关键场景)
    expect(pickPinnedRow(rows, 150)).toBeUndefined()
  })

  it('整行完全滚出视口后 pin 最近一条', () => {
    expect(pickPinnedRow(rows, 200)).toBe('a')
    expect(pickPinnedRow(rows, 401)).toBe('b')
    // 恰好跨过 PIN 阈值（scrollerTop + 0.5,按行底判定）
    expect(pickPinnedRow(rows, 399.4)).toBe('a')
    expect(pickPinnedRow(rows, 399.6)).toBe('b')
  })

  it('当前 pinned 行在释放带内保持粘滞，避免边缘抖动', () => {
    // 滚已越过全部行：bar 显示最近越过的一条（滞回不跨越更近的行）
    expect(pickPinnedRow(rows, 800, 'b')).toBe('c')
    // b 的行底刚回到释放带内（bottom <= scrollerTop + RELEASE）→ 继续显示 b
    expect(pickPinnedRow(rows, 393, 'b')).toBe('b')
    // b 完全离开释放带（行底明显回到视口内）→ 不再是 pinned 候选，取 a
    expect(pickPinnedRow(rows, 300, 'b')).toBe('a')
  })

  it('pinned 行被删除时回退到最近已越过行', () => {
    expect(pickPinnedRow(rows, 400, 'missing')).toBe('b')
  })

  it('零高度隐藏行（rewind 后 display:none，rect 全 0）不参与吸附', () => {
    // 隐藏行 bottom=0 会被误判为“已滚出视口”，须剔除；可见行主体在视口内不 pin
    const withGhost = [
      { key: 'ghost', top: 0, bottom: 0 },
      { key: 'real', top: 100, bottom: 200 },
    ]
    expect(pickPinnedRow(withGhost, 76)).toBeUndefined()
    // 可见行真正滚出后正常 pin，且滞回里的旧幽灵 key 被无视
    expect(pickPinnedRow(withGhost, 250)).toBe('real')
    expect(pickPinnedRow(withGhost, 250, 'ghost')).toBe('real')
  })

  it('空列表返回 undefined', () => {
    expect(pickPinnedRow([], 500)).toBeUndefined()
  })
})

describe('isRowSetReplaced（会话切换检测）', () => {
  it('整组 key 全部替换 → true', () => {
    expect(isRowSetReplaced(new Set(['a', 'b']), new Set(['x', 'y']))).toBe(true)
  })

  it('有交集（loadOlder 追加/删除单行）→ false', () => {
    expect(isRowSetReplaced(new Set(['a', 'b']), new Set(['b', 'c', 'd']))).toBe(false)
    expect(isRowSetReplaced(new Set(['a', 'b']), new Set(['a']))).toBe(false)
  })

  it('空集合不触发（首次安装/卸载后）', () => {
    expect(isRowSetReplaced(new Set(), new Set(['x']))).toBe(false)
    expect(isRowSetReplaced(new Set(['a']), new Set())).toBe(false)
  })
})
