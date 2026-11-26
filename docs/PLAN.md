# PlinthArc v0.1 实施方案

2026 年 11 月 25 日。首版目标是让用户用一个模型库运行指定图片模型和 MiniMax H3。用户选模型和任务、填写参数、提交前得到可读的检查结果，运行后能凭记录取回参数和产物。[运行时规范](SPEC.md)

## 1. ComfyUI 用户反馈与对应设计

以下是公开 issue 中可核对的个案。已关闭的历史问题用于提炼设计要求，开放的报告用于说明具体失败模式。

| 用户报告 | PlinthArc 的设计与验收 |
|---|---|
| 更新失败后仍在旧核心运行，安装页只显示依赖工具退出码。另有装缺失节点改变已钉 Torch 版本的历史报告，维护者后来加了恢复机制。 [Desktop #1953](https://github.com/Comfy-Org/Comfy-Desktop/issues/1953) · [Manager #1136](https://github.com/Comfy-Org/ComfyUI-Manager/issues/1136) | 模型文件和适配器发布分开。先准备并验证新运行时，再启用。报告失败阶段和仍在用的版本。验收用失败升级验证旧版还能加载原模型。 |
| IPAdapter 用户已配置共享路径，插件仍要在特定目录链接模型才能识别。另一位 Desktop 用户更新后下拉为空，复制权重到共享目录并重启才恢复。 [IPAdapter #766](https://github.com/cubiq/ComfyUI_IPAdapter_plus/issues/766) · [Desktop #2331](https://github.com/Comfy-Org/Comfy-Desktop/issues/2331) | 由同一个库按摘要绑定所有适配器，支持原地登记和移盘重连。用两个模型包引用同一编码器，确认只有一份托管文件；用外部登记确认没有额外权重副本。 |
| 缺输入、缺模型与工作流错误常被混在一起。API 格式的 JSON 放在工作流侧栏打开后，有报告触发 TypeError。 [Frontend #20040](https://github.com/Comfy-Org/ComfyUI_frontend/issues/20040) · [Frontend #23839](https://github.com/Comfy-Org/ComfyUI_frontend/issues/23839) | 提交前分别判断导入格式、缺失组件、缺少输入和设备不支持。对每项指出修复入口。准备四个故障样例，验证运行不会被提交。 |
| 子图暴露的多个数值同名为 value。App Mode 有复制工作流后输入丢失的用户复测。 [Frontend #7613](https://github.com/Comfy-Org/ComfyUI_frontend/issues/7613) · [Frontend #14838](https://github.com/Comfy-Org/ComfyUI_frontend/issues/14838) | 同一份能力描述供界面、预检和运行使用。预设按语义 ID 保存参数。复制、重新打开和运行回执须能逐字段核对。 |
| H3 用户在特定 Windows 环境遇到显存估算与 OOM，原帖后续将注意力转向动态显存初始化失败。另一例是切换工作流后才发生 OOM。 [Core #15663](https://github.com/Comfy-Org/ComfyUI/issues/15663) · [Core #17339](https://github.com/Comfy-Org/ComfyUI/issues/17339) | 把权重加载、内存迁移、采样、解码和发布分别计时。按配置判断显存和 RAM。测试冷启动、重复运行和 A→B→A 切换，明确展示 OOM 阶段和选择其他已验证配置的入口。 |
| 有用户遇到 WebSocket 不再推送事件但生成仍继续。也有成功消息先到、历史接口稍后才拿得到产物索引的报告。 [Core #15240](https://github.com/Comfy-Org/ComfyUI/issues/15240) · [Core #11540](https://github.com/Comfy-Org/ComfyUI/issues/11540) | 状态可按运行 ID 回查，进度断开时保留任务。验证只有在产物可读且索引落地后才报告成功。 |
| 有用户重启后 PNG 仍在，任务与原工作流的关联却消失。官方 API proxy 已提供可选的持久化任务记录。 [Core #15965](https://github.com/Comfy-Org/ComfyUI/issues/15965) · [Comfy API proxy 批次文档](https://github.com/Comfy-Org/comfy-api-proxy/blob/main/docs/batch-workloads.md) | 每次运行独立保存请求、阶段和结果清单。杀掉工作进程再重启，断点须可被找到并明确标成中断。编码完成但未交付的文件可重试发布。 |

ComfyUI 已有共享模型路径、缺节点检查、工作流模板、App Mode 和 Desktop 更新快照。将不同来源的权重统一为组件身份，并在提交前验证模型、参数、设备组合，是 PlinthArc 的具体改进目标。 [共享模型路径](https://github.com/Comfy-Org/ComfyUI/blob/master/extra_model_paths.yaml.example) · [缺节点诊断改进](https://github.com/Comfy-Org/ComfyUI/issues/11883) · [Desktop 实例与快照](https://docs.comfy.org/installation/desktop/usage/instance-management) · [App Mode](https://docs.comfy.org/interface/app-mode)

## 2. 值得沿用的做法

- **官方模板和可追溯结果。** 学习可直接使用的模板和 ComfyUI PNG 元数据。PlinthArc 首版提供注明适用模型和硬件的预设，产物附带可读的结果清单。 [工作流模板](https://github.com/Comfy-Org/workflow_templates) · [Save Image](https://docs.comfy.org/built-in-nodes/SaveImage)
- **可观察的执行和取消。** 学习阶段进度、错误上下文、队列与历史查询。首版以 CLI 和本机任务记录实现，用稳定运行 ID 联接进度和结果。 [HTTP 路由](https://docs.comfy.org/development/comfyui-server/comms_routes) · [WebSocket 消息](https://docs.comfy.org/development/comfyui-server/comms_messages)
- **热模型复用和按需卸载。** 学习从内存预算决定组件放置。具体缓存和卸载交给适配器，版本和硬件实测结果进入兼容表。 [模型加载与卸载](https://github.com/Comfy-Org/comfyui-native-port-guide/blob/main/reference/ops-and-model-management.md)

## 3. 首版兼容目标

以下是拟认证型号和能力。每个型号先钉一套权重及组件摘要，逐项发布通过的变体与设备。开放权重的许可单独核对，尤其是 OpenRAIL 和 H3 社区许可。

| 模型 | 首批验收能力 | 权重来源和许可 |
|---|---|---|
| Z-Image-Turbo | 文生图。作为第一条图像端到端路径。 | Apache-2.0。[模型卡](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo) |
| FLUX.2 Klein 4B | 文生图和单参考图编辑。优先以明确支持的图像编辑路径验证。 | 4B 为 Apache-2.0。[模型卡](https://huggingface.co/black-forest-labs/FLUX.2-klein-4B) · [后端执行说明](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/models/flux2.md) |
| SDXL Base 1.0 | 文生图，作为常见存量权重的原地登记验证。 | CreativeML Open RAIL++-M，按原条款使用。[模型卡](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0) |
| Qwen-Image-2512 | 文生图，固定含中英文文字的样例。排在前三条图像链路之后。 | Apache-2.0。[模型卡](https://huggingface.co/Qwen/Qwen-Image-2512) |
| MiniMax H3 FL2VA / Ref2VA | 先交付文生视频和首帧图生视频，验证原生音画。首尾帧与有序参考作为独立能力逐步验收。 | H3 社区许可或实际权重的发行条款。附原条款链接，核对地区和使用条件。[官方模型卡](https://huggingface.co/MiniMaxAI/MiniMax-H3) · [权重许可](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE) |

FLUX 3 Image Klein 和 Qwen-Image-2.1 已有开放权重，前者采用 FLUX Kommunity License，后者采用 Qwen Research License。首批选择许可边界明确且接入路径已有文档的较早变体。项目发行物包含运行时、清单和权重来源，具体权重由用户按原许可获取或登记。H3 首版以本地短片为验收目标。 [FLUX 3 官方发布](https://bfl.ai/blog/flux-3-image-klein) · [Qwen-Image-2.1 模型卡](https://huggingface.co/Qwen/Qwen-Image-2.1) · [H3 本地能力](https://docs.comfy.org/tutorials/video/minimax/minimax-h3)

## 4. 运行架构和优先级

v0.1 的 Rust 实施基线已确定。一个 Cargo 包发布一个 PlinthArc 程序，同一数据目录只由一个协调进程管理。首个 Pillar 直接调用固定构建的 `sd-cli` 子进程。常驻引擎按模型和设备单独验证后开放。[Rust 底层架构决议](ARCHITECTURE.md)

选择 `stable-diffusion.cpp` 作为起点，是因为它覆盖首批图像模型，并公开了 H3 的 GGUF、文本编码器及视频和音频 VAE 路径。在同一设备依次比测 Mold 的 Rust/Candle 路径与 edge-dit.cpp 的 H3 CUDA 路径，按目标设备、质量、显存和可复现耗时确定默认配置。选型与验收细节见[依赖复用与性能方案](REUSE.md)。 [stable-diffusion.cpp 模型目录](https://github.com/leejet/stable-diffusion.cpp#features) · [H3 执行说明](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/models/minimax_h3.md) · [Mold H3](https://utensils.io/mold/models/minimax-h3)

首机建议 Linux x64、NVIDIA CUDA、RTX 4090 24 GB 与 64 GB 主机内存。这个配置用于先建立可重复的基线。Windows CUDA、12 GB 档与 Apple Metal 必须各自有实机记录才进入支持名单。每个版本先在一台机器上验证冷启动、热复用、切模型和取消，再扩设备范围。

| 里程碑 | 交付与退出条件 |
|---|---|
| 0 · 技术验证 | 固定后端构建。单机跑通 Z-Image-Turbo 和 H3 的短片冒烟样例。H3 可从后端文档的 864×480、56 帧、24 fps 起步，分别核对解码、封装、音轨、设备内存和取消。 |
| 1 · 统一模型库 | CLI 可列出、登记或托管导入模型并预检。测同内容不同名、同名不同内容、共用组件、外置盘移动、失效引用和导入中断。一次模型导入不得更改已安装推理环境。 |
| 2 · 图片生成 | 按表接入首批文生图和 FLUX 单参考编辑。跨架构复用同一调用协议，验证预设往返、实际 seed 与可解码产物。每个模型单独公布设备与参数范围。 |
| 3 · H3 交付 | 先做文生、首帧图生及原生音轨。加入至少一个 4 秒以上的可复现样例。对首尾帧、有序参考、错误组合、音画同步、OOM、取消和进程中断分别验收。只有通过对应样例才开放该输入模式。 |
| 4 · 试用入口 | 将同一份能力描述接入本地任务表单，并用 GPUCanvas 实现结果工作区。用户可登记已有权重、使用预设、查看预检和历史产物。默认采用每设备一个活动推理任务，按实测调整。 |

图片闭环增加一项可独立验收的迁移能力。在 SDXL Base 原生操作通过后，导入一条七节点单图 API 工作流，编译成同一份原生请求。只在导入时解析一次。编辑器 JSON 与带元数据的 PNG 分别验收。超出支持范围的图指明阻塞节点，用户可另建原生工作流。第三方节点生态和通用图调度留到出现具体需求后评估。[工作流规范与验收](SPEC.md#7-原生工作流与-comfyui-导入)


## 5. 前端与仓库组织

页面、交互、API 与验收细节见[前端实施方案](UI-PLAN.md)。

### 从旧工作流或生成结果开始

创作页的「打开工作流」进入新的可编辑草稿。成功导入时直接呈现模型、正负提示词、实际尺寸、采样器和种子。文件只有模型名时，先从共享模型库列出候选，用户确认后把摘要写进草稿。缺组件可以去模型库原地登记再返回。某个节点无法转换时显示其 ID、类型与原因。Arc 沿用现有 DOM 表单与结果区。ComfyUI 的 App Mode 可借鉴输入展示。SwarmUI 用户尝试把任意 Comfy 图还原成生成表单时，遇到了参数无法对应的问题。[ComfyUI App Mode](https://docs.comfy.org/interface/app-mode) · [SwarmUI 用户与维护者讨论](https://github.com/mcmonkeyprojects/SwarmUI/discussions/1170)

结果卡提供「按原设置再跑」与「用这些设置」。「按原设置再跑」依照实际回执锁定种子、模型、配置和输入，重新预检后建立新任务。缺少原参考图时保留绑定并提示重连。「用这些设置」只打开草稿，改提示词、随机种子或配置后再生成。已完成的图片也可直接绑定为 H3 首帧。PNG 进入素材字段时直接当图片，只有选择复用设置时才读取工作流元数据。[InvokeAI 结果回用](https://invoke-ai.github.io/InvokeAI-7/users-guide/gallery/gallery-reference/) · [跨库素材引用限制](https://invoke-ai.github.io/InvokeAI-7/development/architecture/media-metadata/)

验收时走完一次真实创作会话。首次导入并补齐模型，改种子连出三张图，从其中一张打开 H3，服务重连后继续查看结果。记录从打开文件到可编辑、提交到首个真实进度、提交到可用产物，以及取消后下一次提交到恢复出图的时间。已有热生成记录时才显示对应设备与规格的时间估计。[执行性能方案](REUSE.md)

前端放在 PlinthArc 仓库的 `ui/`，是一个可独立开发和构建的 React、TypeScript 与 Vite 子项目。根目录保留 Rust 运行时和 CLI。首版的参数、预检、进度和结果会同时改动前后端，同仓可以在一次提交中更新契约、实现与验收样例。前端形成独立发布节奏、需要同时兼容多个后端版本时，再评估拆出 PlinthArc-UI。

```text
PlinthArc/
  src/           Rust 运行时、CLI 和本机 HTTP 入口
  ui/            React + TypeScript + Vite
  docs/
    ARCHITECTURE.md
    SPEC.md
    PLAN.md
    UI-PLAN.md
    REUSE.md
```

### GPUCanvas 的使用范围

结果工作区使用 `gpucanvas/react` 的 `GpuCanvas` 和 `CanvasNode` 组织图片、视频缩略图与任务卡片，支持平移、缩放和选择。模型库、生成表单、错误提示与视频播放使用常规 React DOM。生成流程和模型状态由 Rust 管理。结果卡片通过运行 ID 和产物引用取得数据，切换渲染器时仍可恢复工作区位置。 [GPUCanvas](https://github.com/berkantay/gpucanvas) · [React 封装](https://github.com/berkantay/gpucanvas/blob/v0.6.0/src/react.tsx)

GPU 路径同时需要 WebGPU 与 HTML-in-Canvas，且须实际初始化成功。部署以 DOM 路径提供完整的基础交互，并用 GPUCanvas 的自动检测启用加速。Chrome 157+ 可作为 GPU 路径的验收入口，Safari 用 DOM 路径验收。比较两条路径的结果浏览、平移缩放、选中、键盘焦点和媒体播放。首轮验证从已发布的 `gpucanvas@0.6.0` 起步，通过后锁定版本并保留 MIT 许可。图片使用缩略图，H3 运行期间也测页面渲染和视频预览占用的显存。 [Chrome HTML-in-Canvas](https://developer.chrome.com/blog/html-in-canvas) · [GPUCanvas 检测实现](https://github.com/berkantay/gpucanvas/blob/v0.6.0/src/gpu/backend.ts) · [MIT 许可](https://github.com/berkantay/gpucanvas/blob/v0.6.0/LICENSE)

### 本地接口和交付

开发时由 Vite 将 `/api/v1` 代理到回环地址上的 Rust 服务。发行时，Rust 在同一回环地址提供已构建的 `ui/dist` 和 API。两者随同一版本发布。Rust 提供模型能力、预检、提交、状态和产物读取接口，浏览器按运行 ID 查询并在刷新后接回原任务。页面以模型包摘要选择权重组合，通过资产引用读取素材和产物。Rust 只绑定回环地址，校验写请求的来源，静态资源根限定在构建目录。 [Vite 开发代理](https://vite.dev/config/server-options#server-proxy)
