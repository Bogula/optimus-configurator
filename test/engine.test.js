// Engine tests: run with `npm test` or `node --test test/`
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../js/engine.js');

const A = E.DEFAULT_ASSUMPTIONS;
const hw = id => E.HW.find(h => h.id === id);
const model = id => E.MODELS.find(m => m.id === id);
const decodeTps = (h, m, q, k = 1) =>
  1 / E.evalAt({ hw: hw(h), m: model(m), q, k, A }, { isl: 512, osl: 256 }, 1).step;

test('batch-1 decode reproduces the DGX Spark anchors from the runbooks', () => {
  const bf16 = decodeTps('spark', 'apertus-8b', 'bf16');
  const nvfp4 = decodeTps('spark', 'apertus-8b', 'w4');
  const big = decodeTps('spark', 'apertus-70b', 'w4');
  assert.ok(bf16 > 12 && bf16 < 17.1, `8B BF16 ${bf16.toFixed(1)} tok/s, expected 12-17 (ceiling 17.1)`);
  assert.ok(nvfp4 > 22 && nvfp4 < 28, `8B NVFP4 ${nvfp4.toFixed(1)} tok/s, expected 22-28`);
  assert.ok(big > 3.5 && big < 5.7, `70B NVFP4 ${big.toFixed(1)} tok/s, expected 3.5-5.7`);
});

test('RTX PRO 6000 70B NVFP4 is close to the reported 30.7 tok/s', () => {
  const t = decodeTps('rtx6000', 'apertus-70b', 'w4');
  assert.ok(t > 25 && t < 35, `${t.toFixed(1)} tok/s`);
});

test('owned DGX Spark costs about $0.21 per hour', () => {
  const h = E.hourlyCost(hw('spark'), 1, A);
  assert.ok(Math.abs(h - 0.21) < 0.02, `$${h.toFixed(3)}/h`);
});

test('70B BF16 does not fit on a single DGX Spark', () => {
  const R = E.run({ features: ['rag'], multilingual: false, openness: 'any', hosting: 'any',
    longCtx: 131072, peakUsers: 1, reqPerDay: 100, priority: 0.5 });
  const rej = R.rejected.find(r => r.hw === 'spark' && r.mid === 'apertus-70b' && r.q === 'bf16' && r.k === 1);
  assert.equal(rej?.kind, 'memory');
});

test('agentic SLO: Apertus 8B FP8 on one Spark misses 25 tok/s, MoE models pass', () => {
  const R = E.run({ features: ['agentic'], multilingual: false, openness: 'any', hosting: 'any',
    longCtx: 131072, peakUsers: 10, reqPerDay: 3000, priority: 0.6 });
  const miss = R.rejected.find(r => r.hw === 'spark' && r.mid === 'apertus-8b' && r.q === 'fp8' && r.k === 1);
  assert.equal(miss?.kind, 'slo');
  assert.ok(R.all.some(c => c.hw.id === 'spark' && c.m.moe), 'an MoE model fits on the Spark');
});

test('every shortlisted configuration meets every SLO', () => {
  const R = E.run({ features: ['rag', 'summarize'], multilingual: true, openness: 'prefer', hosting: 'any',
    longCtx: 131072, peakUsers: 20, reqPerDay: 5000, priority: 0.5 });
  assert.ok(R.top.length > 0);
  for (const c of R.top) for (const w of c.ws) {
    const b = c.per[w.id].best;
    assert.ok(b.ttft <= w.ttft && b.perUser >= w.tps, `${c.key} ${w.id}`);
  }
});

test('"fully open only" keeps only Apertus', () => {
  const R = E.run({ features: ['rag'], multilingual: false, openness: 'require', hosting: 'any',
    longCtx: 131072, peakUsers: 5, reqPerDay: 1000, priority: 0.5 });
  assert.ok(R.all.length > 0);
  assert.ok(R.all.every(c => c.m.family === 'Apertus'));
});

test('calibration scales the estimate towards the measurement', () => {
  const { cal } = E.calibrate([{ hardware: 'rtx6000', tp: 1, model: 'apertus-70b', quant: 'w4',
    workload: 'agentic', concurrency: 1, tok_s_per_user: 30.7 }], A);
  const f = cal['rtx6000|apertus-70b|w4'].factor;
  assert.ok(f > 1 && f < 1.3, `factor ${f}`);
});
