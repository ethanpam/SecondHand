# Laya runtime spike

Date: 2026-09-27 · Branch: `spike-37` · Issue #37 (epic #36)

## Question

Can the fine-tuned Laya checkpoint from #41 run as an int8 ONNX model on the CPU? It has to be small, fast enough for a 20-question form page, and as accurate as the MLX model it was trained and evaluated with.

## Summary

- **Size: passes.** The int8 export is 425.1 MB (405.4 MiB), under the 600 MB limit. The float export is 1,688.2 MB.
- **Accuracy:**
  - The float ONNX export matches MLX. The two runtimes fill the same decisions at every threshold, except 1 of 78 matching decisions at 0.95 and 2 of 368 answering decisions at 0.992.
  - The int8 export is close to MLX, but not the same. 0.7% to 0.9% of rows move by more than 0.05; the largest move is 0.875. At the high thresholds that precision needs, int8 fills fewer questions than MLX.
- **Precision ≥ 0.95: passes only at high thresholds:** 0.996 for answering and 0.99 or higher for matching (0.992 chosen). These thresholds were chosen on the same two sets they are reported on. At 0.95, int8 precision is 0.769 for answering and 0.899 for matching on the test split.
- **Latency: fails by 30×.**
  - One 20-question page of a real form is 390 candidate rows. It takes 14.8 s at p50 and 15.0 s at p95 with int8 on the M4 Max CPU. The limit is 500 ms.
  - Float takes 16.5 s and 16.9 s.
  - Windows was not measured.
- **Runtime:** onnxruntime-node, in the utility process that #38 forks from Electron's main process. The int8 file #38 ships (`exports/runtime-38`) has the same SHA-256 as the int8 file measured here.
- **Go / no-go: no-go on #37's criteria.** Latency fails. Size passes. Precision passes only at the thresholds above. The rules-miss coverage criterion was not measured.

## Method

**Model.** LayaStudio run `augmented-lora-proper-1790472969`, fine-tuned from `aac6fef/laya-mlx` at revision `20aed815fc6acde75733882e7ec0e3f28aeb9717`:
- base: the English `laya` (ModernBERT-large encoder plus a 2-layer decision head, 428.5M parameters);
- training: LoRA rank 16 plus 4 fully trained layers, `proper` objective, 1 epoch, bfloat16;
- calibration temperature for its one question type (`noul`, 2 options): 1.5465.

**Exports.**
- Both come from LayaStudio's exporter (commands below): the PyTorch dynamo exporter, opset 18, with batch, tokens and options left dynamic. The README that LayaStudio writes next to the export says opset 17, but the graph says 18.
- The int8 file is onnxruntime `quantize_dynamic`: int8 weights on the MatMuls (`MatMulConstBOnly`).
- Activations stay float. Each call quantizes them again (`DynamicQuantizeLinear`), with one scale per tensor for the whole batch. So an int8 row's result depends a little on the other rows in its batch (see Agreement).

**Data.** Two datasets built by `ML_model/dataset/build.cjs`, scored on their test split. The test split holds real forms only, split by form.

| Set | Build flags | Scored | Answering | Matching |
|---|---|---|---|---|
| Test split | `--today 2026-09-26 --households 2000 --seed 7 --per-question 24` | every test form | 2,016 decisions, 10,944 rows | 169 decisions, 4,394 rows |
| Holdout forms | `--today 2026-09-26 --households 400 --seed 11 --per-question 8` | `--holdout`: the 7 forms marked holdout | 368 decisions, 1,752 rows | 78 decisions, 2,028 rows |

Every row asks the same `noul` question about one candidate: "Given the facts about the household, is the candidate the correct answer to the form question?"
- Answering rows are about 262 tokens (at most 334), because they carry the facts sheet. Matching rows are about 70 tokens (at most 130).
- `ML_model/eval/decisions.py` groups the rows back into form questions (decisions).
- A decision is **filled** with its best candidate when that candidate's probability is at or above the threshold and above the probability of "None of these, or the facts don't say". Otherwise it is left for the applicant.
- **Precision** = right fills ÷ all fills. **Coverage** = right fills ÷ answerable decisions.

