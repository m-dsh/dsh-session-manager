import { describe, expect, it } from 'vitest'
import {
  parseApplyRollbackRequest,
  parsePreviewRollbackRequest,
  parseRollbackConversationRequest,
} from '../src/core'

describe('checkpoint 协议解析', () => {
  it('执行回滚：只接受 planId', () => {
    expect(parseApplyRollbackRequest({ planId: 'plan-1' })).toEqual({ planId: 'plan-1' })
  })

  it('执行回滚：拒绝空 planId / 缺失 / 非字符串', () => {
    expect(parseApplyRollbackRequest({ planId: '' })).toBeUndefined()
    expect(parseApplyRollbackRequest({})).toBeUndefined()
    expect(parseApplyRollbackRequest({ planId: 42 })).toBeUndefined()
    expect(parseApplyRollbackRequest(null)).toBeUndefined()
  })

  it('回滚对话：只接受非负 seq', () => {
    expect(parseRollbackConversationRequest({ sessionId: 's', checkpointSeq: 0 })).toEqual({
      sessionId: 's',
      checkpointSeq: 0,
    })
    expect(parseRollbackConversationRequest({ sessionId: 's', checkpointSeq: -2 })).toBeUndefined()
  })

  it('回滚预演：请求解析与回滚对话一致', () => {
    expect(parsePreviewRollbackRequest({ sessionId: 's', checkpointSeq: 7 })).toEqual({
      sessionId: 's',
      checkpointSeq: 7,
    })
    expect(parsePreviewRollbackRequest({ sessionId: 's', checkpointSeq: '7' })).toBeUndefined()
  })

  it('回滚对话：拒绝缺字段请求', () => {
    expect(parseRollbackConversationRequest({ sessionId: 's' })).toBeUndefined()
    expect(parseRollbackConversationRequest(null)).toBeUndefined()
  })
})