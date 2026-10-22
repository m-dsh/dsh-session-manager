async () => {
  await new Promise(r => setTimeout(r, 2000))
  const scroller = document.querySelector('[data-conversation-scroll]')
  if (!(scroller instanceof HTMLElement)) return 'no scroller'
  // 监测吸附条在快速滚动全程中的最大高度(闪烁=瞬时高度远超常态)
  let maxHeight = 0
  let samples = 0
  let sampling = true
  const sample = () => {
    const bar = document.querySelector('.dshSessionManagerStickyPrompt')
    if (bar !== null && !bar.closest('[hidden]')) {
      const h = bar.getBoundingClientRect().height
      if (h > maxHeight) maxHeight = h
      samples += 1
    }
    if (sampling) requestAnimationFrame(sample)
  }
  requestAnimationFrame(sample)
  // 快速向上滚动(模拟用户场景)
  scroller.scrollTo({ top: 0, behavior: 'auto' })
  await new Promise(r => setTimeout(r, 300))
  scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'auto' })
  await new Promise(r => setTimeout(r, 300))
  for (let i = 0; i < 8; i++) {
    scroller.scrollBy({ top: -Math.round(scroller.clientHeight * 0.9), behavior: 'auto' })
    await new Promise(r => setTimeout(r, 80))
  }
  await new Promise(r => setTimeout(r, 500))
  sampling = false
  const bar = document.querySelector('.dshSessionManagerStickyPrompt')
  const cs = bar !== null ? getComputedStyle(bar.querySelector('.dshSessionManagerStickyText')) : null
  const visible = bar !== null && !bar.closest('[hidden]')
  return {
    maxBarHeightDuringFastScroll: Math.round(maxHeight),
    sampledFrames: samples,
    barVisibleAfterScroll: visible,
    barHeightNow: bar !== null ? Math.round(bar.getBoundingClientRect().height) : null,
    lineClamp: cs?.webkitLineClamp ?? cs?.lineClamp ?? null,
    overflow: cs?.overflow ?? null,
  }
}