**Runtimes.**
- **MLX** (the baseline): laya-mlx on the GPU in bfloat16, the precision the model was trained in. One row per call.
- **ONNX**: onnxruntime 1.30.0 in Python, `CPUExecutionProvider`, 8 intra-op threads.
  - `ML_model/eval/onnx_score.py` builds each prompt with laya-mlx's own `build_sequence`.
  - It pads 16 rows at a time with laya-mlx's `collate_items` and runs one `session.run` per batch.
  - It applies the same clamped temperature as laya-mlx.
  - It prints progress every 500 rows. Scoring the whole test split took 5,107 s (answering) plus 406 s (matching) while other jobs shared the CPU.
- `--probs` rebuilds a report from the per-row probabilities saved with each report. The committed reports were rebuilt this way after thresholds 0.992 and 0.996 were added, and their probabilities are identical to the scoring runs'.

**Agreement.** For every row, the absolute difference between two runtimes' probabilities. The table reports:
- the share of rows that differ by more than 0.05;
- the largest difference;
- how many decisions the two runtimes fill differently at a threshold.

**Latency and memory.** `ML_model/eval/latency_onnx.py` scores one real page:
- the Utica Food Pantry intake form (a holdout form), household 0, its first 20 questions in form order;
- that is 6 choice questions (3 to 8 candidates each) and 14 text boxes (26 candidates each), 390 rows in all.

Each run builds the prompts, pads them, and runs the model through onnxruntime on the CPU. The main configuration is the one #38 uses: 8 rows per call and onnxruntime's default thread count.

The script records:
- first load: the session load plus the first page;
- the 50th and 95th percentiles of 30 more pages (nearest rank), with the 1-minute load average before each page;
- the process's peak resident memory, and the memory before the model loads.

**Machine and load.**
- MacBook Pro, Apple M4 Max (14 CPU cores: 10 performance, 4 efficiency), 36 GB, macOS 26.5.2.
- Accuracy runs shared the machine with a #41 MLX training run on the GPU and with other agents' CPU jobs. The 1-minute load was 12 to 66.
- The latency runs in the table started when the 1-minute load was under 4. The only exception is the batch-16 run, which started right after the previous run ended.
- The load average also counts the benchmark's own onnxruntime threads (one per core by default). This is why it rises to 5 to 9 during a run.
- One earlier int8 run overlapped an MLX evaluation on the GPU. It is reported separately.
- **Windows x64 was not measured:** no Windows machine was available.

## Sizes and checksums

| File | Bytes | SHA-256 |
|---|---|---|
| int8 `model.onnx` | 3,820,399 | `dd1658b67f562804d579f2ff64f94a89d4a3d9bd71144e8158c48cd8bd0eccd7` |
| int8 `model.onnx.data` | 421,294,080 | `67e86c975d31d065fe41dc533d46f832b9b89ff6d2913826792f00fb715caad8` |
| float `model.onnx` | 4,020,635 | `7436b0e0ca3c4f66bd8ecc2cca7a7611a075615c3585e8f92fc2ffa51a9b5746` |
| float `model.onnx.data` | 1,684,144,128 | `3866314a73250aa69fd84c0b8faf419eb270a8eb59f85d3bb6bf42f73aba9923` |
| `tokenizer/tokenizer.json` (both) | 3,583,228 | `6c8aaa9a542084f2457eab775d4eeb51f92a70c0fd9de28d5edb0ddec3c08d30` |
| `rl_agent_config.json` (both) | 1,019 | `c60d46e60fbc282b74697fff8c1c2feb0ccbe4bad56d952edb37fc8c4d8bd1e9` |

| Model | Graph + weights | Whole export folder | gzip -6 of graph + weights |
|---|---|---|---|
| MLX checkpoint (bfloat16 safetensors) | 842.6 MB | | |
| ONNX float | 1,688.2 MB (1,610.0 MiB) | 1,691.8 MB | |
| ONNX int8 | 425.1 MB (405.4 MiB) | 428.7 MB | 282.1 MB |

