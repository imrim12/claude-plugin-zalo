import { describe, it, expect, afterEach } from 'bun:test'
import { inboundDecide } from '../src/core/render-detect.ts'

// setup.ts sets ZALO_NO_DAEMON_SPAWN=1 for the whole run, so the no-override path takes the
// "auto-detect skipped" branch — the suite never shells out to probe the process tree.
describe('inboundDecide — responder election', () => {
  const saved = process.env.ZALO_INBOUND
  afterEach(() => {
    if (saved === undefined) delete process.env.ZALO_INBOUND
    else process.env.ZALO_INBOUND = saved
  })

  it('explicit ZALO_INBOUND=1 forces inbound on', () => {
    process.env.ZALO_INBOUND = '1'
    expect(inboundDecide().on).toBe(true)
  })

  it('explicit ZALO_INBOUND=0 forces inbound off', () => {
    process.env.ZALO_INBOUND = '0'
    expect(inboundDecide().on).toBe(false)
  })

  it('explicit ZALO_INBOUND=false forces inbound off', () => {
    process.env.ZALO_INBOUND = 'false'
    expect(inboundDecide().on).toBe(false)
  })

  it('any other truthy value forces inbound on', () => {
    process.env.ZALO_INBOUND = 'yes'
    expect(inboundDecide().on).toBe(true)
  })

  it('unset → no probe under ZALO_NO_DAEMON_SPAWN, stays off', () => {
    delete process.env.ZALO_INBOUND
    const d = inboundDecide()
    expect(d.on).toBe(false)
    expect(d.reason).toContain('ZALO_NO_DAEMON_SPAWN')
  })
})
