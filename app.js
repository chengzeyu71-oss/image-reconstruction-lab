'use strict';
const $ = id => document.getElementById(id);
const { ImageAnalysis, Reconstruction } = QuadtreeLab;
const budgets = [4, 16, 64, 256, 1024, 4096, 8192, 16384];
const modes = { hybrid: ['综合信息', '#ef6b37'], error: ['误差优先', '#537959'], edge: ['边缘优先', '#789fc0'], entropy: ['信息熵优先', '#b69b54'], uniform: ['均匀细分', '#a38dbb'], random: ['随机细分', '#9ca59a'] };
const notes = { hybrid: '将误差、边缘与信息熵加权，优先细化信息丰富的区域。', error: '优先细分总平方误差最大的区域，兼顾区域面积。', edge: '根据 Sobel 边缘强度与区域面积，优先细分轮廓丰富的区域。', entropy: '根据 16 级灰度信息熵与区域面积，优先细分复杂区域。', uniform: '逐层细分，每层从上到下、从左到右推进，作为规则网格基线。', random: '使用固定随机种子 42 排序区域，便于重复实验。' };
let analysis, engine, mode = 'hybrid', view = 'reconstruction', playing = false, frame = 0, clock = 0, accumulator = 0, revision = 0, loadRevision = 0, comparison = null, toastTimer;
const format = n => n.toLocaleString('en-US');
function toast(message) { $('toast').textContent = message; $('toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('show'), 3000); }
function options() { return { mode, budget: budgets[+$('budget').value], minSize: +$('min-size').value, threshold: Math.max(0, Math.min(255, +$('threshold').value || 0)), weights: ['error', 'edge', 'entropy'].map(k => +$('w-' + k).value), seed: 42 }; }
function weightLabels() { const weights = options().weights, total = weights.reduce((s, v) => s + v, 0); ['error', 'edge', 'entropy'].forEach((k, i) => $('w-' + k + '-value').textContent = (total ? 100 * weights[i] / total : 100 / 3).toFixed(0) + '%'); }
function rebuild() {
  if (!analysis) return; pause(); revision++; comparison = null;
  $('compare').disabled = false; $('compare').textContent = '比较全部策略 ↗';
  $('budget-value').textContent = format(options().budget); weightLabels();
  engine = new Reconstruction(analysis, options());
  $('timeline').max = engine.events.length; $('timeline').value = 0;
  $('strategy-note').textContent = notes[mode]; $('weights').classList.toggle('inactive', mode !== 'hybrid');
  document.querySelectorAll('#weights input').forEach(el => el.disabled = mode !== 'hybrid');
  $('compare-note').textContent = '横轴为元素数量（对数尺度），纵轴为像素还原度。圆点标记当前进度。';
  makeMilestones(); render(); window.aiInvalidate?.();
}
function drawBlocks(canvas, nodes, grid = false, highlight = null) {
  const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height);
  const sx = canvas.width / analysis.width, sy = canvas.height / analysis.height;
  ctx.save(); ctx.scale(sx, sy);
  for (const n of nodes) { ctx.fillStyle = `rgb(${n.color.map(Math.round).join(',')})`; ctx.fillRect(n.x, n.y, n.w, n.h); }
  if (grid) { ctx.strokeStyle = 'rgba(35,40,28,.23)'; ctx.lineWidth = .38; for (const n of nodes) { if (n.w >= 3 && n.h >= 3) ctx.strokeRect(n.x, n.y, n.w, n.h); } }
  if (highlight) { ctx.strokeStyle = '#ff753a'; ctx.lineWidth = 1.5; ctx.strokeRect(highlight.x + .75, highlight.y + .75, Math.max(.1, highlight.w - 1.5), Math.max(.1, highlight.h - 1.5)); }
  ctx.restore();
}
function render() {
  const current = engine.curve[engine.step], next = engine.events[engine.step]?.parent;
  $('timeline').value = engine.step; $('step-label').textContent = `${format(engine.step)} / ${format(engine.events.length)} 次细分`;
  $('block-count').textContent = `${format(current.count)} ELEMENT${current.count > 1 ? 'S' : ''}`;
  $('metric-count').textContent = format(current.count); $('metric-budget').textContent = `上限 ${format(engine.options.budget)} · 最多 ${format(engine.curve.at(-1).count)}`;
  $('metric-quality').innerHTML = current.quality.toFixed(2) + '<small>%</small>';
  $('metric-psnr').innerHTML = (isFinite(current.psnr) ? current.psnr.toFixed(2) : '∞') + '<small>dB</small>';
  $('metric-rmse').textContent = `RMSE ${current.rmse.toFixed(3)} / 255`;
  $('metric-gain').innerHTML = '+' + current.gain.toFixed(3) + '<small>pp</small>';
  $('metric-area').textContent = current.area ? `单位面积增益 ${current.ive.toExponential(2)} pp / px²` : '从整张图像的平均色开始';
  $('step').disabled = !next; $('play').disabled = !engine.events.length;
  $('view-label').textContent = { reconstruction: '自适应重建', error: '逐像素误差', edge: 'Sobel 边缘' }[view];
  $('view-note').textContent = { reconstruction: '每个矩形以区域平均色表示 · 橙色框为下一处细分', error: '逐像素 RGB 绝对误差均值 · 暗色为低误差，暖色为高误差', edge: '原图的 Sobel 梯度 · 亮处表示较强的明暗边缘' }[view];
  if (view === 'reconstruction') drawBlocks($('result'), engine.leaves.values(), $('grid').checked, $('highlight').checked ? next : null);
  else {
    const data = new Uint8ClampedArray(analysis.area * 4), generated = view === 'error' ? engine.raster() : null;
    for (let i = 0; i < analysis.area; i++) { const k = i * 4; if (view === 'edge') data[k] = data[k + 1] = data[k + 2] = Math.round(analysis.gradient[i] * 255); else { const e = (Math.abs(analysis.rgba[k] - generated[k]) + Math.abs(analysis.rgba[k + 1] - generated[k + 1]) + Math.abs(analysis.rgba[k + 2] - generated[k + 2])) / (3 * 255); data[k] = Math.min(255, 18 + e * 650); data[k + 1] = Math.max(12, (e - .2) * 420); data[k + 2] = Math.max(9, (e - .65) * 550); } data[k + 3] = 255; }
    $('result').getContext('2d').putImageData(new ImageData(data, analysis.width, analysis.height), 0, 0);
  }
  if (next) $('inspect-body').innerHTML = `<div class="region-meta"><span>(${next.x}, ${next.y})</span><span>${next.w} × ${next.h} px · L${next.depth}</span></div>${[['区域 RMSE', Math.sqrt(next.mse) / 255, Math.sqrt(next.mse).toFixed(1)], ['边缘强度', next.edge, next.edge.toFixed(3)], ['信息熵', next.entropy / 4, next.entropy.toFixed(2)]].map(([label, value, text]) => `<div class="score-row"><span>${label}</span><span class="score-bar"><i style="width:${value * 100}%"></i></span><output>${text}</output></div>`).join('')}<div class="priority-score"><span>${mode === 'uniform' ? '层级排序值' : mode === 'random' ? '种子随机排序值' : '区域优先级'}</span><strong>${next.priority.toFixed(5)}</strong></div>`;
  else $('inspect-body').innerHTML = `<div class="region-meta"><span>本轮重建完成</span><span>✓</span></div><p class="hint">${engine.stopReason}。已用 ${format(current.count)} 个元素表达这张图像。可提高预算、减小块边长，或降低停止阈值继续探索。</p><div class="priority-score"><span>剩余细分步骤</span><strong>0</strong></div>`;
  document.querySelectorAll('.milestone').forEach(b => b.classList.toggle('active', +b.dataset.step === engine.step));
  drawChart();
}
function pause() { playing = false; cancelAnimationFrame(frame); $('play').textContent = '▶'; $('play').setAttribute('aria-label', '开始播放'); }
function play() {
  if (playing) { pause(); return; } if (!engine.events.length) return;
  if (engine.step === engine.events.length) engine.seek(0);
  playing = true; clock = performance.now(); accumulator = 0; $('play').textContent = 'Ⅱ'; $('play').setAttribute('aria-label', '暂停播放');
  function tick(now) { if (!playing) return; accumulator += Math.min(100, now - clock) / 1000 * Math.max(8, engine.events.length / 12) * +$('speed').value; clock = now; const moves = Math.floor(accumulator); if (moves) { accumulator -= moves; engine.seek(engine.step + moves); render(); } if (engine.step >= engine.events.length) { pause(); return; } frame = requestAnimationFrame(tick); }
  frame = requestAnimationFrame(tick);
}
function makeMilestones() {
  const final = engine.curve.at(-1).count, counts = [...new Set([1, 16, 64, 256, 1024, final].filter(n => n <= final))];
  const container = $('milestones'); container.replaceChildren();
  counts.forEach(count => { const step = engine.stepForCount(count); engine.seek(step); const actual = engine.curve[step].count; const b = document.createElement('button'); b.className = 'milestone'; b.dataset.step = step; b.title = `回看 ${actual} 个元素`; const canvas = document.createElement('canvas'); canvas.width = analysis.width; canvas.height = analysis.height; drawBlocks(canvas, engine.leaves.values()); b.append(canvas); const label = document.createElement('span'); label.innerHTML = `<strong>${format(actual)}</strong> ELEMENTS`; b.append(label); b.addEventListener('click', () => { pause(); engine.seek(step); render(); }); container.append(b); }); engine.seek(0);
}
function drawChart() {
  const canvas = $('chart'), rect = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1, w = Math.max(200, rect.width), h = 180;
  canvas.width = w * dpr; canvas.height = h * dpr; const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
  const left = 43, top = 19, right = w - 19, bottom = h - 28, series = comparison || [{ mode, curve: engine.curve }];
  const max = Math.max(4, ...series.map(s => s.curve.at(-1).count));
  const minQuality = Math.max(0, Math.floor((engine.curve[0].quality - 5) / 10) * 10);
  const x = n => left + Math.log(Math.max(1, n)) / Math.log(max) * (right - left), y = q => bottom - (q - minQuality) / (100 - minQuality) * (bottom - top);
  ctx.font = '8px ui-monospace, monospace';
  for (let i = 0; i <= 3; i++) { const q = minQuality + (100 - minQuality) * i / 3, yy = y(q); ctx.strokeStyle = '#ecefe6'; ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(right, yy); ctx.stroke(); ctx.fillStyle = '#a0aa94'; ctx.textAlign = 'right'; ctx.fillText(q.toFixed(0) + '%', left - 8, yy + 3); }
  const ticks = [1, 4, 16, 64, 256, 1024, 4096, 16384].filter(n => n <= max); let lastTick = -100;
  ctx.textAlign = 'center'; for (const n of ticks) if (x(n) - lastTick > 31) { ctx.fillText(n >= 1024 ? (n / 1024) + 'k' : n, x(n), bottom + 17); lastTick = x(n); }
  for (const s of series) { ctx.strokeStyle = modes[s.mode][1]; ctx.lineWidth = s.mode === mode ? 2 : 1.3; ctx.beginPath(); const skip = Math.max(1, Math.floor(s.curve.length / 500)); for (let i = 0; i < s.curve.length; i += skip) { const p = s.curve[i]; if (!i) ctx.moveTo(x(p.count), y(p.quality)); else ctx.lineTo(x(p.count), y(p.quality)); } const end = s.curve.at(-1); ctx.lineTo(x(end.count), y(end.quality)); ctx.stroke(); }
  const p = engine.curve[engine.step]; ctx.setLineDash([3, 3]); ctx.strokeStyle = '#e0bfa9'; ctx.beginPath(); ctx.moveTo(x(p.count), top); ctx.lineTo(x(p.count), bottom); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = modes[mode][1]; ctx.beginPath(); ctx.arc(x(p.count), y(p.quality), 4, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
  $('legend').innerHTML = series.map(s => `<span><i style="background:${modes[s.mode][1]}"></i>${modes[s.mode][0]}</span>`).join('');
}
async function compare() {
  pause(); const token = revision, source = analysis, config = options(); $('compare').disabled = true; $('compare').textContent = '正在计算…'; const series = [];
  try { for (const key of Object.keys(modes)) { await new Promise(r => setTimeout(r, 0)); if (token !== revision) return; const run = key === mode ? engine : new Reconstruction(source, { ...config, mode: key }); series.push({ mode: key, curve: run.curve }); }
    if (token !== revision) return; comparison = series; drawChart(); $('compare-note').textContent = `六种策略共用预算 ${format(config.budget)}、最小块边长 ${config.minSize} px 和 RMSE 阈值 ${config.threshold}。CSV 可导出全部轨迹。`; $('compare').textContent = '比较已完成 ✓';
  } catch (error) { console.error(error); toast('比较失败，请降低元素预算后重试。'); $('compare').textContent = '重新比较 ↗'; } finally { if (token === revision) $('compare').disabled = false; }
}
function save(blob, name) { const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 2000); toast('已生成导出文件'); }
function exportName(ext) { return `逐像-${mode}-${engine.curve[engine.step].count}.${ext}`; }
function exportPNG() { const c = document.createElement('canvas'); c.width = analysis.width * 4; c.height = analysis.height * 4; drawBlocks(c, engine.leaves.values()); c.toBlob(blob => { if (blob) save(blob, exportName('png')); }, 'image/png'); }
function exportSVG() { const rects = [...engine.leaves.values()].map(n => `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" fill="rgb(${n.color.map(Math.round).join(',')})"/>`).join(''); save(new Blob([`<svg xmlns="http://www.w3.org/2000/svg" width="${analysis.width}" height="${analysis.height}" viewBox="0 0 ${analysis.width} ${analysis.height}" shape-rendering="crispEdges">${rects}</svg>`], { type: 'image/svg+xml' }), exportName('svg')); }
function exportData() { const data = { version: 1, source: $('filename').textContent, width: analysis.width, height: analysis.height, step: engine.step, options: engine.options, normalizedWeights: engine.weights, metrics: { ...engine.curve[engine.step], psnr: isFinite(engine.curve[engine.step].psnr) ? engine.curve[engine.step].psnr : 'Infinity' }, elements: [...engine.leaves.values()].map(({ x, y, w, h, color, priority, mse, edge, entropy }) => ({ x, y, w, h, color, priority, mse, edge, entropy })) }; save(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), exportName('json')); }
function exportCSV() { const series = comparison || [{ mode, curve: engine.curve }], config = engine.options; const rows = ['strategy,step,elements,quality_percent,mse,rmse,psnr_db,gain_pp,split_area_px,ive_pp_per_px,budget,min_size,threshold,weight_error,weight_edge,weight_entropy,seed,width,height']; for (const s of series) s.curve.forEach((p, i) => rows.push([s.mode, i, p.count, p.quality, p.mse, p.rmse, p.psnr, p.gain, p.area, p.ive, config.budget, config.minSize, config.threshold, ...engine.weights, config.seed, analysis.width, analysis.height].join(','))); save(new Blob(['\ufeff' + rows.join('\n')], { type: 'text/csv;charset=utf-8' }), exportName('csv')); }
async function loadImage(src, name, token) {
  const img = new Image(); img.src = src; await img.decode(); if (token !== loadRevision) return;
  const scale = Math.min(1, 256 / Math.max(img.naturalWidth, img.naturalHeight)), w = Math.max(1, Math.round(img.naturalWidth * scale)), h = Math.max(1, Math.round(img.naturalHeight * scale));
  const c = $('original'); c.width = w; c.height = h; const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h);
  analysis = new ImageAnalysis(w, h, ctx.getImageData(0, 0, w, h).data); $('result').width = w; $('result').height = h;
  const thumb = $('thumb').getContext('2d'); thumb.clearRect(0, 0, 64, 64); thumb.drawImage(c, 0, 0, 64, 64); $('filename').textContent = name; $('dimensions').textContent = `${w} × ${h} · RGB`; rebuild();
}
async function loadFile(file) { if (!file) return; if (!file.type.startsWith('image/')) { toast('请选择有效的图片文件'); return; } if (file.size > 40 * 1024 * 1024) { toast('请选择小于 40 MB 的图片'); return; } const token = ++loadRevision, url = URL.createObjectURL(file); pause(); try { await loadImage(url, file.name, token); if (token === loadRevision) { document.querySelectorAll('.sample').forEach(b => b.classList.remove('active')); window.aiOnUpload?.(); } } catch { toast('无法读取这张图片，请尝试 PNG、JPEG 或 WebP。'); } finally { URL.revokeObjectURL(url); $('file').value = ''; } }
function sampleSVG(kind) {
  const open = '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">';
  if (kind === 'landscape') return open + '<defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#cbd5c7"/><stop offset="1" stop-color="#f0d6ae"/></linearGradient></defs><path fill="url(#sky)" d="M0 0h512v512H0z"/><circle cx="350" cy="152" r="62" fill="#cf6b42"/><path d="M0 295L133 110l138 209 104-141 137 142v192H0" fill="#748778"/><path d="M0 340l120-95 84 76 99-102 209 141v152H0" fill="#466b61"/><path d="M0 402l152-84 96 62 116-33 148 68v97H0" fill="#244e43"/><path d="M215 512l82-54-60-45 62-38-33-28 62 29-50 38 70 41-60 57" fill="#b4c5a7"/><path d="M0 479l117-77 89 110H0m335 0 91-91 86 46v45" fill="#1c3b34"/></svg>';
  if (kind === 'geometry') return open + '<path fill="#e9e2d2" d="M0 0h512v512H0z"/><path fill="#293e3a" d="M48 48h208v208H48z"/><circle cx="256" cy="256" r="148" fill="#dc7446"/><path fill="#edc577" d="M256 48h208v208H256z"/><path fill="#556950" d="M256 256h208v208H256z"/><path fill="#293e3a" d="M48 464l104-208 104 208z"/><circle cx="360" cy="152" r="61" fill="#f5f0df"/><circle cx="360" cy="360" r="61" fill="#e9e2d2"/><path fill="#293e3a" d="M360 299a61 61 0 0 1 0 122z"/></svg>';
  return open + `<defs><radialGradient id="bg"><stop stop-color="#a7b2a0"/><stop offset="1" stop-color="#6c7d6f"/></radialGradient><linearGradient id="fur" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#d1c4a9"/><stop offset=".55" stop-color="#aaa08a"/><stop offset="1" stop-color="#797f70"/></linearGradient><radialGradient id="face"><stop stop-color="#ddd2b9"/><stop offset="1" stop-color="#999b85"/></radialGradient><radialGradient id="eye"><stop stop-color="#152e2a"/><stop offset=".42" stop-color="#667f60"/><stop offset="1" stop-color="#c7d391"/></radialGradient></defs><path fill="url(#bg)" d="M0 0h512v512H0z"/><ellipse cx="260" cy="508" rx="181" ry="180" fill="url(#fur)"/><path d="M111 242 90 64q66 13 122 88h94q56-73 118-91l-25 189Z" fill="#717568"/><path d="m113 93 15 136 73-58Z" fill="#c1a698"/><path d="m405 95-17 130-76-54Z" fill="#baa699"/><path d="M103 252q-6-99 102-106l51 13 46-13q107 9 109 106l-15 80q-36 87-139 97-116-17-145-99Z" fill="url(#face)"/><path d="m208 150 28 69 19-37 20 38 28-71-47 11Z" fill="#687264"/><path d="m111 227 80 32-77-8 66 37-68-12m289-49-80 32 77-8-66 37 68-12" fill="#707967"/><path d="M148 272q36-32 76 0-34 43-76 0m144 0q38-32 76 0-34 43-76 0" fill="#37463a"/><path d="M153 272q33-21 66 0-33 30-66 0m144 0q33-21 66 0-33 30-66 0" fill="url(#eye)"/><ellipse cx="188" cy="273" rx="7" ry="19" fill="#20392b"/><ellipse cx="331" cy="273" rx="7" ry="19" fill="#20392b"/><circle cx="182" cy="266" r="4" fill="#f4efd5"/><circle cx="325" cy="266" r="4" fill="#f4efd5"/><path d="M253 288q-4 43-22 52l26 15 27-16q-18-18-23-51" fill="#b0a58b"/><ellipse cx="224" cy="355" rx="43" ry="33" fill="#d8d0b9"/><ellipse cx="291" cy="355" rx="43" ry="33" fill="#d8d0b9"/><path d="m241 333 33 0-16 17Z" fill="#6f544b"/><path d="m258 349v16q-11 16-25 4m25-4q12 15 25 4" stroke="#685f4f" stroke-width="3" fill="none"/><path d="m208 351-99-13m100 24-109 8m107 3-83 29m182-51 102-13m-104 24 111 8m-107 3 83 29" stroke="#e2ddc9" stroke-width="2" opacity=".8"/><path d="m167 380 36 31 53 17 52-18 39-34-30 59-60 44-57-46Z" fill="#d0c8af"/><path d="m129 438 44 16-48 7m257-23-44 16 48 7" fill="#777d6a"/></svg>`;
}
async function loadSample(kind) { const token = ++loadRevision; try { await loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(sampleSVG(kind)), { cat: '安静的猫 · 内置示例', landscape: '山与落日 · 内置示例', geometry: '几何构成 · 内置示例' }[kind], token); if (token === loadRevision) { document.querySelectorAll('.sample').forEach(b => b.classList.toggle('active', b.dataset.sample === kind)); window.aiOnSampleLoaded?.(kind); } } catch (error) { console.error(error); toast('示例加载失败，请导入图片'); } }
$('upload').onclick = () => $('file').click(); $('file').onchange = e => loadFile(e.target.files[0]);
$('dropzone').onclick = () => $('file').click(); $('dropzone').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } };
for (const name of ['dragenter', 'dragover']) $('dropzone').addEventListener(name, e => { e.preventDefault(); $('dropzone').classList.add('dragover'); });
$('dropzone').ondragleave = () => $('dropzone').classList.remove('dragover'); $('dropzone').ondrop = e => { e.preventDefault(); $('dropzone').classList.remove('dragover'); loadFile(e.dataTransfer.files[0]); };
document.querySelectorAll('.sample').forEach(b => b.onclick = () => loadSample(b.dataset.sample));
document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { mode = b.dataset.mode; document.querySelectorAll('[data-mode]').forEach(el => el.classList.toggle('active', el === b)); rebuild(); });
document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => { view = b.dataset.view; document.querySelectorAll('[data-view]').forEach(el => el.classList.toggle('active', el === b)); render(); });
for (const id of ['budget', 'min-size', 'threshold', 'w-error', 'w-edge', 'w-entropy']) $(id).addEventListener('change', rebuild);
for (const id of ['w-error', 'w-edge', 'w-entropy']) $(id).addEventListener('input', weightLabels);
$('budget').oninput = () => $('budget-value').textContent = format(budgets[+$('budget').value]);
for (const id of ['grid', 'highlight']) $(id).onchange = render;
$('play').onclick = play; $('reset').onclick = () => { pause(); engine.seek(0); render(); }; $('step').onclick = () => { pause(); engine.seek(engine.step + 1); render(); }; $('timeline').oninput = () => { pause(); engine.seek(+$('timeline').value); render(); };
$('compare').onclick = compare; $('export-png').onclick = exportPNG; $('export-svg').onclick = exportSVG; $('export-data').onclick = exportData; $('export-csv').onclick = exportCSV;
$('help').onclick = () => $('help-dialog').showModal(); $('close-help').onclick = () => $('help-dialog').close(); $('help-dialog').onclick = e => { if (e.target === $('help-dialog')) { const r = e.target.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) e.target.close(); } };
window.addEventListener('resize', () => { if (engine) drawChart(); });
document.addEventListener('keydown', e => { if (e.code === 'Space' && !['INPUT', 'SELECT', 'BUTTON'].includes(document.activeElement.tagName) && !$('help-dialog').open && engine) { e.preventDefault(); play(); } });
loadSample('cat');
