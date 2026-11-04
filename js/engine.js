/* ===== Optimus Configurator — estimation engine (no DOM) ===== */
const ENGINE = (() => {

// ---- Hardware catalog. Prices are placeholders (verified:false) and editable in the UI.
const HW = [
  { id:'spark', name:'DGX Spark', chip:'GB10', memGB:128, usable:0.70, bw:273,
    tf:{bf16:125, fp8:250, fp4:500}, tp:[1,2], tpEff:{1:1, 2:0.6}, link:'200 GbE (ConnectX-7)',
    cost:{mode:'own', capexPerGPU:4000, capexBase:0, wattsPerGPU:180, wattsBase:0},
    tested:true, risk:0.05, arch:'sm_121',
    watch:[
      'Decode is bandwidth-bound at 273 GB/s: strong on summarize (prefill), weak on chat and agentic (decode).',
      'The official Apertus arm64 container may lack sm_121 kernels. Run the 20-second arch probe before pulling weights.',
      'Unified memory: keep --gpu-memory-utilization modest (0.3 to 0.65) or the host starves.',
      'Low-precision failure here is fluent nonsense, not a crash. The smoke test is a mandatory gate.'
    ]},
  { id:'h100nvl', name:'H100 NVL', chip:'GH100, 94 GB', memGB:94, usable:0.90, bw:3900,
    tf:{bf16:835, fp8:1670, fp4:null}, tp:[1,2], tpEff:{1:1, 2:0.85}, link:'NVLink bridge (pairs)',
    cost:{mode:'rent', hourly:3.00},
    tested:true, risk:0.0, arch:'sm_90',
    watch:[
      'No FP4 tensor cores: 4-bit runs weight-only (Marlin). FP8 weights + KV is the biggest lever on Hopper.',
      'Check nvidia-smi topo -m: without NV# links, run independent replicas instead of TP=2.'
    ]},
  { id:'rtx6000', name:'RTX PRO 6000', chip:'Blackwell, 96 GB', memGB:96, usable:0.90, bw:1792,
    tf:{bf16:500, fp8:1000, fp4:2000}, tp:[1,2,4], tpEff:{1:1, 2:0.75, 4:0.6}, link:'PCIe Gen5',
    cost:{mode:'own', capexPerGPU:8500, capexBase:5000, wattsPerGPU:600, wattsBase:250},
    tested:false, risk:0.03, arch:'sm_120',
    watch:[
      'sm_120 shares the GB10 kernel gaps: confirm your vLLM build ships Blackwell-consumer kernels.',
      'PCIe only: prefer replicas over tensor parallelism whenever the model fits on one card.'
    ]},
  { id:'h200', name:'H200', chip:'141 GB HBM3e', memGB:141, usable:0.90, bw:4800,
    tf:{bf16:989, fp8:1979, fp4:null}, tp:[1,2,4,8], tpEff:{1:1, 2:0.88, 4:0.8, 8:0.72}, link:'NVLink / NVSwitch',
    cost:{mode:'rent', hourly:3.80},
    tested:false, risk:0.0, arch:'sm_90',
    watch:['Fits 70B in FP8 on one GPU with room for KV cache: often cheaper than TP=2 on smaller cards.']},
  { id:'b200', name:'B200', chip:'180 GB HBM3e', memGB:180, usable:0.90, bw:8000,
    tf:{bf16:2250, fp8:4500, fp4:9000}, tp:[1,2,4,8], tpEff:{1:1, 2:0.88, 4:0.8, 8:0.72}, link:'NVLink 5',
    cost:{mode:'rent', hourly:5.50},
    tested:false, risk:0.0, arch:'sm_100',
    watch:['Over-provisioned for an 8B model unless you have very high concurrency.']},
];

// ---- Model catalog. Capability ratings are indicative (0-5), not benchmarks.
// moe: {E experts, k active, expertB = total params inside experts (B)}
const MODELS = [
  { id:'apertus-8b', name:'Apertus 1.5 8B', family:'Apertus', P:8.05, active:8.05, L:32, kvh:8, hd:128, d:4096, ctx:262144,
    quants:['bf16','fp8','w4'], wOverride:{w4:8.6}, open:5, license:'Apache-2.0, open data', trt:false, tested:true,
    repo:{bf16:'swiss-ai/Apertus-v1.5-8B', fp8:'swiss-ai/Apertus-v1.5-8B', w4:'onprem-ai/Apertus-v1.5-8B-NVFP4'},
    cap:{rag:3, summarize:3, agentic:2, reasoning:2, multilingual:5, general:3},
    watch:['No TensorRT-LLM path (ApertusForCausalLM is not in the registry): NIM falls back to vLLM/SGLang.',
           'Tool calling is unsupported in thinking mode.',
           'xIELU may fall back to a Python implementation without the fused kernel: a throughput tax.']},
  { id:'apertus-70b', name:'Apertus 1.5 70B', family:'Apertus', P:70.6, active:70.6, L:80, kvh:8, hd:128, d:8192, ctx:262144,
    quants:['bf16','fp8','w4'], wOverride:{w4:48}, open:5, license:'Apache-2.0, open data', trt:false, tested:true,
    repo:{bf16:'swiss-ai/Apertus-v1.5-70B', fp8:'swiss-ai/Apertus-v1.5-70B', w4:'<Apertus-v1.5-70B NVFP4 checkpoint>'},
    cap:{rag:4, summarize:4, agentic:3, reasoning:4, multilingual:5, general:4},
    watch:['No TensorRT-LLM path: NIM falls back to vLLM/SGLang.',
           'Tool calling is unsupported in thinking mode.',
           '$/1M tokens versus 8B is usually much worse than the 8.75x parameter ratio.']},
  { id:'llama-8b', name:'Llama 3.1 8B', family:'Llama', P:8.03, active:8.03, L:32, kvh:8, hd:128, d:4096, ctx:131072,
    quants:['bf16','fp8','w4'], open:2, license:'Llama community licence', trt:true,
    repo:{bf16:'meta-llama/Llama-3.1-8B-Instruct', fp8:'meta-llama/Llama-3.1-8B-Instruct', w4:'<4-bit AWQ/NVFP4 checkpoint>'},
    cap:{rag:3, summarize:3, agentic:3, reasoning:2, multilingual:3, general:3},
    watch:['Has a TRT-LLM NIM profile: the reference point for what Apertus loses without one.']},
  { id:'llama-70b', name:'Llama 3.3 70B', family:'Llama', P:70.6, active:70.6, L:80, kvh:8, hd:128, d:8192, ctx:131072,
    quants:['bf16','fp8','w4'], open:2, license:'Llama community licence', trt:true,
    repo:{bf16:'meta-llama/Llama-3.3-70B-Instruct', fp8:'meta-llama/Llama-3.3-70B-Instruct', w4:'<4-bit AWQ/NVFP4 checkpoint>'},
    cap:{rag:4, summarize:4, agentic:4, reasoning:3, multilingual:3, general:4}, watch:[]},
  { id:'qwen3-30b-a3b', name:'Qwen3 30B-A3B', family:'Qwen', P:30.5, active:3.3, moe:{E:128,k:8,expertB:29.0}, L:48, kvh:4, hd:128, d:2048, ctx:262144,
    quants:['bf16','fp8','w4'], open:3, license:'Apache-2.0', trt:true,
    repo:{bf16:'Qwen/Qwen3-30B-A3B-Instruct-2507', fp8:'Qwen/Qwen3-30B-A3B-Instruct-2507-FP8', w4:'<4-bit checkpoint>'},
    cap:{rag:4, summarize:4, agentic:4, reasoning:4, multilingual:4, general:4},
    watch:['MoE: 3.3B active parameters make decode fast on bandwidth-poor boxes, but all 30B must fit in memory.']},
  { id:'qwen3-32b', name:'Qwen3 32B', family:'Qwen', P:32.8, active:32.8, L:64, kvh:8, hd:128, d:5120, ctx:131072,
    quants:['bf16','fp8','w4'], open:3, license:'Apache-2.0', trt:true,
    repo:{bf16:'Qwen/Qwen3-32B', fp8:'Qwen/Qwen3-32B-FP8', w4:'<4-bit checkpoint>'},
    cap:{rag:4, summarize:4, agentic:4, reasoning:5, multilingual:4, general:4},
    watch:['Native window is 32k; beyond that needs YaRN rope scaling.']},
  { id:'mistral-24b', name:'Mistral Small 3.2 24B', family:'Mistral', P:24.0, active:24.0, L:40, kvh:8, hd:128, d:5120, ctx:131072,
    quants:['bf16','fp8','w4'], open:3, license:'Apache-2.0', trt:true,
    repo:{bf16:'mistralai/Mistral-Small-3.2-24B-Instruct-2506', fp8:'mistralai/Mistral-Small-3.2-24B-Instruct-2506', w4:'<4-bit checkpoint>'},
    cap:{rag:4, summarize:4, agentic:4, reasoning:3, multilingual:4, general:4}, watch:[]},
  { id:'gpt-oss-20b', name:'gpt-oss 20B', family:'gpt-oss', P:21, active:3.6, moe:{E:32,k:4,expertB:19.9}, L:24, kvh:8, hd:64, d:2880, ctx:131072, kvFactor:0.55,
    quants:['mxfp4'], open:3, license:'Apache-2.0', trt:true,
    repo:{mxfp4:'openai/gpt-oss-20b'},
    cap:{rag:3, summarize:3, agentic:4, reasoning:4, multilingual:3, general:3},
    watch:['Ships natively in MXFP4; needs the harmony chat format.']},
  { id:'gpt-oss-120b', name:'gpt-oss 120B', family:'gpt-oss', P:117, active:5.1, moe:{E:128,k:4,expertB:115.5}, L:36, kvh:8, hd:64, d:2880, ctx:131072, kvFactor:0.55,
    quants:['mxfp4'], open:3, license:'Apache-2.0', trt:true,
    repo:{mxfp4:'openai/gpt-oss-120b'},
    cap:{rag:4, summarize:4, agentic:5, reasoning:5, multilingual:3, general:4},
    watch:['Ships natively in MXFP4; needs the harmony chat format.']},
];

const QUANT = {
  bf16: {label:'BF16', bpp:2.0,  compute:'bf16', kvB:2, qpen:0.00},
  fp8:  {label:'FP8',  bpp:1.05, compute:'fp8',  kvB:1, qpen:0.02},
  w4:   {label:'4-bit (NVFP4/W4A16)', short:'NVFP4', bpp:0.60, compute:'bf16', kvB:2, qpen:0.05},
  mxfp4:{label:'MXFP4 (native)', short:'MXFP4', bpp:0.53, compute:'bf16', kvB:2, qpen:0.00},
};

// ---- Workload shapes (ISL/OSL from bench/scenarios.json) and SLOs.
const FEATURES = {
  rag:       {label:'RAG chatbot',     isl:4096, osl:256,  ttft:2.0,  tps:15, reserve:8192,  interactive:true,
              capKey:['rag'], bottleneck:'prefill'},
  summarize: {label:'Summarization',   isl:8000, osl:200,  ttft:10.0, tps:8,  reserve:16384, interactive:true,
              capKey:['summarize'], bottleneck:'prefill'},
  agentic:   {label:'Agentic / tools', isl:1024, osl:1024, ttft:3.0,  tps:25, reserve:32768, interactive:true,
              capKey:['agentic','reasoning'], bottleneck:'decode'},
  batch:     {label:'Batch / offline', isl:1024, osl:128,  ttft:Infinity, tps:0, reserve:4096, interactive:false,
              capKey:['general'], bottleneck:'throughput'},
  long:      {label:'Large context',   isl:null, osl:512,  ttft:60.0, tps:8,  reserve:null, interactive:true,
              capKey:['summarize'], bottleneck:'memory'},
};

const DEFAULT_ASSUMPTIONS = {
  kwh:0.28, pue:1.2, years:3, bwEff:0.80, prefillMfu:0.45, decodeMfu:0.5, stepOverhead:0.002,
  apiIn:0.60, apiOut:0.60, hours:730,
  hourly:{h100nvl:3.00, h200:3.80, b200:5.50},
  capex:{spark:4000, rtx6000:8500},
};

const B_LADDER = [1,2,3,4,6,8,12,16,24,32,48,64,96,128,192,256,384,512];

function hourlyCost(hw, k, A){
  if (hw.cost.mode === 'rent') return (A.hourly[hw.id] ?? hw.cost.hourly) * k;
  const capexGPU = A.capex[hw.id] ?? hw.cost.capexPerGPU;
  const capex = capexGPU * k + hw.cost.capexBase;
  const watts = hw.cost.wattsPerGPU * k + hw.cost.wattsBase;
  return capex / (A.years * 8760) + watts / 1000 * A.kwh * A.pue;
}
function capexOf(hw, k, A){
  if (hw.cost.mode === 'rent') return 0;
  return (A.capex[hw.id] ?? hw.cost.capexPerGPU) * k + hw.cost.capexBase;
}

function weightsGB(m, q){
  if (m.wOverride && m.wOverride[q] != null) return m.wOverride[q];
  return m.P * QUANT[q].bpp;
}
function weightsReadGB(m, q, B){
  const total = weightsGB(m, q);
  if (!m.moe) return total;
  const perB = total / m.P; // GB per B params
  const shared = m.P - m.moe.expertB;
  const touched = 1 - Math.pow(1 - m.moe.k / m.moe.E, B);
  return perB * (shared + m.moe.expertB * touched);
}
function kvBytesPerToken(m, q){
  return 2 * m.L * m.kvh * m.hd * QUANT[q].kvB * (m.kvFactor || 1);
}

// Evaluate one serving group (k GPUs, TP=k) for one workload at concurrency B.
function evalAt(ctx, w, B){
  const {hw, m, q, k, A, cal} = ctx;
  const eff = hw.tpEff[k] ?? 0.7;
  const bwEff = hw.bw * k * A.bwEff * eff * (cal || 1);           // GB/s
  const cdt = QUANT[q].compute;
  const tf = (hw.tf[cdt] ?? hw.tf.bf16) * 1e12 * k * eff;          // FLOP/s
  const kvTok = kvBytesPerToken(m, q);
  const ctxAvg = w.isl + w.osl / 2;
  const tBw = (weightsReadGB(m, q, B) + B * kvTok * ctxAvg / 1e9) / bwEff;
  const tC = 2 * m.active * 1e9 * B / (tf * A.decodeMfu);
  const step = Math.max(tBw, tC) + A.stepOverhead;
  const attn = 2 * m.L * m.d * w.isl * w.isl;                      // causal attention FLOPs
  const prefill = (2 * m.active * 1e9 * w.isl + attn) / (tf * A.prefillMfu);
  // Prefill and decode share the GPU. Solve for u = fraction of time spent prefilling:
  // W = per-request wall time, rps = B / W, u = rps * prefill.
  let u = 0, perUser = 0, wall = 0, rps = 0;
  for (let i = 0; i < 40; i++){
    perUser = (1 - u) / step;
    wall = prefill / (1 - u) + w.osl / perUser;
    rps = B / wall;
    const nu = Math.min(0.99, rps * prefill);
    if (Math.abs(nu - u) < 1e-5){ u = nu; break; }
    u = 0.5 * u + 0.5 * nu;
  }
  if (u >= 0.95) return null;
  const ttft = prefill / (1 - u);
  return { B, ttft, perUser, rps, outTps: rps * w.osl, inTps: rps * w.isl, step, prefill,
           bound: tBw >= tC ? 'bandwidth' : 'compute' };
}

function evalWorkload(ctx, w, maxB){
  let best = null, first = null;
  const ladder = B_LADDER.filter(b => b <= maxB);
  if (maxB > 0 && !ladder.includes(maxB) && maxB < 512) ladder.push(maxB);
  for (const B of ladder){
    const r = evalAt(ctx, w, B);
    if (!r) break;
    if (!first) first = r;
    const ok = r.ttft <= w.ttft && r.perUser >= w.tps;
    if (ok && (!best || r.rps > best.rps)) best = r;
    if (!ok && best && w.interactive) break;
  }
  return { best, atOne: first, sloMet: !!best };
}

function workloadsFor(inp){
  const ws = [];
  for (const f of inp.features){
    const base = FEATURES[f];
    if (f === 'long'){
      const isl = Math.round(inp.longCtx * 0.75);
      ws.push({ ...base, id:f, isl, reserve: inp.longCtx });
    } else ws.push({ ...base, id:f });
  }
  return ws;
}

function qualityFor(m, q, inp){
  const keys = [];
  for (const f of inp.features) keys.push(...FEATURES[f].capKey);
  if (inp.multilingual) keys.push('multilingual', 'multilingual');
  let s = keys.length ? keys.reduce((a, k) => a + (m.cap[k] ?? 3), 0) / keys.length / 5 : 0.6;
  if (inp.openness === 'prefer') s += (m.open - 3) * 0.04;
  return Math.min(1, Math.max(0, s - QUANT[q].qpen));
}

function run(inp, A = DEFAULT_ASSUMPTIONS, calibration = {}){
  const ws = workloadsFor(inp);
  const maxLen = Math.max(...ws.map(w => w.reserve), 4096);
  const share = 1 / ws.length;
  const candidates = [], rejected = [];

  for (const hw of HW){
    if (inp.hosting === 'own' && hw.cost.mode !== 'own') continue;
    if (inp.hosting === 'rent' && hw.cost.mode !== 'rent') continue;
    if (inp.hwFilter && inp.hwFilter.length && !inp.hwFilter.includes(hw.id)) continue;
    for (const m of MODELS){
      if (inp.openness === 'require' && m.open < 5) continue;
      for (const q of m.quants){
        // pick the smallest TP size where it fits; also consider the next size up
        let fittedOnce = false;
        for (const k of hw.tp){
          const key = `${hw.id}|${m.id}|${q}`;
          const cal = calibration[key]?.factor;
          const ctx = { hw, m, q, k, A, cal };
          const usable = hw.memGB * hw.usable * k;
          const wGB = weightsGB(m, q);
          const kvBudget = usable - wGB - (2 + 0.05 * usable);
          const name = `${m.name} ${QUANT[q].short || QUANT[q].label} on ${k}x ${hw.name}`;
          if (maxLen > m.ctx){ rejected.push({name, hw:hw.id, mid:m.id, q, k, kind:'context', why:`needs ${fmtCtx(maxLen)} context, model max is ${fmtCtx(m.ctx)}`}); break; }
          if (kvBudget <= 0){ rejected.push({name, hw:hw.id, mid:m.id, q, k, kind:'memory', why:`weights ${wGB.toFixed(0)} GB exceed ~${usable.toFixed(0)} GB usable`}); continue; }
          const kvTok = kvBytesPerToken(m, q);
          const seqFull = kvBudget * 1e9 / (kvTok * maxLen);
          if (seqFull < 1){ rejected.push({name, hw:hw.id, mid:m.id, q, k, kind:'kv', why:`KV cache for one ${fmtCtx(maxLen)} sequence needs ${(kvTok*maxLen/1e9).toFixed(0)} GB, ${kvBudget.toFixed(0)} GB left`}); continue; }

          const per = {}; let sloAll = true, groupsNeed = 0, maxSeqsUsed = 1;
          for (const w of ws){
            const maxB = Math.max(1, Math.floor(kvBudget * 1e9 / (kvTok * (w.isl + w.osl))));
            const r = evalWorkload(ctx, w, Math.min(maxB, 512));
            per[w.id] = { ...r, maxB };
            if (!r.sloMet){ sloAll = false; continue; }
            maxSeqsUsed = Math.max(maxSeqsUsed, r.best.B);
            const reqDay = inp.reqPerDay * share;
            const volGroups = reqDay / (r.best.rps * 86400 * (w.interactive ? 0.5 : 0.85));
            const concGroups = w.interactive ? (inp.peakUsers * share) / r.best.B : 0;
            groupsNeed += Math.max(volGroups, concGroups);
          }
          if (!sloAll){
            const miss = ws.filter(w => !per[w.id].sloMet).map(w => {
              const a = per[w.id].atOne;
              if (!a) return `${w.label}: prefill saturates`;
              return `${w.label}: ${a.perUser.toFixed(0)} tok/s, TTFT ${a.ttft.toFixed(1)} s at 1 user`;
            });
            rejected.push({name, hw:hw.id, mid:m.id, q, k, kind:'slo', why:`misses SLO (${miss.join('; ')})`});
            continue;
          }
          fittedOnce = true;
          const groups = Math.max(1, Math.ceil(groupsNeed - 1e-9));
          const gpus = groups * k;
          const hourly = hourlyCost(hw, k, A) * groups;
          const monthly = hourly * A.hours;
          const capex = capexOf(hw, k, A) * groups;
          let tokMonth = 0, apiMonth = 0;
          for (const w of ws){
            const reqM = inp.reqPerDay * share * 30;
            tokMonth += reqM * (w.isl + w.osl);
            apiMonth += reqM * (w.isl * A.apiIn + w.osl * A.apiOut) / 1e6;
          }
          // GPU-time actually needed vs provisioned
          let busy = 0;
          for (const w of ws){ busy += (inp.reqPerDay * share) / (per[w.id].best.rps * 86400); }
          const util = Math.min(1, busy / groups);
          const lat = ws.filter(w => w.interactive).map(w => {
            const b = per[w.id].best;
            return Math.min(1, Math.max(0, (b.perUser / w.tps - 1) / 2)) * 0.5 + Math.min(1, Math.max(0, 1 - b.ttft / w.ttft)) * 0.5;
          });
          candidates.push({
            key:`${hw.id}|${m.id}|${q}|${k}`, hw, m, q, k, groups, gpus, hourly, monthly, capex,
            perM: tokMonth ? monthly / tokMonth * 1e6 : 0, tokMonth, apiMonth, util,
            quality: qualityFor(m, q, inp), latency: lat.length ? lat.reduce((a,b)=>a+b,0)/lat.length : 0.5,
            per, ws, maxLen, maxSeqs: maxSeqsUsed, kvBudget, wGB, calibrated: !!cal,
          });
        }
      }
    }
  }

  // Scores
  const minMonthly = Math.min(...candidates.map(c => c.monthly));
  const p = inp.priority; // 0 = cost, 1 = quality
  const wQ = 0.25 + 0.5 * p, wC = 0.6 - 0.45 * p, wL = 0.15;
  for (const c of candidates){
    c.costScore = Math.max(0, 1 - Math.log10(c.monthly / minMonthly) / 2);   // 100x pricier -> 0
    c.risk = c.hw.risk + (c.m.trt ? 0 : 0.02) + (c.k > 1 && c.hw.id === 'spark' ? 0.05 : 0);
    c.score = wQ * c.quality + wC * c.costScore + wL * c.latency - c.risk;
  }
  candidates.sort((a, b) => b.score - a.score);

  // Per hw|model|quant keep the cheapest TP size that meets the SLOs (ties -> higher score)
  const bestOf = {};
  for (const c of candidates){
    const k = `${c.hw.id}|${c.m.id}|${c.q}`, b = bestOf[k];
    if (!b || c.monthly < b.monthly - 1e-6 || (Math.abs(c.monthly - b.monthly) < 1e-6 && c.score > b.score)) bestOf[k] = c;
  }
  const dedup = Object.values(bestOf).sort((a, b) => b.score - a.score);
  // Diversify the shortlist: one quant per hw+model, max 2 per model, max 3 per hardware
  const top = [], seenHM = new Set(), perModel = {}, perHw = {};
  for (const c of dedup){
    const hm = c.hw.id + '|' + c.m.id;
    if (seenHM.has(hm) || (perModel[c.m.id] || 0) >= 2 || (perHw[c.hw.id] || 0) >= 3) continue;
    seenHM.add(hm); top.push(c);
    perModel[c.m.id] = (perModel[c.m.id] || 0) + 1; perHw[c.hw.id] = (perHw[c.hw.id] || 0) + 1;
    if (top.length >= 6) break;
  }
  return { ws, maxLen, all: dedup, top, rejected, weights:{wQ, wC, wL} };
}

function fmtCtx(n){ return n >= 1024 ? Math.round(n / 1024) + 'k' : String(n); }

function serveCommand(c, inp){
  const repo = c.m.repo[c.q] || c.m.repo.bf16;
  const lines = [`vllm serve ${repo}`];
  if (c.k > 1) lines.push(`  --tensor-parallel-size ${c.k}`);
  lines.push(`  --max-model-len ${c.maxLen}`);
  lines.push(`  --max-num-seqs ${Math.max(4, c.maxSeqs)}`);
  const util = c.hw.id === 'spark' ? Math.min(0.65, Math.max(0.3, (c.wGB + 20) / 128)).toFixed(2) : '0.92';
  lines.push(`  --gpu-memory-utilization ${util}`);
  if (c.q === 'fp8' && !/FP8/i.test(repo)) lines.push(`  --quantization fp8`);
  if (c.q === 'fp8') lines.push(`  --kv-cache-dtype fp8`);
  if (inp.features.includes('rag') || inp.features.includes('agentic')) lines.push(`  --enable-prefix-caching`);
  if (c.m.family === 'Apertus') lines.push(`  --chat-template-content-format string`);
  if (c.hw.id === 'spark') lines.push(`  --load-format fastsafetensors`);
  return lines.join(' \\\n');
}

function insights(c, inp){
  const out = [];
  const hasPrefill = inp.features.some(f => ['rag','summarize','long'].includes(f));
  if (c.gpus >= 2 && hasPrefill) out.push('With 2+ GPUs on a prefill-heavy mix, test Dynamo disaggregated prefill/decode against an aggregated deployment with the same GPU count.');
  if (inp.features.includes('rag')) out.push('Enable prefix caching: a shared system prompt and repeated chunks make RAG the biggest winner.');
  if (c.q === 'w4' || c.q === 'fp8') out.push('Re-run the quality gate (arithmetic, German, French, instruction following) after every quantization change.');
  if (c.m.family === 'Apertus' && inp.features.includes('agentic')) out.push('Agentic use relies on tool calling, which Apertus does not support in thinking mode. Serve with thinking off.');
  if (c.maxLen >= 65536) out.push(`KV cache is preallocated: --max-model-len ${c.maxLen} costs concurrency. Serve a separate short-context instance for the other workloads if traffic allows.`);
  if (c.util < 0.25) out.push(`Provisioned capacity is only ~${Math.round(c.util*100)}% busy at this volume. A token API may be cheaper until volume grows.`);
  return out;
}

function calibrate(rows, A = DEFAULT_ASSUMPTIONS){
  // rows: {hardware, tp, model, quant, workload, concurrency, tok_s_per_user}
  const acc = {}, used = [], skipped = [];
  for (const r of rows){
    const hw = HW.find(h => h.id === r.hardware), m = MODELS.find(x => x.id === r.model);
    const w = FEATURES[r.workload];
    if (!hw || !m || !w || !m.quants.includes(r.quant) || !(r.tok_s_per_user > 0)){ skipped.push(r); continue; }
    const k = r.tp || 1, B = Math.max(1, r.concurrency || 1);
    const wl = { ...w, isl: w.isl || 65536 };
    const est = evalAt({ hw, m, q:r.quant, k, A }, wl, B);
    if (!est){ skipped.push(r); continue; }
    const key = `${hw.id}|${m.id}|${r.quant}`;
    (acc[key] = acc[key] || []).push(r.tok_s_per_user / est.perUser);
    used.push({ ...r, est: est.perUser });
  }
  const cal = {};
  for (const [k, v] of Object.entries(acc)){
    const f = Math.exp(v.reduce((a, b) => a + Math.log(b), 0) / v.length);  // geometric mean
    cal[k] = { factor: Math.min(3, Math.max(0.2, f)), n: v.length };
  }
  return { cal, used, skipped };
}

return { calibrate, HW, MODELS, QUANT, FEATURES, DEFAULT_ASSUMPTIONS, run, serveCommand, insights, evalAt, weightsGB, kvBytesPerToken, hourlyCost, fmtCtx };
})();
if (typeof module !== 'undefined') module.exports = ENGINE;
