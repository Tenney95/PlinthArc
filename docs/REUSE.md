# PlinthArc 依赖复用与性能方案

2026 年 11 月 26 日。候选引擎与性能数据用于实机选型，首版进程、存储和接入方式以 [Rust 底层架构决议](ARCHITECTURE.md) 为准。

Plinth 负责统一模型库、预检、任务和结果。Pillars 调用已有推理引擎。Arc 使用同一套能力和任务协议。首批支持范围沿用 [实施方案](PLAN.md) 中的图片模型和 MiniMax H3。每个后端按模型变体、操作、显卡和输出规格分别验收。

## 1. 推理后端

| 候选 | 适合优先验证的范围 | 接入边界 |
|---|---|---|
| **stable-diffusion.cpp** | 首批图片和 H3 的通用基线。在 Linux CUDA 跑通，再单独验证 Windows CUDA。FLUX.2 Klein 单参考编辑已有执行文档。 | MIT，C/C++。首个实现固定构建并调用 `sd-cli`，常驻原生服务按配置另验。H3 已有 FL2VA 与 Ref2VA，逐项确认权重、参考语义、音轨和显存。 [项目](https://github.com/leejet/stable-diffusion.cpp) · [FLUX.2](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/models/flux2.md) · [H3](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/models/minimax_h3.md) |
| **Mold** | 现成 Rust/Candle 后端，覆盖首批图片和 H3。优先验证 Linux RTX 4090 与 Apple Silicon。 | MIT，有 CLI 与 HTTP API。H3 官方发布配置限 Linux SM89 CUDA 和 Apple Metal。先核对模型库映射、实际权重变体及取消接口，再测同规格性能。 [支持矩阵](https://utensils.io/mold/guide/feature-matrix.html) · [API](https://utensils.io/mold/api/) |
| **edge-dit.cpp** | NVIDIA 上 H3 Q8 与低显存配置的重点候选，兼测 FLUX.2 Klein。 | Apache-2.0，C/C++。有 C API、CLI 和 HTTP，接口仍在演进。固定构建，按实际任务验证 CUDA 能力。 [项目](https://github.com/THU-MIG/edge-dit.cpp) · [H3 配置和实测](https://github.com/THU-MIG/edge-dit.cpp/blob/fb064ff05cab769707c11741e11fb69226635b39/docs/minimax-h3.md#L285-L362) |
| **mmh3** | H3 专用的 Rust 性能候选，重点看 Apple Silicon 与已验证的 Linux CUDA 机型。 | MIT。逐项核对系统版本、GPU、模型与输入模式。公开的 FastH3、PI-H3 等档位使用不同权重或步数，单独比较质量和耗时。 [项目](https://github.com/mmh3-org/mmh3) · [Metal 配置](https://github.com/mmh3-org/mmh3/blob/master/docs/metal.md) |
| **Iris / h3.c** | Apple Silicon 的专用对照。Iris 验证 Z-Image-Turbo 与 FLUX.2 Klein，h3.c 验证 H3 和原生音轨。 | MIT，C 和 Metal 等原生后端。通过小型适配器调用，测实际芯片和统一内存档位。 [Iris](https://github.com/antirez/iris.c) · [h3.c](https://github.com/antirez/h3.c) |
| **SGLang / NVIDIA TensorRT-RTX** | 优化过的 CUDA 性能对照。SGLang 作为 H3 参考，TensorRT-RTX 作为受支持图像模型的候选。 | SGLang 为 Python 推理服务。TensorRT-RTX 的公开 Klein 4B FP8 演示走 Torch-TensorRT，实际分发需核对 SDK 条款和具体模型能力。 [SGLang H3](https://github.com/sgl-project/sglang/blob/main/docs/cookbook/diffusion/MiniMax/MiniMax-H3.mdx) · [TensorRT-RTX 演示](https://github.com/NVIDIA/TensorRT-RTX/blob/main/demo/README.md) |

Candle、Burn 和 CUDA Rust 算子库用于后续确有瓶颈的局部优化。首轮直接复用完整推理引擎，保留引擎原有的量化算子、注意力实现、模型常驻及 CPU 卸载路径。[Candle](https://github.com/huggingface/candle) · [Burn](https://github.com/tracel-ai/burn) · [NVIDIA CUDA Rust](https://developer.nvidia.com/cuda/rust)

### 公开实测能说明什么

- **RTX 4090，H3 文生视频 864×480、56 帧、20 步、冷进程。** edge-dit.cpp 公开对照中，Q4 配置下 sd.cpp 为 113 秒，edge-dit 为 117 秒，后者峰值约低 1,924 MiB。两者加载时量化的 Q8 配置下，edge-dit 为 159 秒，sd.cpp 为 185 秒，edge-dit 峰值也更低。结论适用于该版本和测试配置。两条结果足以把 Q4 和 Q8 分开选型。[作者实测及参数](https://github.com/THU-MIG/edge-dit.cpp/blob/fb064ff05cab769707c11741e11fb69226635b39/docs/minimax-h3.md#L285-L362)
- **RTX 5090 实体机，H3 864×480、124 帧、20 步。** SGLang 公开测试报告未剪枝 BF16 关键帧条件下约 112 秒，ComfyUI 约 141–146 秒。两者单步去噪时间接近，优化空间也来自载入和阶段衔接。[SGLang 单卡对照](https://github.com/sgl-project/sglang/blob/main/docs/cookbook/diffusion/MiniMax/MiniMax-H3.mdx#rtx-5090-single-card-physical-desktop)
- **B200，H3 1376×768、124 帧、49 次 DiT、热请求。** Creatify 的原生 Rust/CUDA 为 154.7 秒，SGLang 157.0 秒，vLLM-Omni 156.0 秒，Diffusers eager 200.9 秒。这组结果用于理解冷启动和算子优化。Creatify 核心使用带营收条件的源码可用许可，作为性能参考。[同容器实测](https://github.com/creatify-ai/native-video-inference/blob/main/docs/faq.md#speed) · [许可证](https://github.com/creatify-ai/native-video-inference/blob/main/LICENSE)
- **Apple M5 Max，1024×1024，含加载。** Iris 作者报告 FLUX.2 Klein 4B 蒸馏版本 4 步为 6.2 秒，Z-Image-Turbo 8 次去噪为 16.1 秒。这支持把 Iris 加入 Mac 对照。这些数据用于挑候选，Mac 后端的排名以同机实测为准。[Iris 实测](https://github.com/antirez/iris.c)

## 2. 运行时复用

| 模块 | 首选现成实现 | PlinthArc 只负责 |
|---|---|---|
| CLI 和契约 | `clap`、`serde`、`serde_json` | 定义版本化清单、请求与错误。复用同一套验证逻辑供 CLI、HTTP 和适配器使用。需要字段路径时使用 `serde_path_to_error`。 [Clap](https://github.com/clap-rs/clap) · [Serde](https://serde.rs/) · [错误路径](https://docs.rs/serde_path_to_error/) |
| 本机服务 | `tokio`、`axum`、`tower-http` | 提供回环 API、上传限制和同源前端。授权后的资产响应复用 Range，页面按运行 ID 查询状态。 [Axum](https://github.com/tokio-rs/axum) · [ServeFile](https://docs.rs/tower-http/latest/tower_http/services/struct.ServeFile.html) |
| 模型组件存储 | `sha2`、`tempfile`、标准库文件 API | 一次流式读取同时校验并写入目标盘暂存，按摘要提交。有效组件直接复用，采用原地登记或同卷硬链接视图。跟踪引用，处理失败暂存和仍在使用的组件。 [RustCrypto SHA-2](https://docs.rs/sha2/) · [Tempfile](https://docs.rs/tempfile/) |
| 下载与权重 | Hugging Face 的 `hf-hub`，通用 HTTP 流使用 `reqwest` | 首先支持原地登记。需下载时固定 Hub revision，利用 SDK 的 Xet 传输与已有快照，或下载到模型库的同盘暂存目录再校验发布。通用 HTTP 仅在接入其他来源时引入。引擎复用自己的 Safetensors、GGUF 与分词器加载器。 [hf-hub](https://docs.rs/hf-hub/latest/hf_hub/) · [Reqwest](https://github.com/seanmonstar/reqwest) · [Safetensors](https://github.com/safetensors/safetensors) |
| 任务与登记元数据 | `rusqlite` 与 SQLite 本地数据库 | 用短事务保持请求幂等、组件引用和任务状态一致。模型与媒体留在文件系统。任务状态机掌握取消、未知结果与交付恢复。 [Rusqlite](https://github.com/rusqlite/rusqlite) · [SQLite 事务](https://sqlite.org/lang_transaction.html) |
| 推理进程 | `tokio::process`，需要管理进程树时复用 `process-wrap` | 向固定 worker 传参，收集结构化进度并回收子进程。进程树分别验收 Unix 进程组与 Windows Job Object。稳定运行时让同模型的任务复用常驻进程。 [Tokio process](https://docs.rs/tokio/latest/tokio/process/) · [Process Wrap](https://github.com/watchexec/process-wrap) |
| 图片和音视频 | `image` 处理常用图片，复用引擎编码或调用 FFmpeg/ffprobe | 缩略图限制像素和尺寸。引擎输出符合交付规格时直接使用。需要转码或封装时调用原生工具，检查实际容器、帧率与音轨。缩放成为瓶颈时单独对照 `fast_image_resize`。 [Image](https://github.com/image-rs/image) · [SIMD 缩放](https://docs.rs/fast_image_resize/) · [FFprobe](https://ffmpeg.org/ffprobe.html) · [FFmpeg 许可](https://ffmpeg.org/legal.html) |
| 前端和观测 | `gpucanvas`、`tracing`、`Instant` 和设备采样工具 | Arc 复用已经确定的渲染库。后端记录分阶段耗时，NVIDIA 首轮用系统工具采峰值，记录采样间隔。 [前端方案](UI-PLAN.md) · [Tokio Tracing](https://tokio.rs/tokio/topics/tracing) · [NVIDIA SMI](https://docs.nvidia.com/deploy/nvidia-smi/index.html) |

使用依赖、CLI 或 C API 复用上游，集成固定版本和许可证声明。共享模型由 Plinth 解析并交给后端。后端若依赖自有下载器或库布局，先验证能否接受外部路径或硬链接视图，能否保留首版的权重去重和重连体验。分发时核对具体源码、二进制构建及模型权重条款。[统一模型库规范](SPEC.md#2-统一模型库)

## 3. 怎样选出最快的可发布配置

1. **先测 Linux RTX 4090。** 以 sd.cpp 建立图片和 H3 通用基线。Z-Image-Turbo 对比 Mold，H3 优先对照 sd.cpp、edge-dit.cpp 和具备 H3 的 Mold 构建。扩到图片矩阵时，FLUX.2 Klein 单参考编辑优先比 sd.cpp 与 edge-dit，SDXL Base 与 Qwen-Image-2512 比 sd.cpp 与 Mold。等这一轮有结果，再单独测 Windows CUDA 与 Apple Metal。Mac 专用候选为图像的 Iris、视频的 mmh3 与 h3.c。
2. **固定一条真实样例。** 图片优先用 Z-Image-Turbo 文生图，H3 用 864×480、107 帧、24 fps 的短片测试共同支持的配置，再扩大到首帧图生和目标分辨率。固定输入、seed、采样器、步数、模型组件、版本和输出格式。若无法用同一权重表示，分别标注量化与质量档。
3. **先过能力和质量，再比较耗时。** 样例必须完成所需任务，图片构图和文字可用，H3 可解码、音画同步且参考语义完整。保持结果和具体参数供复测。低步数、稀疏注意力、量化或跳步使用单独的加速档，记录可观察的效果变化。
4. **读分阶段数据。** 记录冷启动、第二次同模型运行、切模型、输入编码、去噪、VAE 解码、封装和可读取结果的端到端时间，同时记录显存、主机内存、失败及取消。重复运行，报告样本数和中位数。首轮比较使用端到端耗时，同质量档内再按显存和稳定性定默认值。
5. **只为实测瓶颈扩栈。** 若同权重的热点确在某个 GPU 算子，再试已有的量化 GEMM、attention kernel 或单算子 Rust/CUDA 实现。若耗在权重读取、重复装载或封装，先复用已有引擎能力并调整进程常驻、模型库路径或媒体交付。新的后端进入发布范围前须通过取消、恢复和权重去重验收。

每条推荐配置记录硬件、引擎构建、模型摘要、质量档和适用的输出范围。在该范围内选择更快且能稳定交付的组合。公开实测用来缩小候选范围，PlinthArc 的默认值以自己的可复现实测确定。

## 4. 优先验证的性能改进

### 让第二次生成更快

优先在基线后端验证两种用法。第一种每次用 CLI 启动同一模型。第二种由一个本机 worker 复用 `sd-server` 的执行上下文，连续运行三个只改种子的请求。它已有异步出图、出视频、查询进度和取消接口，按模型上下文缓存文本条件。每次提交显式绑定经校验的模型配置，记录引擎实际加载的组件。切换模型后要重新核对绑定。先用已有引擎的缓存开关做对照，无须在 Plinth 再存一份模型或文本张量。[sd-server 原生 API](https://github.com/leejet/stable-diffusion.cpp/blob/52491bd9f1fc15281791723bdff13baab7fd6819/examples/server/api.md) · [条件缓存与采样近似](https://github.com/leejet/stable-diffusion.cpp/blob/52491bd9f1fc15281791723bdff13baab7fd6819/docs/guides/caching.md)

分别计时模型加载、文本编码、采样和媒体交付。除换种子外，还要测改提示词、切换模型 A→B→A、取消后再生成和显存紧张时卸载。固定种子对照开关缓存的结果，确认不会复用旧提示、参考条件或模型的编码。有些采样缓存会跳步或近似预测去噪结果，这些进入另列质量验证的加速配置。H3 报告从提交到可播放带音轨产物的时间。预览使用引擎已有能力，另测开关预览对生成耗时与峰值内存的影响。

### 值得加入的硬件对照

| 硬件和任务 | 上游实测与对 PlinthArc 的意义 |
|---|---|
| **RTX 4090，SDXL Base 1.0** | NVIDIA 的 TensorRT 9.3 基准使用 1024×1024、30 步、单张、一次预热。INT8 为 2.058 秒，FP8 为 2.161 秒，分别为其 FP16 基线的 1.20×、1.14× 加速。值得在 SDXL 单图上比较 TensorRT 与 sd.cpp。首轮保留原权重路径，量化引擎单列质量档，再测首次构建时间、缓存占盘和后续热出图。SDK 与派生引擎按具体条款核对分发。[NVIDIA SDXL 基准](https://github.com/NVIDIA/Model-Optimizer/blob/49e04f77434d35489550c3098d69074c059eb428/examples/benchmark.md#2-ptq-for-stable-diffusion) |
| **RTX 4090，H3 视频** | 独立实验在同卡、同场景、同种子下生成 832×480、124 帧的短片。Nunchaku W4A4 配方用 49 次去噪，逐次从主机取 AdaLN 调制数据为 624 秒，改成按音频和视频采样时刻预计算 BF16 表为 408 秒，峰值显存由 18.6 GB 增至 19.6 GB。优化同时改变了调制计算的精度。作者以目视评估画质。先用这组脚本检查 CPU→GPU 传输是否是瓶颈，另验音画质量，再决定是否引入该量化配置。[同卡测量与实现](https://github.com/sztlink/h3-consumer-bench/blob/ee76d087ed4e269f357fe8d229dec2ea20a7be5a/README.md#the-adaln-collapse-done-same-day) |
| **Apple Silicon，H3 连续生成** | h3-metal 作者在 M5 Max 128 GB、768×448、49 帧、原版 H3 20 步测得，h3.c 冷 67.6 秒、热 73.3 秒，h3-metal 冷 54.29 秒、热 29.89 秒，热耗时取第 2–4 条短片的均值。这个结果足以将 h3-metal 列入 Mac 文生视频验证。另行核对其内核、精度、成片质量与原生音轨。对首帧图生需单独验证。发布的 4 步数据属于蒸馏权重。[h3-metal 性能表与测量方法](https://github.com/zuiho-kai/h3-metal#performance) |

显存有限时还可借鉴 MLX 的分块加载。另一个 H3 实现在 M3 Ultra、864×480、124 帧、Turbo4 的同机实验中，模型常驻为 216.60 秒，两块流式加载为 239.27 秒。后者报告进程峰值 16.36 GB，两个输出文件逐字节相同。该方案临时需要约 110–120 GB 磁盘构建自有权重布局，且低内存档未在实体 24 GB Mac 上验证。仅当转换产物大小、准备时间、质量和硬件收益都向用户可见时，将这种方案加入可选配置。[MLX H3 的流式加载对照](https://github.com/yshenaw/ComfyUI-MiniMax-H3-MLX-SolAttn/blob/55bb7ddd015321a25385683419951e7c7f518775/README.md)

### 决定哪些优化可默认启用

先对照同权重、同精度、同采样与同输出的端到端时间，再比较用户明确选择的加速档。为每组交错重复运行并报告样本数、中位数和波动。需要编译或转换的方案另记准备时间与派生字节数。若每次热运行节省 `Δt` 秒且大于零，用额外准备时间除以 `Δt` 向上取整，估计至少生成几次才收回等待成本。首图、连续出图和低内存三种场景分别判断。基础 ComfyUI 工作流的转换只在打开文件时发生，用同一原生请求验证两入口的生成成本。[工作流验收](SPEC.md#7-原生工作流与-comfyui-导入)