`<LayaStudio>/workspace/exports/runtime-38`, the export #38 pins, has the same `model.onnx` and `model.onnx.data` SHA-256 as the int8 export above.

## Results

### MLX bfloat16 vs ONNX int8, test split

*Answer: 2,016 decisions, 164 answerable.*

| Threshold | MLX fills | MLX wrong | MLX precision | MLX coverage | int8 fills | int8 wrong | int8 precision | int8 coverage |
|---|---|---|---|---|---|---|---|---|
| 0.5 | 186 | 46 | 0.753 | 0.854 | 183 | 48 | 0.738 | 0.823 |
| 0.7 | 185 | 45 | 0.757 | 0.854 | 182 | 47 | 0.742 | 0.823 |
| 0.8 | 184 | 44 | 0.761 | 0.854 | 181 | 46 | 0.746 | 0.823 |
| 0.9 | 180 | 40 | 0.778 | 0.854 | 179 | 44 | 0.754 | 0.823 |
| 0.95 | 177 | 38 | 0.785 | 0.848 | 169 | 39 | 0.769 | 0.793 |
| 0.98 | 166 | 32 | 0.807 | 0.817 | 153 | 31 | 0.797 | 0.744 |
| 0.99 | 120 | 18 | 0.850 | 0.622 | 108 | 20 | 0.815 | 0.537 |
| 0.992 | 98 | 13 | 0.867 | 0.518 | 90 | 12 | 0.867 | 0.476 |
| 0.995 | 63 | 2 | 0.968 | 0.372 | 54 | 3 | 0.944 | 0.311 |
| 0.996 | 42 | 0 | 1.000 | 0.256 | 35 | 0 | 1.000 | 0.213 |

*Match: 169 decisions, 82 answerable.*

| Threshold | MLX fills | MLX wrong | MLX precision | MLX coverage | int8 fills | int8 wrong | int8 precision | int8 coverage |
|---|---|---|---|---|---|---|---|---|
| 0.5 | 90 | 16 | 0.822 | 0.902 | 92 | 18 | 0.804 | 0.902 |
| 0.7 | 89 | 15 | 0.831 | 0.902 | 92 | 18 | 0.804 | 0.902 |
| 0.8 | 87 | 15 | 0.828 | 0.878 | 91 | 18 | 0.802 | 0.890 |
| 0.9 | 84 | 12 | 0.857 | 0.878 | 85 | 13 | 0.847 | 0.878 |
| 0.95 | 79 | 8 | 0.899 | 0.866 | 79 | 8 | 0.899 | 0.866 |
| 0.98 | 66 | 5 | 0.924 | 0.744 | 66 | 5 | 0.924 | 0.744 |
| 0.99 | 50 | 3 | 0.940 | 0.573 | 47 | 2 | 0.957 | 0.549 |
| 0.992 | 47 | 2 | 0.957 | 0.549 | 40 | 1 | 0.975 | 0.476 |
| 0.995 | 38 | 1 | 0.974 | 0.451 | 34 | 1 | 0.971 | 0.402 |
| 0.996 | 37 | 1 | 0.973 | 0.439 | 27 | 1 | 0.963 | 0.317 |

### MLX bfloat16 vs ONNX int8, holdout forms

*Answer: 368 decisions, 17 answerable.*

