import test from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED_CFM, percentToCFM, cfmToPercent, nearestAllowedCFM } from '../dist/speedMapping.js';

const NON_ZERO_CFM = ALLOWED_CFM.filter(v => v > 0);

test('0% and below map to 0 CFM (off)', () => {
  assert.equal(percentToCFM(0), 0);
  assert.equal(percentToCFM(-5), 0);
});

test('each 10% step maps to the matching speed table entry', () => {
  NON_ZERO_CFM.forEach((cfm, index) => {
    assert.equal(percentToCFM((index + 1) * 10), cfm);
  });
});

test('percent to CFM round-trips exactly on every 10% detent', () => {
  for (let percent = 10; percent <= 100; percent += 10) {
    assert.equal(cfmToPercent(percentToCFM(percent)), percent);
  }
});

test('every running speed reports a non-zero percent', () => {
  for (const cfm of NON_ZERO_CFM) {
    assert.ok(cfmToPercent(cfm) > 0, `${cfm} CFM must not report 0%`);
  }
});

test('regression: lowest speed (50 CFM) reports 10%, not 0%', () => {
  assert.equal(cfmToPercent(50), 10);
});

test('intermediate percents round to a supported speed', () => {
  assert.equal(percentToCFM(1), 50);
  assert.equal(percentToCFM(45), 90);
  assert.equal(percentToCFM(100), 150);
  assert.equal(percentToCFM(105), 150);
});

test('off-table CFM values snap to the nearest supported speed', () => {
  assert.equal(nearestAllowedCFM(0), 0);
  assert.equal(nearestAllowedCFM(30), 50);
  assert.equal(nearestAllowedCFM(72), 70);
  assert.equal(nearestAllowedCFM(200), 150);
  assert.equal(cfmToPercent(30), 10);
  assert.equal(cfmToPercent(200), 100);
});

test('cfmToPercent output always lands on a 10% detent within 0-100', () => {
  for (let cfm = 0; cfm <= 250; cfm++) {
    const percent = cfmToPercent(cfm);
    assert.ok(percent >= 0 && percent <= 100);
    assert.equal(percent % 10, 0);
  }
});
