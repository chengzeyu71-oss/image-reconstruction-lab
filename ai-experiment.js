'use strict';
const Rec = RecognitionLab;
let aiRows = [], aiMeta = null, aiAbort = null, aiReady = false, aiRunning = false;
const labelForMode = key => modes[key]?.[0] || key;
const setAiMessage = message => { $('ai-message').textContent = message; };
function updateAiEstimate() {
  if (!engine) return;
  const modesToRun = $('ai-scope').value === 'all' ? Object.keys(modes) : [mode];
  const total = 1 + modesToRun.reduce((sum, key) => sum + (key === mode ? Rec.checkpoints(engine.curve).length : Rec.checkpoints(new Reconstruction(analysis, { ...options(), mode: key }).curve).length), 0);
  $('ai-estimate').textContent = `原图基线 + ${total - 1} 个节点 · 最多 ${total} 次调用`;
}
function updateAiSummary() {
  if (!aiRows.length) { $('ai-summary').hidden = true; return; }
  const report = Rec.summarize(aiRows);
  const container = $('ai-summary'); container.hidden = false; container.replaceChildren();
  const baseline = document.createElement('div'); baseline.className = 'ai-summary-item'; baseline.innerHTML = `<small>原图基线</small><strong>${report.baseline ? ({ correct: '已认出', incorrect: '未认出', review: '待判定' }[report.baseline.verdict]) : '待测试'}</strong><span>若基线失败，重建阈值的解释受到限制</span>`; container.append(baseline);
  for (const s of report.strategies) { const card = document.createElement('div'); card.className = 'ai-summary-item'; const title = document.createElement('small'); title.textContent = labelForMode(s.mode); const value = document.createElement('strong'); value.textContent = s.first ? `${format(s.first.count)} 元素` : '尚未答对'; const note = document.createElement('span'); note.textContent = `首次答对 · 持续答对 ${s.sustained ? format(s.sustained.count) + ' 元素' : '未出现'} · 已判 ${s.reviewed}/${s.tested}`; card.append(title, value, note); container.append(card); }
}
function addAiRow(row) {
  aiRows.push(row); const tr = document.createElement('tr');
  const node = document.createElement('td'); node.textContent = row.baseline ? '原图基线' : `${labelForMode(row.mode)} · 第 ${row.step} 步`;
  const preview = document.createElement('td'); const button = document.createElement('button'); button.className = 'ai-thumbnail'; button.title = '放大这次发送给模型的图像'; button.setAttribute('aria-label', `放大${node.textContent}的节点图`); const picture = document.createElement('img'); picture.src = row.image; picture.alt = ''; button.append(picture); button.onclick = () => { $('ai-image-title').textContent = row.baseline ? '原图基线' : `${labelForMode(row.mode)} · ${format(row.count)} 元素`; $('ai-image-large').src = row.image; $('ai-image-dialog').showModal(); }; preview.append(button);
  const count = document.createElement('td'); count.textContent = row.baseline ? '原图' : format(row.count);
  const answer = document.createElement('td'); const strong = document.createElement('strong'); strong.textContent = row.label || '无回答'; const evidence = document.createElement('small'); evidence.textContent = row.evidence || (row.unknown ? '模型表示无法判断' : ''); answer.append(strong, evidence);
  const quality = document.createElement('td'); quality.textContent = row.baseline ? '100%' : `${row.quality.toFixed(2)}%`;
  const verdict = document.createElement('td'); const select = document.createElement('select'); select.setAttribute('aria-label', `${node.textContent}的判定`); for (const [value, label] of [['review', '待判定'], ['correct', '正确'], ['incorrect', '错误']]) { const opt = document.createElement('option'); opt.value = value; opt.textContent = label; select.append(opt); } select.value = row.verdict; select.onchange = () => { row.verdict = select.value; updateAiSummary(); }; verdict.append(select);
  tr.append(node, preview, count, answer, quality, verdict); $('ai-results').append(tr); $('ai-table').hidden = false; $('ai-export').hidden = false; updateAiSummary();
}
function makeImage(run, step, baseline = false) {
  const w = analysis.width, h = analysis.height, canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  if (!baseline) run.seek(step);
  const pixels = baseline ? analysis.rgba : run.raster();
  canvas.getContext('2d').putImageData(new ImageData(pixels, w, h), 0, 0);
  return canvas.toDataURL('image/png');
}
async function hashDataUrl(url) { const bytes = Uint8Array.from(atob(url.split(',')[1]), c => c.charCodeAt(0)); const digest = await crypto.subtle.digest('SHA-256', bytes); return [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join(''); }
async function recognizeOne(image, model, signal) {
  const response = await fetch('/api/recognize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image, model }), signal });
  const payload = await response.json(); if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`); return payload;
}
async function runAiExperiment() {
  if (!aiReady || aiRunning || !analysis) return;
  const truth = $('ai-truth').value.trim(), aliases = $('ai-aliases').value.trim();
  if (!truth) { setAiMessage('请先填写原图主要对象或场景。'); $('ai-truth').focus(); return; }
  pause(); aiRunning = true; aiAbort = new AbortController(); const signal = aiAbort.signal;
  aiRows = []; $('ai-results').replaceChildren(); $('ai-table').hidden = true; $('ai-summary').hidden = true; $('ai-export').hidden = true;
  const chosenModes = $('ai-scope').value === 'all' ? Object.keys(modes) : [mode], model = $('ai-model').value;
  aiMeta = { source: $('filename').textContent, truth, aliases, model, options: options(), width: analysis.width, height: analysis.height, promptVersion: 'recognition-v1', startedAt: new Date().toISOString() };
  $('ai-run').disabled = true; $('ai-cancel').hidden = false; document.querySelectorAll('.controls button,.controls input,.controls select,#upload,#ai-scope,#ai-model,#ai-truth,#ai-aliases').forEach(el => el.disabled = true);
  const work = [{ baseline: true, mode: 'original', step: null, count: null, quality: 100, run: null }];
  for (const key of chosenModes) { const run = new Reconstruction(analysis, { ...aiMeta.options, mode: key }); for (const point of Rec.checkpoints(run.curve)) work.push({ ...point, baseline: false, mode: key, run }); }
  try {
    for (let i = 0; i < work.length; i++) {
      if (signal.aborted) break;
      const point = work[i]; setAiMessage(`正在识别 ${i + 1}/${work.length}：${point.baseline ? '原图基线' : `${labelForMode(point.mode)} · ${format(point.count)} 元素`}。每次为独立请求。`);
      const image = makeImage(point.run, point.step, point.baseline), sha256 = await hashDataUrl(image);
      const result = await recognizeOne(image, model, signal);
      const row = { baseline: point.baseline, mode: point.mode, step: point.step, count: point.count, quality: point.quality, image, label: result.label, evidence: result.evidence, unknown: result.unknown, modelId: result.model_id, responseId: result.response_id, verdict: Rec.suggestedVerdict(result.label, result.unknown, truth, aliases), sha256, timestamp: new Date().toISOString() };
      addAiRow(row);
    }
    setAiMessage(signal.aborted ? `已停止，保留 ${aiRows.length} 条已完成结果。` : `已完成 ${aiRows.length} 次独立识别。请检查“待判定”回答，再比较首次与持续识别节点。`);
  } catch (error) { setAiMessage(signal.aborted ? `已停止，保留 ${aiRows.length} 条已完成结果。` : `实验中断：${error.message}。已保留完成的结果；可导出 CSV。`); }
  finally { aiRunning = false; aiAbort = null; $('ai-cancel').hidden = true; $('ai-run').disabled = !aiReady; document.querySelectorAll('.controls button,.controls input,.controls select,#upload,#ai-scope,#ai-model,#ai-truth,#ai-aliases').forEach(el => el.disabled = false); }
}
function invalidateAi() { if (aiAbort) aiAbort.abort(); aiRows = []; aiMeta = null; $('ai-results').replaceChildren(); $('ai-table').hidden = true; $('ai-summary').hidden = true; $('ai-export').hidden = true; updateAiEstimate(); if (!aiRunning) setAiMessage(aiReady ? '图像或算法参数已改变。可运行新的识别实验。' : '运行本机 AI 服务并配置 API 密钥后即可开始。'); }
window.aiInvalidate = invalidateAi;
window.aiOnSampleLoaded = kind => { const labels = { cat: ['猫', 'cat'], landscape: ['山与落日', '山脉，日落，mountain sunset'], geometry: ['几何图形', '几何构成，geometric shapes'] }; [$('ai-truth').value, $('ai-aliases').value] = labels[kind]; };
window.aiOnUpload = () => { $('ai-truth').value = ''; $('ai-aliases').value = ''; setAiMessage('请输入原图的主要对象或场景，再运行实验。'); };
async function checkAiStatus() { try { const res = await fetch('/api/status'); const status = await res.json(); aiReady = !!(res.ok && status.ready); $('ai-status').textContent = aiReady ? '已配置 API 密钥' : '需要本机 API 密钥'; $('ai-status').classList.toggle('ready', aiReady); $('ai-run').disabled = !aiReady; if (!aiReady) setAiMessage('本机服务已启动，但尚未配置 OPENAI_API_KEY。设置后重启服务即可调用视觉模型。'); else setAiMessage('密钥已配置。填写正确标签，选择测试范围，然后运行识别实验；模型可用性将在首次请求时验证。'); } catch { aiReady = false; $('ai-status').textContent = '请运行本机 AI 服务'; $('ai-run').disabled = true; setAiMessage('当前是静态预览。用 README 中的方式启动 server.py，并配置 OPENAI_API_KEY 后即可运行识别实验。'); } updateAiEstimate(); }
$('ai-scope').onchange = updateAiEstimate; $('ai-run').onclick = runAiExperiment; $('ai-cancel').onclick = () => { aiAbort?.abort(); };
$('ai-image-close').onclick = () => $('ai-image-dialog').close();
$('ai-export').onclick = () => { if (!aiRows.length) return; const csv = Rec.csv(aiRows, aiMeta); save(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `逐像-AI识别-${Date.now()}.csv`); };
checkAiStatus();