| Threshold | MLX fills | MLX wrong | MLX precision | MLX coverage | int8 fills | int8 wrong | int8 precision | int8 coverage |
|---|---|---|---|---|---|---|---|---|
| 0.5 | 25 | 9 | 0.640 | 0.941 | 24 | 10 | 0.583 | 0.824 |
| 0.7 | 25 | 9 | 0.640 | 0.941 | 24 | 10 | 0.583 | 0.824 |
| 0.8 | 25 | 9 | 0.640 | 0.941 | 24 | 10 | 0.583 | 0.824 |
| 0.9 | 24 | 8 | 0.667 | 0.941 | 24 | 10 | 0.583 | 0.824 |
| 0.95 | 24 | 8 | 0.667 | 0.941 | 23 | 9 | 0.609 | 0.824 |
| 0.98 | 21 | 5 | 0.762 | 0.941 | 19 | 5 | 0.737 | 0.824 |
| 0.99 | 13 | 1 | 0.923 | 0.706 | 10 | 0 | 1.000 | 0.588 |
| 0.992 | 9 | 0 | 1.000 | 0.529 | 7 | 0 | 1.000 | 0.412 |
| 0.995 | 6 | 0 | 1.000 | 0.353 | 6 | 0 | 1.000 | 0.353 |
| 0.996 | 6 | 0 | 1.000 | 0.353 | 6 | 0 | 1.000 | 0.353 |

*Match: 78 decisions, 47 answerable.*

| Threshold | MLX fills | MLX wrong | MLX precision | MLX coverage | int8 fills | int8 wrong | int8 precision | int8 coverage |
|---|---|---|---|---|---|---|---|---|
| 0.5 | 48 | 7 | 0.854 | 0.872 | 50 | 9 | 0.820 | 0.872 |
| 0.7 | 48 | 7 | 0.854 | 0.872 | 50 | 9 | 0.820 | 0.872 |
| 0.8 | 46 | 7 | 0.848 | 0.830 | 49 | 9 | 0.816 | 0.851 |
| 0.9 | 45 | 6 | 0.867 | 0.830 | 46 | 7 | 0.848 | 0.830 |
| 0.95 | 43 | 5 | 0.884 | 0.809 | 44 | 6 | 0.864 | 0.809 |
| 0.98 | 32 | 3 | 0.906 | 0.617 | 32 | 3 | 0.906 | 0.617 |
| 0.99 | 22 | 1 | 0.955 | 0.447 | 22 | 1 | 0.955 | 0.447 |
| 0.992 | 21 | 1 | 0.952 | 0.426 | 19 | 0 | 1.000 | 0.404 |
| 0.995 | 18 | 0 | 1.000 | 0.383 | 16 | 0 | 1.000 | 0.340 |
| 0.996 | 18 | 0 | 1.000 | 0.383 | 14 | 0 | 1.000 | 0.298 |

### ONNX float vs ONNX int8, holdout forms

*Answer: 368 decisions, 17 answerable.*

| Threshold | float fills | float wrong | float precision | float coverage | int8 fills | int8 wrong | int8 precision | int8 coverage |
|---|---|---|---|---|---|---|---|---|
| 0.5 | 25 | 9 | 0.640 | 0.941 | 24 | 10 | 0.583 | 0.824 |
| 0.7 | 25 | 9 | 0.640 | 0.941 | 24 | 10 | 0.583 | 0.824 |
| 0.8 | 25 | 9 | 0.640 | 0.941 | 24 | 10 | 0.583 | 0.824 |
| 0.9 | 24 | 8 | 0.667 | 0.941 | 24 | 10 | 0.583 | 0.824 |
| 0.95 | 24 | 8 | 0.667 | 0.941 | 23 | 9 | 0.609 | 0.824 |
| 0.98 | 21 | 5 | 0.762 | 0.941 | 19 | 5 | 0.737 | 0.824 |
| 0.99 | 13 | 1 | 0.923 | 0.706 | 10 | 0 | 1.000 | 0.588 |
| 0.992 | 9 | 0 | 1.000 | 0.529 | 7 | 0 | 1.000 | 0.412 |
| 0.995 | 6 | 0 | 1.000 | 0.353 | 6 | 0 | 1.000 | 0.353 |
| 0.996 | 6 | 0 | 1.000 | 0.353 | 6 | 0 | 1.000 | 0.353 |

*Match: 78 decisions, 47 answerable.*

