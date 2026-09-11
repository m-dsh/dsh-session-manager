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
  const rows = [
    { key: 'a', top: 100 },
    { key: 'b', top: 300 },
    { key: 'c', top: 500 },
  ]

  it('视口未滚过任何行时不 pin', () => {
    expect(pickPinnedRow(rows, 0)).toBeUndefined()
    expect(pickPinnedRow(rows, 50)).toBeUndefined()
  })

  it('越过后 pin 最近一条', () => {
    expect(pickPinnedRow(rows, 150)).toBe('a')
    expect(pickPinnedRow(rows, 301)).toBe('b')
    // 恰好跨过 PIN 阈值（scrollerTop + 0.5）
    expect(pickPinnedRow(rows, 299.4)).toBe('a')
    expect(pickPinnedRow(rows, 299.6)).toBe('b')
  })

  it('当前 pinned 行在释放带内保持粘滞，避免边缘抖动', () => {
    // 滚已越过全部行：bar 显示最近越过的一条（滞回不跨越更近的行）
    expect(pickPinnedRow(rows, 800, 'b')).toBe('c')
    // b 刚回到视口内（top <= scrollerTop + RELEASE）→ 继续显示 b
    expect(pickPinnedRow(rows, 293, 'b')).toBe('b')
    // b 完全离开释放带且仍在视口 → 不再是 pinned 候选，取最近的已越过行 a
    expect(pickPinnedRow(rows, 100, 'b')).toBe('a')
  })

  it('pinned 行被删除时回退到最近已越过行', () => {
    expect(pickPinnedRow(rows, 400, 'missing')).toBe('b')
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
