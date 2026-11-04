(() => {
const E = ENGINE;
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const money = v => v >= 10000 ? '$' + (v/1000).toFixed(0) + 'k' : v >= 1000 ? '$' + (v/1000).toFixed(1) + 'k' : '$' + v.toFixed(0);
const money2 = v => v < 0.1 ? '$' + v.toFixed(3) : v < 10 ? '$' + v.toFixed(2) : '$' + v.toFixed(0);
const sec = v => !isFinite(v) ? '—' : v < 1 ? Math.round(v*1000) + ' ms' : v.toFixed(1) + ' s';
const qLabel = q => E.QUANT[q].short || E.QUANT[q].label;

const PRESETS = [
  { id:'rag', label:'Swiss RAG assistant', features:['rag'], multilingual:true, openness:'prefer', hosting:'any', longCtx:131072, peakUsers:20, reqPerDay:5000, priority:50 },
  { id:'agent', label:'Coding agent', features:['agentic'], multilingual:false, openness:'any', hosting:'any', longCtx:131072, peakUsers:10, reqPerDay:3000, priority:60 },
  { id:'batch', label:'Nightly batch + summaries', features:['batch','summarize'], multilingual:false, openness:'any', hosting:'any', longCtx:131072, peakUsers:4, reqPerDay:200000, priority:20 },
  { id:'long', label:'Sovereign long-document analyst', features:['long','rag'], multilingual:true, openness:'require', hosting:'own', longCtx:131072, peakUsers:5, reqPerDay:500, priority:50 },
];

let A = JSON.parse(JSON.stringify(E.DEFAULT_ASSUMPTIONS));
let CAL = {}, calInfo = null, selectedCell = null;

// ---- Build feature chips
const fbox = $('#features');
for (const [id, f] of Object.entries(E.FEATURES)){
  const shape = id === 'long' ? 'context × 0.75 → 512' : `${f.isl} → ${f.osl}`;
  const slo = f.interactive ? `TTFT ≤ ${f.ttft} s · ≥ ${f.tps} tok/s` : 'no latency SLO';
  const el = document.createElement('label');
  el.className = 'feat';
  el.innerHTML = `<input type="checkbox" id="f-${id}" value="${id}"><span class="nm">${esc(f.label)}</span><span class="sh">${shape} tok · ${slo}</span>`;
  fbox.appendChild(el);
}
// ---- Presets
const pbox = $('#presets');
pbox.innerHTML = '<span class="eyebrow" style="margin-right:4px">Examples</span>' + PRESETS.map(p => `<button type="button" class="preset" data-p="${p.id}" aria-pressed="false">${esc(p.label)}</button>`).join('');
pbox.addEventListener('click', e => { const b = e.target.closest('[data-p]'); if (b){ applyPreset(PRESETS.find(p => p.id === b.dataset.p)); } });

function applyPreset(p){
  for (const id of Object.keys(E.FEATURES)) $('#f-' + id).checked = p.features.includes(id);
  $('#multilingual').checked = p.multilingual;
  $('#op-' + p.openness).checked = true; $('#ho-' + p.hosting).checked = true;
  $('#longCtx').value = String(p.longCtx); $('#peakUsers').value = p.peakUsers; $('#reqPerDay').value = p.reqPerDay;
  $('#priority').value = p.priority;
  selectedCell = null;
  update(p.id);
}
function readInputs(){
  return {
    features: Object.keys(E.FEATURES).filter(id => $('#f-' + id).checked),
    multilingual: $('#multilingual').checked,
    openness: document.querySelector('input[name=openness]:checked')?.value || 'any',
    hosting: document.querySelector('input[name=hosting]:checked')?.value || 'any',
    longCtx: +$('#longCtx').value,
    peakUsers: Math.max(1, +$('#peakUsers').value || 1),
    reqPerDay: Math.max(1, +$('#reqPerDay').value || 1),
    priority: (+$('#priority').value) / 100,
  };
}
$('#form').addEventListener('input', () => { selectedCell = null; update(); });
$('#form').addEventListener('submit', e => e.preventDefault());

function whyBullets(c, inp, R){
  const out = [];
  const parts = c.ws.map(w => {
    const b = c.per[w.id].best;
    return w.interactive ? `${w.label} at ${b.perUser.toFixed(0)} tok/s per user, TTFT ${sec(b.ttft)}` : `${w.label} at ${Math.round(b.outTps + b.inTps).toLocaleString()} tok/s total`;
  });
  out.push(`Meets every SLO: ${parts.join('; ')}.`);
  const bounds = new Set(c.ws.map(w => c.per[w.id].best.bound));
  if (bounds.has('bandwidth')) out.push(`Decode is memory-bandwidth-bound here (${c.hw.bw.toLocaleString()} GB/s${c.k>1?' × '+c.k:''}), so fewer bytes per weight translate directly into tokens/s.`);
  if (c.m.moe) out.push(`MoE with ${c.m.active}B active of ${c.m.P}B total: decode reads only the active experts, which is why it runs fast on this hardware.`);
  if (inp.multilingual && c.m.cap.multilingual >= 5) out.push('Top multilingual rating in the catalogue, including Swiss German and Romansh coverage.');
  if (c.m.open >= 5) out.push('Fully open: weights, training data and recipes are published (Apache-2.0).');
  if (c.hw.tested && c.m.tested) out.push('This hardware and model pair was run in the ApertusOptimus study.');
  const best = R.top[0];
  if (c === best && R.top[1]) out.push(`Ranks above ${R.top[1].m.name} on ${R.top[1].hw.name} on the combined quality, cost and latency score.`);
  if (c.calibrated) out.push('Throughput is calibrated with your measured results.');
  return out;
}

function cardHTML(c, i, inp, R, open){
  const tags = [];
  if (c.hw.tested && c.m.tested) tags.push('<span class="tag t-acc">tested</span>');
  if (c.calibrated) tags.push('<span class="tag t-acc">calibrated</span>');
  tags.push(`<span class="tag">${qLabel(c.q)}</span>`);
  tags.push(`<span class="tag">${c.gpus} GPU${c.gpus>1?'s':''}${c.k>1?' · TP'+c.k:''}${c.groups>1?' · '+c.groups+' replicas':''}</span>`);
  tags.push(`<span class="tag">${c.hw.cost.mode === 'own' ? 'owned' : 'rented'}</span>`);
  if (!c.m.trt) tags.push('<span class="tag t-warn">no TRT-LLM</span>');
  const scorePct = Math.round(Math.max(0, Math.min(1, c.score)) * 100);
  const rows = c.ws.map(w => {
    const b = c.per[w.id].best;
    return `<tr><td>${esc(w.label)}</td><td class="n">${w.isl.toLocaleString()} → ${w.osl}</td><td class="n">${b.B}</td><td class="n">${b.perUser.toFixed(0)}</td><td class="n">${sec(b.ttft)}</td><td class="n">${b.rps.toFixed(2)}</td><td>${b.bound}</td></tr>`;
  }).join('');
  const watch = [...c.hw.watch, ...c.m.watch];
  const ins = E.insights(c, inp);
  const cmd = E.serveCommand(c, inp);
  return `<details class="card" ${open?'open':''} data-key="${c.key}">
    <summary>
      <span class="rank">${i != null ? String(i+1).padStart(2,'0') : '··'}</span>
      <span class="cname">${esc(c.m.name)}<span class="sub">${c.gpus > 1 ? c.gpus + '× ' : ''}${esc(c.hw.name)} · ${esc(c.hw.chip)}</span></span>
      <span class="tags">${tags.join('')}</span>
      <span class="cell"><b>${money(c.monthly)}</b><small>per month</small></span>
      <span class="cell c2"><b>${money2(c.perM)}</b><small>per 1M tokens</small></span>
      <span class="score"><div class="bar"><i style="width:${scorePct}%"></i></div><small>fit ${scorePct} · Q ${Math.round(c.quality*100)}</small></span>
    </summary>
    <div class="body">
      <div><h3>Why it fits</h3><ul>${whyBullets(c, inp, R).map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>
      <div><h3>Watch out for</h3><ul>${watch.map(x => `<li>${esc(x)}</li>`).join('') || '<li class="muted">Nothing specific to this pair.</li>'}</ul></div>
      <div class="full"><div class="tblwrap"><table>
        <thead><tr><th>Workload</th><th class="n">ISL → OSL</th><th class="n">Conc. / replica</th><th class="n">tok/s / user</th><th class="n">TTFT</th><th class="n">req/s / replica</th><th>Bound by</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
        <p class="muted" style="font-size:12px;margin:6px 0 0">Concurrency is the highest load per replica that still meets the SLO (the knee of the ladder). Weights ${c.wGB.toFixed(1)} GB, KV budget ${c.kvBudget.toFixed(0)} GB, max model length ${E.fmtCtx(c.maxLen)}. ${c.hw.cost.mode==='own' ? 'Capex ' + money(c.capex) + ' amortised over ' + A.years + ' years plus power.' : 'Rented at ' + money2(c.hourly / c.gpus) + ' per GPU-hour.'} Utilisation at this volume: ~${Math.round(c.util*100)}%.</p></div>
      ${ins.length ? `<div class="full"><h3>Next steps</h3><ul>${ins.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
      <div class="full"><div class="cmdhead"><h3>Starting point for vLLM</h3><button type="button" class="btn" data-copy="${c.key}">Copy</button></div><pre class="cmd" id="cmd-${c.key.replace(/[^a-z0-9]/gi,'_')}">${esc(cmd)}</pre></div>
    </div>
  </details>`;
}

function matrixHTML(R, inp){
  const byHM = {};
  for (const c of R.all){ const k = c.hw.id + '|' + c.m.id; if (!byHM[k] || c.score > byHM[k].score) byHM[k] = c; }
  const rejHM = {};
  for (const r of R.rejected){ const k = r.hw + '|' + r.mid; (rejHM[k] = rejHM[k] || []).push(r); }
  const scores = Object.values(byHM).map(c => c.score);
  const lo = Math.min(...scores), hi = Math.max(...scores);
  const reasonShort = rs => {
    const kinds = new Set(rs.map(r => r.kind));
    if (kinds.has('slo')) return 'misses SLO';
    if (kinds.has('kv')) return 'no KV room';
    if (kinds.has('memory')) return 'too large';
    if (kinds.has('context')) return 'context';
    return '—';
  };
  const head = E.MODELS.map(m => `<th>${esc(m.name.replace('Apertus 1.5','Apertus'))}</th>`).join('');
  const body = E.HW.map(h => {
    const filteredHw = (inp.hosting === 'own' && h.cost.mode !== 'own') || (inp.hosting === 'rent' && h.cost.mode !== 'rent');
    const cells = E.MODELS.map(m => {
      const k = h.id + '|' + m.id, c = byHM[k];
      if (filteredHw || (inp.openness === 'require' && m.open < 5)) return `<td><span class="mc nofit" title="Excluded by your constraints">filtered</span></td>`;
      if (c){
        const s = hi > lo ? (c.score - lo) / (hi - lo) : 1;
        return `<td><button type="button" class="mc fit ${s > .7 ? 'hi':''} ${selectedCell===c.key?'sel':''}" style="--s:${s.toFixed(2)}" data-cell="${c.key}" title="${esc(c.m.name + ' ' + qLabel(c.q) + ' on ' + c.gpus + '× ' + c.hw.name + ' — fit ' + Math.round(c.score*100))}">${money(c.monthly)}<small>${qLabel(c.q)} · ${c.gpus} GPU</small></button></td>`;
      }
      const rs = rejHM[k] || [];
      const tip = rs.map(r => r.name + ': ' + r.why).join('\n') || 'Not evaluated';
      return `<td><span class="mc nofit" title="${esc(tip)}">✕<small>${reasonShort(rs)}</small></span></td>`;
    }).join('');
    return `<tr><td class="rowh"><b>${esc(h.name)}</b><br><span class="muted" style="font-size:12px">${h.bw.toLocaleString()} GB/s · ${h.memGB} GB</span></td>${cells}</tr>`;
  }).join('');
  return `<div class="tblwrap"><table class="matrix"><thead><tr><th class="rowh">Hardware</th>${head}</tr></thead><tbody>${body}</tbody></table></div>
    <div class="legend"><span>Cell: cheapest monthly cost that meets every SLO, best quantisation and GPU count. Darker is a better fit.</span><span>✕ hover for the reason.</span></div>`;
}

function update(presetId){
  const inp = readInputs();
  document.querySelectorAll('.preset').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.p === presetId)));
  $('#ctxWrap').hidden = !inp.features.includes('long');
  try { localStorage.setItem('optimus-inputs', JSON.stringify(inp)); } catch(e){}
  const out = $('#out');
  if (!inp.features.length){ out.innerHTML = '<div class="empty">Select at least one workload on the left to see hardware and model recommendations.</div>' + assumptionsHTML(); bindAssumptions(); return; }

  const R = E.run(inp, A, CAL);
  const best = R.top[0];
  let html = '';
  if (!best){
    html += `<div class="verdict"><div class="eyebrow">No configuration fits</div><div class="pick">Nothing in the catalogue meets these SLOs.</div>
      <div class="callout warn">Try a shorter context window, relax the openness or hosting constraint, or drop the most demanding workload. Hover the ✕ cells in the matrix below for the reason each pair fails.</div></div>`;
  } else {
    const perReqApi = best.apiMonth / (inp.reqPerDay * 30);
    const breakEvenDay = best.monthly / (perReqApi * 30);
    const apiCheaper = best.apiMonth < best.monthly;
    html += `<div class="verdict">
      <div><div class="eyebrow">Best fit for ${inp.features.map(f => E.FEATURES[f].label.toLowerCase()).join(' + ')}</div>
      <div class="pick">${esc(best.m.name)} <span>${qLabel(best.q)}</span> on ${best.gpus > 1 ? best.gpus + '× ' : ''}${esc(best.hw.name)}</div></div>
      <div class="kpis">
        <div class="kpi"><small>Monthly cost</small><b>${money(best.monthly)}</b><small>${best.hw.cost.mode==='own'?'amortised capex + power':'rented, always on'}</small></div>
        <div class="kpi"><small>Blended cost</small><b>${money2(best.perM)}</b><small>per 1M tokens at your volume</small></div>
        <div class="kpi"><small>Token API, same volume</small><b>${money(best.apiMonth)}</b><small>at $${A.apiIn}/$${A.apiOut} per 1M in/out</small></div>
        <div class="kpi"><small>Break-even volume</small><b>${Math.round(breakEvenDay).toLocaleString()}</b><small>requests per day</small></div>
      </div>
      ${apiCheaper
        ? `<div class="callout warn">At ${inp.reqPerDay.toLocaleString()} requests a day a token API is cheaper. Self-hosting wins above ~${Math.round(breakEvenDay).toLocaleString()} requests a day, or earlier if data residency, auditability or rate limits matter more than price.</div>`
        : `<div class="callout good">At ${inp.reqPerDay.toLocaleString()} requests a day self-hosting is ${(best.apiMonth / best.monthly).toFixed(1)}× cheaper than the token API comparator.</div>`}
    </div>`;
    html += `<section><div class="sechead"><h2>Shortlist</h2><span class="muted">${R.all.length} configurations meet the SLOs · ${R.rejected.length} rejected</span></div>
      <div class="cards">${R.top.map((c, i) => cardHTML(c, i, inp, R, i === 0)).join('')}</div></section>`;
  }
  html += `<section><div class="sechead"><h2>Fit matrix</h2><span class="muted">Click a cell to inspect it</span></div>${matrixHTML(R, inp)}<div id="cellDetail" style="margin-top:10px"></div></section>`;
  html += `<section><details class="panel"><summary>Why not the others? (${R.rejected.length})</summary><div class="in"><ul class="rej">${R.rejected.map(r => `<li><b>${esc(r.name)}</b>: ${esc(r.why)}</li>`).join('')}</ul></div></details></section>`;
  html += assumptionsHTML();
  out.innerHTML = html;

  out.querySelectorAll('[data-cell]').forEach(b => b.addEventListener('click', () => {
    selectedCell = b.dataset.cell;
    out.querySelectorAll('.mc.sel').forEach(x => x.classList.remove('sel')); b.classList.add('sel');
    const c = R.all.find(x => x.key === selectedCell);
    $('#cellDetail').innerHTML = c ? cardHTML(c, null, inp, R, true) : '';
    bindCopy();
  }));
  if (selectedCell){ const c = R.all.find(x => x.key === selectedCell); if (c) $('#cellDetail').innerHTML = cardHTML(c, null, inp, R, true); }
  bindCopy(); bindAssumptions();
}

function bindCopy(){
  document.querySelectorAll('[data-copy]').forEach(b => b.onclick = async e => {
    e.preventDefault();
    const pre = b.closest('.full').querySelector('pre');
    try { await navigator.clipboard.writeText(pre.textContent); b.textContent = 'Copied'; }
    catch(err){ const r = document.createRange(); r.selectNodeContents(pre); const s = getSelection(); s.removeAllRanges(); s.addRange(r); b.textContent = 'Selected, press Ctrl+C'; }
    setTimeout(() => b.textContent = 'Copy', 1600);
  });
}

function assumptionsHTML(){
  const f = (id, label, val, step) => `<label>${label}<input id="${id}" type="number" step="${step}" value="${val}" class="mono"></label>`;
  const capRows = E.MODELS.map(m => `<tr><td>${esc(m.name)}</td><td class="n">${m.moe ? m.active + ' / ' + m.P : m.P}</td><td class="n">${E.fmtCtx(m.ctx)}</td>${['rag','summarize','agentic','reasoning','multilingual'].map(k => `<td class="n">${m.cap[k]}</td>`).join('')}<td class="n">${m.open}</td><td>${m.trt ? 'yes' : '<span class="no">no</span>'}</td><td>${esc(m.license)}</td></tr>`).join('');
  const hwRows = E.HW.map(h => `<tr><td>${esc(h.name)}</td><td class="n">${h.memGB}</td><td class="n">${h.bw.toLocaleString()}</td><td class="n">${h.tf.bf16} / ${h.tf.fp8} / ${h.tf.fp4 ?? '—'}</td><td>${esc(h.link)}</td><td class="n">${money2(E.hourlyCost(h, 1, A))}</td><td>${h.tested ? 'yes' : ''}</td></tr>`).join('');
  return `<section><details class="panel" id="assPanel"><summary>Assumptions and prices</summary><div class="in">
    <p class="muted" style="margin:0">All prices are placeholders, like <span class="mono">prices.json</span> with <span class="mono">verified: false</span>. Replace them with sourced numbers before quoting a result.</p>
    <div class="ass">
      ${f('a-h100nvl','H100 NVL, $ per GPU-hour',A.hourly.h100nvl,0.1)}
      ${f('a-h200','H200, $ per GPU-hour',A.hourly.h200,0.1)}
      ${f('a-b200','B200, $ per GPU-hour',A.hourly.b200,0.1)}
      ${f('a-spark','DGX Spark capex, $',A.capex.spark,100)}
      ${f('a-rtx6000','RTX PRO 6000 capex per card, $',A.capex.rtx6000,100)}
      ${f('a-kwh','Electricity, per kWh',A.kwh,0.01)}
      ${f('a-pue','PUE',A.pue,0.05)}
      ${f('a-years','Amortisation, years',A.years,1)}
      ${f('a-apiIn','Token API, $ per 1M input',A.apiIn,0.05)}
      ${f('a-apiOut','Token API, $ per 1M output',A.apiOut,0.05)}
      ${f('a-bwEff','Achieved bandwidth fraction',A.bwEff,0.05)}
      ${f('a-mfu','Prefill MFU',A.prefillMfu,0.05)}
    </div>
    <div class="tblwrap"><table><thead><tr><th>Hardware</th><th class="n">GB</th><th class="n">GB/s</th><th class="n">TFLOPS bf16/fp8/fp4</th><th>Interconnect</th><th class="n">$ / GPU-h</th><th>Tested</th></tr></thead><tbody>${hwRows}</tbody></table></div>
  </div></details></section>
  <section><details class="panel" id="calPanel"><summary>Calibrate with measured results</summary><div class="in">
    <p class="prose" style="margin:0">Paste rows from your AIPerf sweeps. Each row scales the decode estimate for that hardware, model and quantisation (geometric mean of measured ÷ estimated). Use the ids shown in the catalogue below.</p>
    <pre class="cmd">hardware,tp,model,quant,workload,concurrency,tok_s_per_user
spark,1,apertus-8b,w4,agentic,1,24.6
h100nvl,1,apertus-8b,fp8,rag,32,48.0</pre>
    <label for="calText" class="muted" style="font-size:12.5px">Measured rows (CSV with the header above)</label>
    <textarea id="calText" rows="5" class="mono" placeholder="hardware,tp,model,quant,workload,concurrency,tok_s_per_user"></textarea>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button type="button" class="btn primary" id="calApply">Apply calibration</button><button type="button" class="btn" id="calClear">Clear</button><span class="muted" id="calMsg">${calInfo ? esc(calInfo) : 'No measurements applied. Estimates come from bandwidth and FLOP ceilings.'}</span></div>
    <p class="muted" style="margin:0;font-size:12.5px">Ids: hardware ${E.HW.map(h => '<span class="mono">'+h.id+'</span>').join(', ')} · models ${E.MODELS.map(m => '<span class="mono">'+m.id+'</span>').join(', ')} · quant <span class="mono">bf16, fp8, w4, mxfp4</span> · workload <span class="mono">rag, summarize, agentic, batch</span></p>
  </div></details></section>
  <section><details class="panel"><summary>Method and model catalogue</summary><div class="in prose" style="max-width:none">
    <div class="prose">
    <p><b>Workloads.</b> Each feature maps to a workload shape from <span class="mono">bench/scenarios.json</span> (input → output tokens) with a latency SLO. A mix is split evenly across the selected features. Large context adds a workload at 75% of the chosen window and sets <span class="mono">--max-model-len</span> for the whole deployment.</p>
    <p><b>Fit.</b> Weights plus KV cache for one full-length sequence must fit in usable memory (70% of the Spark's unified 128 GB, 90% of HBM elsewhere). The model's context limit must cover the window.</p>
    <p><b>Speed.</b> Decode step = max(bytes read ÷ achieved bandwidth, FLOPs ÷ compute) + 2 ms. Bytes read are the weights (only touched experts for MoE) plus the KV cache of every active sequence. Prefill is compute-bound, including the quadratic attention term. Prefill and decode share the GPU, so time spent prefilling slows every stream. The ladder climbs concurrency until the SLO breaks and keeps the knee. Anchors from the runbooks: Spark 8B BF16 ≈ 13 tok/s (measured ceiling 17), 8B NVFP4 ≈ 24 (expected 22–28), 70B NVFP4 ≈ 4.5; RTX PRO 6000 70B NVFP4 ≈ 28 (reported 30.7).</p>
    <p><b>Cost.</b> Replicas cover the larger of peak concurrency and daily volume (50% target utilisation for interactive, 85% for batch). Owned hardware = capex ÷ amortisation + power × PUE; rented = GPU-hours, always on. Blended $/1M uses input and output tokens at each workload's real ratio.</p>
    <p><b>Ranking.</b> Fit score = quality × w<sub>Q</sub> + cost × w<sub>C</sub> + latency headroom × 0.15 − deployment risk. The priority slider moves weight between quality and cost; cost is scored on a log scale. Risk covers sm_12x kernel gaps, linked Sparks and missing TensorRT-LLM support. Quality ratings below are indicative judgements for ranking, not benchmark scores: edit them in the source once you have evals.</p>
    </div>
    <div class="tblwrap"><table><thead><tr><th>Model</th><th class="n">Params B</th><th class="n">Context</th><th class="n">RAG</th><th class="n">Summ.</th><th class="n">Agentic</th><th class="n">Reason.</th><th class="n">Multiling.</th><th class="n">Openness</th><th>TRT-LLM</th><th>Licence</th></tr></thead><tbody>${capRows}</tbody></table></div>
  </div></details></section>`;
}

function bindAssumptions(){
  const map = { 'a-h100nvl':v=>A.hourly.h100nvl=v, 'a-h200':v=>A.hourly.h200=v, 'a-b200':v=>A.hourly.b200=v, 'a-spark':v=>A.capex.spark=v, 'a-rtx6000':v=>A.capex.rtx6000=v,
    'a-kwh':v=>A.kwh=v, 'a-pue':v=>A.pue=v, 'a-years':v=>A.years=Math.max(1,v), 'a-apiIn':v=>A.apiIn=v, 'a-apiOut':v=>A.apiOut=v, 'a-bwEff':v=>A.bwEff=Math.min(1,Math.max(0.2,v)), 'a-mfu':v=>A.prefillMfu=Math.min(1,Math.max(0.05,v)) };
  for (const [id, set] of Object.entries(map)){
    const el = document.getElementById(id); if (!el) continue;
    el.onchange = () => { const v = parseFloat(el.value); if (isFinite(v) && v >= 0){ set(v); keepOpen(() => update()); } };
  }
  const ap = $('#calApply'), cl = $('#calClear');
  if (ap) ap.onclick = () => {
    const txt = $('#calText').value.trim();
    const lines = txt.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2){ $('#calMsg').textContent = 'Add the header line and at least one row.'; return; }
    const hdr = lines[0].split(',').map(s => s.trim());
    const rows = lines.slice(1).map(l => { const v = l.split(','); const o = {}; hdr.forEach((h, i) => o[h] = (v[i] ?? '').trim()); o.tp = +o.tp || 1; o.concurrency = +o.concurrency || 1; o.tok_s_per_user = +o.tok_s_per_user; return o; });
    const res = E.calibrate(rows, A);
    CAL = res.cal;
    calInfo = `Applied ${res.used.length} row${res.used.length===1?'':'s'} to ${Object.keys(CAL).length} configuration${Object.keys(CAL).length===1?'':'s'}` + (res.skipped.length ? `; skipped ${res.skipped.length} with unknown ids or values.` : '.');
    keepOpen(() => update(), txt);
  };
  if (cl) cl.onclick = () => { CAL = {}; calInfo = null; keepOpen(() => update(), ''); };
}
function keepOpen(fn, calText){
  const openA = $('#assPanel')?.open, openC = $('#calPanel')?.open, txt = calText ?? $('#calText')?.value;
  fn();
  if (openA) $('#assPanel').open = true; if (openC) $('#calPanel').open = true;
  if (txt != null && $('#calText')) $('#calText').value = txt;
}

// ---- Boot: last inputs or the first preset
let saved = null;
try { saved = JSON.parse(localStorage.getItem('optimus-inputs') || 'null'); } catch(e){}
if (saved && Array.isArray(saved.features)){
  applyPreset({ ...PRESETS[0], ...saved, priority: Math.round((saved.priority ?? .5) * 100), id:null });
} else applyPreset(PRESETS[0]);
})();
