# Optimus Configurator — design

The configurator turns *desired features* into ranked **hardware × LLM × precision** recommendations, using what the ApertusOptimus study learned about serving Apertus 1.5 on a DGX Spark and on H100 NVL GPUs.

## 1. Inputs

| Group | Inputs |
|---|---|
| Workloads (multi-select) | RAG chatbot, Summarization, Agentic / tools, Batch / offline, Large context (32k–256k window) |
| Load | Peak concurrent requests, requests per day |
| Constraints | Swiss languages matter; model openness (any / prefer fully open / fully open only); hosting (any / own / rented) |
| Priority | Slider: lowest cost ↔ best quality |

## 2. Feature → workload shape + SLO

The shapes match the benchmark scenarios used in the study, so the app speaks the same language as the AIPerf sweeps. An SLO (service level objective) is the latency target a configuration has to meet.

| Feature | Input → output tokens | TTFT p95 | Min tok/s per user | Reserved context | Bottleneck |
|---|---|---|---|---|---|
| RAG chatbot | 4096 → 256 | 2 s | 15 | 8k | prefill |
| Summarization | 8000 → 200 | 10 s | 8 | 16k | prefill |
| Agentic / tools | 1024 → 1024 | 3 s | 25 | 32k | decode |
| Batch / offline | 1024 → 128 | none | none | 4k | throughput |
| Large context | 0.75 × window → 512 | 60 s | 8 | window | memory |

A mix is split evenly across the selected features; the largest reserved context sets `--max-model-len` for the deployment.

## 3. Catalogue

- **Hardware:** DGX Spark (tested), H100 NVL (tested), RTX PRO 6000 Blackwell, H200, B200. Each with memory, bandwidth, BF16/FP8/FP4 TFLOPS, tensor-parallel sizes and efficiency, cost basis (owned capex + power vs. rented $/GPU-hour), deployment risk, and watch-outs from the study.
- **Models:** Apertus 1.5 8B / 70B (tested), plus Llama 3.1 8B / 3.3 70B, Qwen3 30B-A3B (MoE) / 32B, Mistral Small 3.2 24B, gpt-oss 20B / 120B (MoE, MXFP4). Each with layers, KV heads and head dimension (for KV-cache sizing), active parameters (MoE), max context, precision options, TensorRT-LLM availability, openness, and **indicative** capability ratings (to be replaced with eval results).

## 4. Estimation engine

1. **Fit:** weights + KV cache for one full-length sequence ≤ usable memory (Spark: 70% of the unified 128 GB; HBM: 90%). Context ≤ the model's maximum.
2. **Decode step:** max(bytes read ÷ (bandwidth × 0.8 × TP efficiency), FLOPs ÷ compute) + 2 ms. Bytes = weights (MoE: only the touched experts, 1 − (1 − k/E)^B) + the KV cache of all active sequences.
3. **Prefill:** compute-bound, 2·P·ISL plus the quadratic attention term, at 45% MFU.
4. **Sharing:** prefill and decode share the GPU. A fixed-point solve gives the prefill time fraction *u*; TTFT = prefill ÷ (1 − u), per-user rate = (1 − u) ÷ step.
5. **Ladder:** concurrency climbs 1 → 512; the highest level that still meets the SLO (the knee) is kept.
6. **Anchors reproduced:** Spark 8B BF16 ≈ 13 tok/s (ceiling 17), 8B NVFP4 ≈ 24 (expected 22–28), 70B NVFP4 ≈ 4.5; RTX PRO 6000 70B NVFP4 ≈ 28 (reported 30.7). `test/engine.test.js` checks these.
7. **Calibration:** paste measured rows (`hardware,tp,model,quant,workload,concurrency,tok_s_per_user`); the geometric mean of measured ÷ estimated scales decode speed for that combination.

## 5. Sizing and cost

- Replicas = max(peak concurrency ÷ knee concurrency, daily volume ÷ capacity at 50% utilisation for interactive / 85% for batch), summed over workloads.
- Owned: capex ÷ 3 years + watts × 0.28 per kWh × PUE 1.2. Rented: $/GPU-hour × 730 h. All prices are placeholders and editable in the app.
- Blended $/1M tokens at each workload's real input/output ratio, compared with a token API, plus the **break-even** volume in requests per day.

## 6. Ranking

score = w_Q · quality + w_C · cost + 0.15 · latency headroom − risk

- Priority slider: w_Q 0.25 → 0.75, w_C 0.60 → 0.15. Cost on a log scale (100× pricier → 0).
- Risk: sm_12x kernel gaps (Spark, RTX PRO), linked Sparks, no TensorRT-LLM support.
- Shortlist: cheapest TP size per hardware/model/precision, one precision per hardware + model, ≤ 2 per model, ≤ 3 per hardware, top 6.

## 7. Output per recommendation

Why it fits · watch-outs from the study · per-workload table (concurrency per replica, tok/s per user, TTFT, req/s, bound by) · next steps (Dynamo disaggregation for ≥ 2 GPUs on prefill-heavy mixes, prefix caching for RAG, quality gate after quantisation, the thinking-mode / tool-calling caveat for Apertus) · a vLLM start command (TP, max-model-len, max-num-seqs, gpu-memory-utilization, FP8 KV cache, Apertus chat-template flag, fastsafetensors on the Spark). Plus a hardware × model fit matrix and a "why not the others" list.

## 8. Next iterations

1. Load benchmark result files automatically and match them to catalogue ids.
2. Replace indicative quality ratings with eval scores (multilingual, tool use, long-context needle tests).
3. Per-feature traffic shares instead of an even split; Dynamo disaggregated configurations as first-class candidates.
4. Verify and source every price; add hosted-Apertus and frontier API comparators.
