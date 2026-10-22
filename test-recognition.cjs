const assert = require('node:assert/strict');
const { checkpoints, suggestedVerdict, summarize, csv } = require('./recognition.js');
const curve = [1, 4, 7, 16, 31, 64, 127, 256, 511, 1024].map((count, step) => ({ count, quality: 60 + step * 4 }));
assert.deepEqual(checkpoints(curve).map(p => p.count), [1, 4, 16, 64, 256, 1024]);
assert.deepEqual(checkpoints(curve.slice(0, 5)).map(p => p.count), [1, 4, 16, 31]);
assert.equal(suggestedVerdict('猫', false, '猫', 'cat'), 'correct');
assert.equal(suggestedVerdict(' CAT ', false, '猫', 'cat'), 'correct');
assert.equal(suggestedVerdict('虎斑猫', false, '猫', 'cat'), 'review');
assert.equal(suggestedVerdict('无法判断', true, '猫', 'cat'), 'incorrect');
const rows = [
  { baseline: true, verdict: 'correct' },
  ...[1, 4, 16, 64, 256].map((count, i) => ({ baseline: false, mode: 'hybrid', count, verdict: ['incorrect', 'correct', 'incorrect', 'correct', 'correct'][i] })),
  ...[1, 4].map(count => ({ baseline: false, mode: 'edge', count, verdict: 'review' })),
];
const summary = summarize(rows);
assert.equal(summary.strategies[0].first.count, 4);
assert.equal(summary.strategies[0].sustained.count, 64);
assert.equal(summary.strategies[1].first, null);
assert.equal(summary.strategies[1].sustained, null);
const meta = { source: 'a,"b".png', truth: '猫', aliases: 'cat', model: 'gpt-5.6-luna', promptVersion: 'recognition-v1', options: { minSize: 2, threshold: 0, weights: [50, 30, 20], seed: 42 }, width: 256, height: 256 };
const output = csv([{ ...rows[1], label: 'cat', evidence: 'ear, eye', unknown: false, verdict: 'correct', sha256: 'abc', responseId: 'resp_1', modelId: 'gpt-5.6-luna', timestamp: '2026-10-08T00:00:00Z' }], meta);
assert(output.includes('"a,""b"".png"'));
assert(output.includes('"ear, eye"'));
assert(output.includes('"resp_1"'));
assert(output.includes('"recognition-v1"'));
console.log('PASS: recognition checkpoints, verdicts, sustained threshold and CSV escaping.');
