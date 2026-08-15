import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { clampTimeout } from '../src/tools/validate.ts'

describe('clampTimeout', () => {
  it('falls back to the default when timeout is undefined', () => {
    assert.equal(clampTimeout(undefined), 120_000)
  })

  it('falls back to the default when timeout is not a positive finite number', () => {
    assert.equal(clampTimeout(0), 120_000)
    assert.equal(clampTimeout(-5), 120_000)
    assert.equal(clampTimeout(NaN), 120_000)
    assert.equal(clampTimeout(Infinity), 120_000)
  })

  it('caps a timeout above the ceiling so a model cannot pin the tool open', () => {
    assert.equal(clampTimeout(Number.MAX_SAFE_INTEGER), 600_000)
  })

  it('passes a valid in-range timeout through unchanged', () => {
    assert.equal(clampTimeout(30_000), 30_000)
    assert.equal(clampTimeout(600_000), 600_000)
  })
})