| Threshold | float fills | float wrong | float precision | float coverage | int8 fills | int8 wrong | int8 precision | int8 coverage |
|---|---|---|---|---|---|---|---|---|
| 0.5 | 48 | 7 | 0.854 | 0.872 | 50 | 9 | 0.820 | 0.872 |
| 0.7 | 48 | 7 | 0.854 | 0.872 | 50 | 9 | 0.820 | 0.872 |
| 0.8 | 46 | 7 | 0.848 | 0.830 | 49 | 9 | 0.816 | 0.851 |
| 0.9 | 45 | 6 | 0.867 | 0.830 | 46 | 7 | 0.848 | 0.830 |
| 0.95 | 42 | 5 | 0.881 | 0.787 | 44 | 6 | 0.864 | 0.809 |
| 0.98 | 32 | 3 | 0.906 | 0.617 | 32 | 3 | 0.906 | 0.617 |
| 0.99 | 22 | 1 | 0.955 | 0.447 | 22 | 1 | 0.955 | 0.447 |
| 0.992 | 21 | 1 | 0.952 | 0.426 | 19 | 0 | 1.000 | 0.404 |
| 0.995 | 18 | 0 | 1.000 | 0.383 | 16 | 0 | 1.000 | 0.340 |
| 0.996 | 18 | 0 | 1.000 | 0.383 | 14 | 0 | 1.000 | 0.298 |

### Agreement

| Comparison | Task | Rows | Rows differing by more than 0.05 | Largest difference | Decisions filled differently at 0.5 / 0.95 / 0.992 / 0.996 |
|---|---|---|---|---|---|
| int8 vs MLX, test split | answer | 10,944 | 0.72% | 0.875 | 13 / 16 / 10 / 7 of 2,016 |
| int8 vs MLX, test split | match | 4,394 | 0.80% | 0.458 | 2 / 4 / 7 / 12 of 169 |
| int8 vs MLX, holdout | answer | 1,752 | 0.74% | 0.778 | 3 / 3 / 2 / 0 of 368 |
| int8 vs MLX, holdout | match | 2,028 | 0.89% | 0.458 | 2 / 3 / 2 / 4 of 78 |
| float vs MLX, holdout | answer | 1,752 | 0.17% | 0.124 | 0 / 0 / 2 / 0 of 368 |
| float vs MLX, holdout | match | 2,028 | 0.00% | 0.040 | 0 / 1 / 0 / 0 of 78 |
| float vs int8, holdout | answer | 1,752 | 0.68% | 0.740 | 3 / 3 / 2 / 0 of 368 |
| float vs int8, holdout | match | 2,028 | 0.74% | 0.442 | 2 / 2 / 2 / 4 of 78 |
| int8 batch 1 vs batch 16, first 20 holdout decisions per task | answer | 64 | 0.00% | 0.002 | 0 / 0 / 0 / 0 of 20 |
| int8 batch 1 vs batch 16, first 20 holdout decisions per task | match | 520 | 0.00% | 0.036 | 1 / 2 / 0 / 0 of 20 |

The int8 rows that moved most are "None of these" and yes/no candidates on household-size and veteran questions. For example, on "Veteran Status:" the "None of these" row is 0.21 with MLX and 0.99 with int8.

Batch size changes int8 results a little, because activation scales are per batch. In the sample above, batch 1 and batch 16 differ by at most 0.036. #38 fixes its batch size at 8 for this reason (`desktop/laya.cjs`).

### Holdout caveat

The holdout answering precision is lower than the test split's partly because of the answer key, not the model. The key says "facts don't say" for three questions on the Perry Road Baptist Church form (rule `none`). For two of them the facts do settle the answer; the key can't express it.

- "Are there other members in your household in addition to yourself?" is Yes whenever the household has 2 or more people.
- "Does your household have more than 8 members?" is No for a household of 5.
- "Are there other members in your household in addition to those already listed?" is the third. It depends on how many members the page already lists, so "facts don't say" is right there.

Wrong fills at threshold 0.9:

