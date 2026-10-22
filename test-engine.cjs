const assert = require('node:assert/strict');
const { ImageAnalysis, Reconstruction } = require('./engine.js');
function source(w, h, fn) { const p = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) p.set([...fn(x, y), 255], (y * w + x) * 4); return new ImageAnalysis(w, h, p); }
function verify(run) {
  let last = Infinity;
  for (let step = 0; step < run.curve.length; step++) {
    const metric = run.seek(step), a = run.analysis, coverage = new Uint8Array(a.area);
    assert(metric.count <= run.options.budget, 'budget exceeded');
    assert(metric.mse <= last + 1e-9, 'MSE must not increase'); last = metric.mse;
    assert.equal(run.leaves.size, metric.count);
    for (const n of run.leaves.values()) for (let y = n.y; y < n.y + n.h; y++) for (let x = n.x; x < n.x + n.w; x++) coverage[y * a.width + x]++;
    assert(coverage.every(n => n === 1), 'all pixels covered exactly once');
    const pixels = run.raster(); let error = 0; for (let k = 0; k < pixels.length; k++) if (k % 4 !== 3) error += (pixels[k] - a.rgba[k]) ** 2;
    assert(Math.abs(metric.mse - error / (3 * a.area)) < 1e-9, 'reported MSE equals raster error');
  }
  const raster = run.raster(); run.seek(0); assert.equal(run.leaves.size, 1); run.seek(run.events.length); assert.deepEqual(run.raster(), raster, 'seeking is reversible');
}
let checks = 0;
for (const [w, h] of [[8, 8], [9, 7], [1, 17], [17, 1], [1, 1]]) {
  const a = source(w, h, (x, y) => [(x * 73 + y * 31) % 256, (x * 29 + y * 97) % 256, (x * 173 + y * 13) % 256]);
  for (const mode of ['hybrid', 'error', 'edge', 'entropy', 'uniform', 'random']) {
    for (const budget of [1, 2, 4, 10, 32, w * h]) { const run = new Reconstruction(a, { mode, budget, minSize: 1 }); verify(run); if (budget === w * h) { assert.equal(run.curve.at(-1).mse, 0); assert.deepEqual(run.raster(), a.rgba); } checks++; }
  }
}
const uniform = source(16, 16, () => [127, 127, 127]);
assert.equal(new Reconstruction(uniform, { threshold: 1 }).events.length, 0);
assert.equal(uniform.region(0, 0, 16, 16).entropy, 0);
assert(uniform.gradient.every(x => x === 0));
const split = source(16, 16, x => x < 8 ? [0, 0, 0] : [255, 255, 255]);
assert.equal(split.region(0, 0, 16, 16).entropy, 1);
const a = new Reconstruction(split, { mode: 'random', budget: 64, minSize: 1 });
const b = new Reconstruction(split, { mode: 'random', budget: 64, minSize: 1 });
assert.deepEqual(a.events.map(e => e.parent.id), b.events.map(e => e.parent.id));
assert.deepEqual(new Reconstruction(split, { weights: [0, 0, 0] }).weights, [1 / 3, 1 / 3, 1 / 3]);
const limited = new Reconstruction(split, { budget: 1000, minSize: 4 }); limited.seek(limited.events.length);
assert([...limited.leaves.values()].every(n => n.w >= 4 && n.h >= 4)); assert.equal(limited.leaves.size, 16);
const transparent = new ImageAnalysis(1, 1, new Uint8ClampedArray([0, 0, 0, 0])); assert.deepEqual([...transparent.rgba], [255, 255, 255, 255]);
const t = performance.now(); const large = source(256, 256, (x, y) => [(x * 73 + y * 31) % 256, (x * 29 + y * 97) % 256, (x * 173 + y * 13) % 256]);
const full = new Reconstruction(large, { budget: 16384, minSize: 1 });
console.log(`PASS: ${checks} reconstruction cases; pixel-exact metrics, coverage, monotonic error, budget, replay, thin/odd images, entropy, threshold, scale, seed and alpha checks.`);
console.log(`256×256 analysis + 16,384-element run: ${(performance.now() - t).toFixed(0)} ms; ${full.events.length} splits.`);
