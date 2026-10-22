(function (root) {
  'use strict';
  const MAX_SQUARE = 255 * 255;
  class Heap {
    constructor() { this.items = []; }
    better(a, b) { return a.priority > b.priority || (a.priority === b.priority && a.id < b.id); }
    push(value) { const a = this.items; a.push(value); let i = a.length - 1; while (i) { const p = (i - 1) >> 1; if (!this.better(a[i], a[p])) break; [a[i], a[p]] = [a[p], a[i]]; i = p; } }
    pop() { const a = this.items; if (!a.length) return null; const top = a[0], last = a.pop(); if (a.length) { a[0] = last; let i = 0; while (true) { let best = i, l = i * 2 + 1, r = l + 1; if (l < a.length && this.better(a[l], a[best])) best = l; if (r < a.length && this.better(a[r], a[best])) best = r; if (best === i) break; [a[i], a[best]] = [a[best], a[i]]; i = best; } } return top; }
  }
  class ImageAnalysis {
    constructor(width, height, rgba) {
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || rgba.length !== width * height * 4) throw new Error('Invalid image data');
      this.width = width; this.height = height; this.area = width * height; this.stride = width + 1; this.rgba = new Uint8ClampedArray(rgba);
      const n = this.area, gray = new Float64Array(n); this.gradient = new Float32Array(n);
      // Composite alpha on white before both analysis and presentation.
      for (let i = 0; i < n; i++) { const k = i * 4, a = this.rgba[k + 3] / 255; for (let c = 0; c < 3; c++) this.rgba[k + c] = Math.round(this.rgba[k + c] * a + 255 * (1 - a)); this.rgba[k + 3] = 255; gray[i] = .2126 * this.rgba[k] + .7152 * this.rgba[k + 1] + .0722 * this.rgba[k + 2]; }
      const at = (x, y) => gray[Math.max(0, Math.min(height - 1, y)) * width + Math.max(0, Math.min(width - 1, x))];
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const gx = -at(x - 1, y - 1) + at(x + 1, y - 1) - 2 * at(x - 1, y) + 2 * at(x + 1, y) - at(x - 1, y + 1) + at(x + 1, y + 1);
        const gy = -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) + at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);
        this.gradient[y * width + x] = Math.min(1, Math.hypot(gx, gy) / (4 * 255));
      }
      // Three channel sums, summed RGB squares, gradient, 16 luminance bins.
      this.tables = Array.from({ length: 21 }, () => new Float64Array((width + 1) * (height + 1)));
      for (let y = 0; y < height; y++) { const row = new Float64Array(21); for (let x = 0; x < width; x++) { const i = y * width + x, k = i * 4, r = this.rgba[k], g = this.rgba[k + 1], b = this.rgba[k + 2]; row[0] += r; row[1] += g; row[2] += b; row[3] += r * r + g * g + b * b; row[4] += this.gradient[i]; row[5 + Math.min(15, Math.floor(gray[i] / 16))]++; const p = (y + 1) * this.stride + x + 1; for (let c = 0; c < 21; c++) this.tables[c][p] = this.tables[c][p - this.stride] + row[c]; } }
    }
    sum(c, x, y, w, h) { const a = this.tables[c], s = this.stride; return a[(y + h) * s + x + w] - a[y * s + x + w] - a[(y + h) * s + x] + a[y * s + x]; }
    region(x, y, w, h) {
      const area = w * h, sums = [0, 1, 2].map(c => this.sum(c, x, y, w, h)), color = sums.map(sum => Math.round(sum / area));
      // Use the displayed 8-bit RGB values so metrics match exported pixels exactly.
      const sse = Math.max(0, this.sum(3, x, y, w, h) + color.reduce((s, c, i) => s + area * c * c - 2 * c * sums[i], 0));
      let entropy = 0; for (let c = 5; c < 21; c++) { const p = this.sum(c, x, y, w, h) / area; if (p > 0) entropy -= p * Math.log2(p); }
      return { x, y, w, h, area, color, sse, mse: sse / (3 * area), edge: this.sum(4, x, y, w, h) / area, entropy };
    }
  }
  class Reconstruction {
    constructor(analysis, options = {}) {
      this.analysis = analysis;
      this.options = { mode: 'hybrid', budget: 1024, minSize: 2, threshold: 0, weights: [50, 30, 20], seed: 42, ...options };
      this.options.budget = Math.max(1, Math.floor(this.options.budget));
      this.options.minSize = Math.max(1, Math.floor(this.options.minSize));
      this.options.threshold = Math.max(0, Math.min(255, this.options.threshold || 0));
      const sum = this.options.weights.reduce((s, v) => s + Math.max(0, v), 0);
      this.weights = sum ? this.options.weights.map(v => Math.max(0, v) / sum) : [1 / 3, 1 / 3, 1 / 3];
      this.seed = this.options.seed >>> 0; this.nodes = []; this.events = []; this.heap = new Heap();
      this.root = this.makeNode(0, 0, analysis.width, analysis.height, 0);
      this.curve = [this.metric(1, this.root.sse, 0, 0)];
      this.build(); this.seek(0);
    }
    random() { this.seed = (Math.imul(1664525, this.seed) + 1013904223) >>> 0; return this.seed / 4294967296; }
    score(n) {
      const area = n.area / this.analysis.area, e = n.mse / MAX_SQUARE;
      switch (this.options.mode) {
        case 'error': return e * area;
        case 'edge': return n.edge * Math.sqrt(area);
        case 'entropy': return n.entropy / 4 * Math.sqrt(area);
        case 'uniform': return -n.depth - (n.y * this.analysis.width + n.x) / (this.analysis.area + 1);
        case 'random': return this.random();
        default: return (this.weights[0] * e + this.weights[1] * n.edge + this.weights[2] * n.entropy / 4) * Math.sqrt(area);
      }
    }
    makeNode(x, y, w, h, depth) { const n = { ...this.analysis.region(x, y, w, h), id: this.nodes.length, depth }; n.priority = this.score(n); this.nodes.push(n); return n; }
    parts(n) {
      const m = this.options.minSize, sx = Math.floor(n.w / 2) >= m, sy = Math.floor(n.h / 2) >= m;
      if (!sx && !sy) return [];
      const xs = sx ? [[n.x, Math.floor(n.w / 2)], [n.x + Math.floor(n.w / 2), Math.ceil(n.w / 2)]] : [[n.x, n.w]];
      const ys = sy ? [[n.y, Math.floor(n.h / 2)], [n.y + Math.floor(n.h / 2), Math.ceil(n.h / 2)]] : [[n.y, n.h]];
      return ys.flatMap(([y, h]) => xs.map(([x, w]) => [x, y, w, h]));
    }
    eligible(n) { return (this.options.threshold === 0 || Math.sqrt(n.mse) > this.options.threshold) && this.parts(n).length > 0; }
    metric(count, sse, gain, area) { const mse = Math.max(0, sse) / (this.analysis.area * 3), rmse = Math.sqrt(mse); return { count, mse, rmse, quality: 100 * (1 - rmse / 255), psnr: rmse < 1e-9 ? Infinity : 20 * Math.log10(255 / rmse), gain, area, ive: area ? gain / area : 0 }; }
    build() {
      let count = 1, sse = this.root.sse;
      if (this.eligible(this.root)) this.heap.push(this.root);
      while (this.heap.items.length) {
        const parent = this.heap.pop(), parts = this.parts(parent);
        if (count + parts.length - 1 > this.options.budget) continue;
        const children = parts.map(p => this.makeNode(...p, parent.depth + 1));
        sse = Math.max(0, sse - parent.sse + children.reduce((s, n) => s + n.sse, 0)); count += children.length - 1;
        const event = { parent, children }; this.events.push(event);
        const m = this.metric(count, sse, 0, parent.area); m.gain = m.quality - this.curve[this.curve.length - 1].quality; m.ive = m.gain / parent.area; this.curve.push(m);
        for (const n of children) if (this.eligible(n)) this.heap.push(n);
      }
      this.stopReason = count >= this.options.budget - 2 ? '已达到元素预算' : '已达到最小尺度或误差阈值';
    }
    seek(step) {
      step = Math.min(this.events.length, Math.max(0, Math.floor(step)));
      if (!this.leaves || step < this.step) { this.leaves = new Map([[0, this.root]]); this.step = 0; }
      for (let i = this.step; i < step; i++) { const e = this.events[i]; this.leaves.delete(e.parent.id); for (const n of e.children) this.leaves.set(n.id, n); }
      this.step = step; return this.curve[step];
    }
    stepForCount(count) { let lo = 0, hi = this.curve.length - 1; while (lo < hi) { const m = Math.ceil((lo + hi) / 2); if (this.curve[m].count <= count) lo = m; else hi = m - 1; } return lo; }
    raster() { const out = new Uint8ClampedArray(this.analysis.area * 4), width = this.analysis.width; for (const n of this.leaves.values()) { const c = n.color.map(Math.round); for (let y = n.y; y < n.y + n.h; y++) for (let x = n.x; x < n.x + n.w; x++) { const k = (y * width + x) * 4; out[k] = c[0]; out[k + 1] = c[1]; out[k + 2] = c[2]; out[k + 3] = 255; } } return out; }
  }
  const api = { ImageAnalysis, Reconstruction };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.QuadtreeLab = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
