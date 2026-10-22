(function (root) {
  'use strict';
  const targets = [1, 4, 16, 64, 256, 1024];
  function checkpoints(curve) {
    const max = curve.at(-1).count;
    const steps = new Set([0, curve.length - 1]);
    for (const target of targets) {
      if (target > max) continue;
      let lo = 0, hi = curve.length - 1;
      while (lo < hi) { const middle = Math.ceil((lo + hi) / 2); if (curve[middle].count <= target) lo = middle; else hi = middle - 1; }
      steps.add(lo);
    }
    return [...steps].sort((a, b) => a - b).map(step => ({ step, count: curve[step].count, quality: curve[step].quality }));
  }
  function normalize(text) { return String(text || '').normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ''); }
  function suggestedVerdict(label, unknown, truth, aliases) {
    if (unknown || /^(无法判断|不能判断|不知道|不确定|看不清|unknown|unclear|uncertain|none)$/i.test(String(label).trim())) return 'incorrect';
    const actual = normalize(label);
    const expected = [truth, ...String(aliases || '').split(/[，,、;；\n]/)].map(normalize).filter(Boolean);
    return actual && expected.includes(actual) ? 'correct' : 'review';
  }
  function summarize(rows) {
    const baseline = rows.find(r => r.baseline) || null;
    const groups = new Map();
    for (const row of rows) if (!row.baseline) { if (!groups.has(row.mode)) groups.set(row.mode, []); groups.get(row.mode).push(row); }
    const strategies = [...groups].map(([mode, items]) => {
      items.sort((a, b) => a.count - b.count);
      const first = items.find(r => r.verdict === 'correct') || null;
      let sustained = null;
      for (let i = 0; i < items.length - 1; i++) if (items.slice(i).every(r => r.verdict === 'correct')) { sustained = items[i]; break; }
      return { mode, first, sustained, tested: items.length, reviewed: items.filter(r => r.verdict !== 'review').length };
    });
    return { baseline, strategies };
  }
  function csv(rows, meta) {
    const quote = value => '"' + String(value ?? '').replaceAll('"', '""') + '"';
    const fields = ['source', 'truth', 'aliases', 'requested_model', 'returned_model_id', 'response_id', 'strategy', 'baseline', 'step', 'elements', 'pixel_quality_percent', 'answer', 'visible_evidence', 'model_unknown', 'verdict', 'image_sha256', 'prompt_version', 'min_size', 'rmse_threshold', 'weight_error', 'weight_edge', 'weight_entropy', 'seed', 'width', 'height', 'timestamp'];
    return '\ufeff' + [fields.join(','), ...rows.map(r => [meta.source, meta.truth, meta.aliases, meta.model, r.modelId, r.responseId, r.mode, r.baseline, r.step, r.count, r.quality, r.label, r.evidence, r.unknown, r.verdict, r.sha256, meta.promptVersion, meta.options.minSize, meta.options.threshold, ...meta.options.weights, meta.options.seed, meta.width, meta.height, r.timestamp].map(quote).join(','))].join('\n');
  }
  const api = { checkpoints, suggestedVerdict, summarize, csv };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RecognitionLab = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