| Runtime | Wrong fills | "In addition to yourself?" = Yes, household of 2+ (correct) | "More than 8 members?" = No, household of 5 (correct) | "In addition to those already listed?" = Yes | Precision counting the correct ones as right |
|---|---|---|---|---|---|
| MLX | 8 | 4 | 0 | 4 | 0.833 (20/24) |
| ONNX float | 8 | 4 | 0 | 4 | 0.833 (20/24) |
| ONNX int8 | 10 | 5 | 1 | 4 | 0.833 (20/24) |

At the chosen answering threshold (0.996), none of these are filled by any runtime.

### Latency and memory (20-question page, 390 rows, CPU)

| Run | Rows per call | Threads | 1-min load before | 1-min load during | Session load | First page | First load | p50 | p95 | Min–max | Memory before model | Peak memory |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **int8** (as #38 runs it) | 8 | default | 3.56 | 5.36–8.12 | 466 ms | 15,436 ms | 15.9 s | 14,760 ms | 15,043 ms | 14,666–15,205 ms | 85 MB | 1,646 MB |
| float | 8 | default | 3.93 | 4.86–8.75 | 2,008 ms | 17,300 ms | 19.3 s | 16,530 ms | 16,935 ms | 16,021–16,951 ms | 85 MB | 2,669 MB |
| int8 | 16 | 8 | 9.95 | 8.65–11.18 | 415 ms | 16,347 ms | 16.8 s | 16,270 ms | 16,612 ms | 16,081–18,128 ms | 85 MB | 2,774 MB |
| int8, during an MLX job on the GPU | 8 | default | 1.61 | 4.68–13.65 | 1,023 ms | 34,472 ms | 35.5 s | 16,660 ms | 59,765 ms | 15,047–59,912 ms | 85 MB | 1,569 MB |

- A candidate row costs about 38 ms with int8 (14.76 s ÷ 390).
- 14 of the page's 20 questions are text boxes with 26 candidates each, so they make up 364 of the 390 rows.
- int8 is 11% faster than float on this CPU.
- Memory is the peak resident size of the Python process. "Memory before model" is the size before the ONNX session loads (Python, laya-mlx and the tokenizer).
- In the run during the MLX job, the first 10 of the 30 pages took 31 s to 60 s. The other 20 took 15 s to 18 s.
- Each run's page times and loads are in the latency reports.
- #38 sets a 3,000 ms default timeout per request (`desktop/laya.cjs`). At 38 ms per row, that is about 79 candidate rows per request on this machine.

## Runtime recommendation

**onnxruntime-node, in the Electron utility process #38 built** (`desktop/laya.cjs` forks `desktop/laya-worker.cjs`). A Python sidecar (`laya serve`) is not recommended.

- **Same engine, same numbers.**
  - #38 uses onnxruntime-node 1.30.0, the same onnxruntime version measured here, with the same CPU execution provider and full graph optimization.
  - It runs the byte-identical int8 file.
  - So this report's int8 accuracy applies to what ships, given the same prompts and batch size. #38 checks these with its parity fixtures.
- **No Python on applicants' computers.**
  - A sidecar needs Python plus PyTorch (`pip install laya`) or onnxruntime and tokenizers, installed by the applicant or bundled for every platform.
  - laya-mlx, which the MLX baseline used, runs only on Apple silicon.
- **No speed difference to gain.** The time is spent in onnxruntime's matrix kernels, about 38 ms per row. A Python process would call the same kernels. The latency failure comes from the model and the number of candidate rows, not from the runtime.
- **Memory stays out of the app's main process.** The utility process holds the 1.6 GB peak and can be ended when idle. #38 unloads the model after 5 minutes idle.

## Model variant, quantization and thresholds

- **Model:** the English `laya`, fine-tuned as LayaStudio run `augmented-lora-proper-1790472969` (#41). The fine-tuned model is not on Hugging Face yet. Pin the base revision `aac6fef/laya-mlx@20aed815fc6acde75733882e7ec0e3f28aeb9717` and the SHA-256 values above.
- **Quantization:** int8 dynamic weight quantization (`QInt8`, `MatMulConstBOnly`). The float export matches MLX more closely but is 1,688 MB, over the 600 MB limit, and only 11% slower.
- **Thresholds for the int8 export.** Answering uses the lowest reported threshold at which int8 precision is at least 0.95 on both the test split and the holdout forms. Matching reaches 0.95 at 0.99; it uses 0.992, where both sets are at 0.975 or higher:

| Task | Threshold | Test split: fills, wrong, precision, coverage | Holdout: fills, wrong, precision, coverage |
|---|---|---|---|
| Answering | 0.996 | 35, 0, 1.000, 0.213 | 6, 0, 1.000, 0.353 |
| Matching | 0.992 | 40, 1, 0.975, 0.476 | 19, 0, 1.000, 0.404 |

- Answering at 0.995 gives 0.944 on the test split.
- Matching at 0.99 gives 0.957 on the test split and 0.955 on the holdout forms.
- The thresholds sit on a steep edge and were picked on the sets they are reported on. The holdout counts are small.

## Export commands

LayaStudio at commit `f45c17e` (`uv sync --extra export`). The exports measured here were written on 2026-09-27 at 01:59 (float) and 02:00 (int8).

```
cd ~/Projects/LayaStudio
uv run python -m layastudio.export run:augmented-lora-proper-1790472969 --target onnx --precision int8
uv run python -m layastudio.export run:augmented-lora-proper-1790472969 --target onnx
```

The scoring and latency commands:

```
uv run --project ~/Projects/LayaStudio python ML_model/eval/decisions.py --runtime onnx --threads 8 --batch-size 16 \
    --onnx <LayaStudio>/workspace/exports/augmented-lora-proper-1790472969-onnx-int8 --dataset <test data> \
    --reference-probs mlx=<mlx report>.probs.json --report <report>.json
uv run --project ~/Projects/LayaStudio python ML_model/eval/latency_onnx.py --batch-size 8 --runs 30 \
    --onnx <LayaStudio>/workspace/exports/augmented-lora-proper-1790472969-onnx-int8 --dataset <holdout data> \
    --form https://uticafoodpantry.org/wp-content/uploads/2022/06/ClientIntakeForm.pdf --out <report>.json
```

## Go / no-go against #37

| Criterion | Measured | Result |
|---|---|---|
| Precision ≥ 0.95 on accepted suggestions | int8 at 0.996 (answering) and 0.992 (matching): 1.000 and 0.975 on the test split, 1.000 and 1.000 on the holdout forms. At 0.95: 0.769 and 0.899 on the test split. | **Passes only at those thresholds**, which were chosen on these same sets |
| ≥ 30% of questions the rules miss get a correct suggestion | Not measured: this spike did not run the rules engine. Coverage of answerable questions at the chosen thresholds: answering 21.3% (test) and 35.3% (holdout); matching 47.6% and 40.4%. | **Not measured** |
| p95 ≤ 500 ms for 20 questions on CPU | 15,043 ms on the Apple M4 Max (int8, 390 candidate rows). Windows not measured. | **Fails** |
| int8 model ≤ 600 MB | 425.1 MB (405.4 MiB) | **Passes** |

**No-go** on #37's criteria as written. Latency fails by 30×, and the runtime choice does not change it. The model fits the size limit. It reaches the precision bar only at the 0.996 and 0.992 thresholds, where it fills 21% to 48% of answerable questions.

## Reports

In `ML_model/eval/reports/`:
- accuracy: `spike-runtime-mlx-bf16-{test,holdout}.json`, `spike-runtime-onnx-int8-{test,holdout}.json`, `spike-runtime-onnx-float-holdout.json`, `spike-runtime-onnx-int8-batch1-holdout-sample.json`;
- latency and memory: `spike-runtime-latency-onnx-{int8,float}.json`, `spike-runtime-latency-onnx-int8-batch16-threads8.json`, `spike-runtime-latency-onnx-int8-during-gpu-job.json`.
