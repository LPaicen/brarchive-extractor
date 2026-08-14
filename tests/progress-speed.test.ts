import assert from 'node:assert/strict'
import test from 'node:test'
import { formatProgressSpeed, ProgressSpeedTracker } from '../src/progress-speed.js'

test('ProgressSpeedTracker reports a sliding-window item rate', () => {
  const tracker = new ProgressSpeedTracker(5_000)
  tracker.reset(0, 0)

  assert.equal(tracker.update(5, 1_000), 5)
  assert.equal(tracker.update(15, 3_000), 5)
  assert.equal(tracker.update(20, 7_000), 2.5)
})

test('ProgressSpeedTracker resets when progress moves backwards', () => {
  const tracker = new ProgressSpeedTracker()
  tracker.reset(10, 0)
  assert.equal(tracker.update(20, 1_000), 10)
  assert.equal(tracker.update(0, 2_000), 0)
  assert.equal(tracker.update(4, 3_000), 4)
})

test('formatProgressSpeed produces a stable-width readable value', () => {
  assert.equal(formatProgressSpeed(0), '  0.0 items/s')
  assert.equal(formatProgressSpeed(12.34), ' 12.3 items/s')
  assert.equal(formatProgressSpeed(999), '  999 items/s')
  assert.equal(formatProgressSpeed(1_250), ' 1.3k items/s')
  assert.equal(formatProgressSpeed(Number.NaN), '  0.0 items/s')
})
