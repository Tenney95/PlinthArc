# PlinthArc v0.1 运行时规范

状态为草案。PlinthArc 是独立的本地推理运行时。v0.1 面向指定的开放权重图像模型和 MiniMax H3 视频。H3 可交付带原生音轨的视频。各模型的支持范围以实际通过的兼容配置为准。[首版实施方案](PLAN.md)

## 1. 模型包和版本

模型包描述某一组确定的组件。发布身份由 `model_id`、`revision` 和 `variant` 共同决定。同一身份必须对应相同的清单和组件内容。运行时使用 UTF-8 `model.json` 原始字节的 SHA-256 作为 `model_digest`。

| 字段 | 要求 |
|---|---|
| `schema_version` | 字符串 `"0.1"`。未知版本须报错并保留原文件。 |
| `model_id`、`revision`、`variant` | 模型名使用 `publisher/model`。版本不可变，量化或布局改变时使用独立变体或版本。 |
| `pipeline` | `id` 与正整数 `version`。确定组件角色、架构和执行语义。 |
| `components` | 非空数组。每项包含唯一 `id`、`role`、`format`、包内相对路径 `path`、实际文件大小 `bytes`、小写十六进制 `sha256`。量化组件须声明适配器能识别的 `quantization`。 |
| `operations` | 非空的版本化操作 ID 数组。它和设备支持情况共同决定实际可用功能。 |
| `sources` | 固定到发行版本或提交的来源 `url` 和 `license` 标识或条款链接。可用 `component_ids` 限定记录所覆盖的组件。 |

`path` 用于描述上游包的内部结构。导入时拒绝绝对路径、父目录跳转及逃出包根的链接。分片、索引、分词器、配置、VAE 等实际使用的文件均须列入清单。模型包只提供数据，运行时按已安装的适配器解释内容。Safetensors 和 GGUF 沿用各自公开格式，Diffusers 目录可以通过明确的适配规则导入。[Safetensors](https://github.com/safetensors/safetensors#format) · [GGUF](https://github.com/ggml-org/ggml/blob/master/docs/gguf.md) · [Diffusers 组件](https://huggingface.co/docs/diffusers/using-diffusers/loading)

## 2. 统一模型库

同一套运行时使用一个逻辑模型库。模型包引用组件的内容摘要，运行时统一解析文件位置，将已解析的组件交给适配器。适配器依赖组件角色和格式，可以重复使用同一个基础权重、文本编码器或 VAE。

| 位置 | 保存内容 |
|---|---|
| `library/manifests/<model_digest>/model.json` | 已登记模型包的原始清单。 |
| `library/blobs/sha256/<前两位>/<完整摘要>` | PlinthArc 管理的组件。每个 SHA-256 只保留一个已提交文件。 |
| 库的本机登记信息 | 外部文件的摘要和用户指定位置。实际路径只保存在本机。 |
| `runs/<run_id>/` | 每次运行的回执副本、交付清单和产物。SQLite 持有任务当前状态和对外可见的产物索引。 |

支持两种导入方式。**托管导入**将库内尚未解析到的组件校验后写入模型库。**原地登记**读取用户指定的现有目录，校验文件后登记原位置，适用于已存放在 ComfyUI 或另一块盘上的权重。只要摘要匹配且组件可读，登记新模型包时须复用已有的托管或外部组件。把已有外部组件另存为托管副本须由用户显式选择。外部路径失效时按原摘要重新关联，内容改变则要求重新校验。相同文件名而摘要不同的组件分别登记。

例如 H3 的首帧图生和多参考图生如果使用字节相同的视频 VAE，两份清单各自记录组件角色，再引用同一个 VAE 摘要。用户移动外置盘目录后只需修复该文件的登记，两种生成方式会一起恢复。

适配器通过运行时解析出的路径只读打开组件。需要扩展名或目录结构的后端，可以由运行时在同一文件系统提供经验证的临时硬链接视图。没有无复制的可用绑定方式时，预检返回 `backend_layout_unsupported`，说明可选配置或需要用户确认的迁移方式。一次操作遗留的临时文件不得被识别为已安装组件。

模型登记的移除与磁盘清理是独立操作。正在运行或仍被其他已登记模型引用的托管组件须保留。原地登记的文件由用户管理。清理仅作用于无引用的托管文件，先列出将释放的文件及字节数。内容摘要只判断字节是否相同。不同量化、格式转换或重新封装产生的新字节使用独立摘要。

## 3. 流水线、操作和预设

`pipeline` 定义某类模型如何解释组件及运行。操作定义调用方提供什么以及得到什么。相同操作可以由多个架构实现。预设是带版本的请求模板，固定推荐参数和模型兼容条件。保存、复制及重新打开预设时，使用字段名和素材角色恢复绑定。

| 操作 | 输入与交付 |
|---|---|
| `image.text_to_image@1` | 提示词与输出尺寸，交付图像。 |
| `image.reference_edit@1` | 编辑指令与按顺序绑定的参考图，交付图像。 |
| `video.text_to_video@1` | 提示词和输出规格，交付 H3 视频。 |
| `video.image_to_video@1` | 首帧、提示词和输出规格。末帧由当前配置显式开放。 |
| `video.reference_to_video@1` | 提示词与当前配置允许的有序参考素材。图、视频、音频是不同素材类型。 |

声明操作后必须公开参数类型、单位、默认值、素材必选性、数量与组合约束。尺寸按像素计，帧数为正整数，帧率以正整数分子和分母表示。用户界面和 CLI 读取同一份能力，基础项优先展示，采样器、采样步数等有意义的调节项按模型展开。

种子在请求和回执中的规则如下。已有的 0 到 4294967295 仍可使用 JSON 整数。更大的无符号整数用十进制字符串表示，最大为 `"18446744073709551615"`。外部 JSON 从原始字节在 Rust 中解析，避免浏览器先转成浮点数。每个配置公布已验证的种子范围与随机数生成方式，初版配置先限于 32 位。超出范围时在草稿中显示完整原值并阻止提交。只有能原样传递种子、说明实际生效位数并通过复现验收的配置，才可扩大范围。

运行前校验全部角色与参数。未知参数、超范围输入及不支持的输入组合必须指出具体字段。同类型或混合类型参考的顺序以该操作声明为准，适配器须保留调用方可观察的语义。运行时不得静默丢弃参考、调低输出规格或替换模型和设备。

## 4. 兼容配置和预检

每条配置以稳定的 `profile_id` 标识，绑定模型包摘要、操作版本、适配器和推理后端版本、权重精度、设备后端及限制。模型包声明的能力与当前配置实际实现的能力取交集。项目的兼容表只标注固定组合和已测范围。

- **已识别**表示清单和组件身份通过静态校验。
- **预检通过**表示选定设备、文件和请求符合配置。运行中其他进程的资源占用仍可能变化。
- **实机验证**表示指定构建、权重、设备和参数已有可复现的生成记录。

预检依次检查包、组件、输入、适配器、设备、资源和输出路径。错误返回 `code`、`phase`、字段或组件 ID 和可行动的提示。至少区分 `artifact_missing`、`artifact_invalid`、`model_unsupported`、`backend_unsupported`、`backend_layout_unsupported`、`invalid_request`、`resource_exhausted` 和 `output_unavailable`。模型缺失时指出组件、已登记位置或来源。内存失败须尽量区分设备显存和主机内存，并记录实际失败阶段。单次任务内的 CPU 卸载须由所选配置声明。

## 5. 请求、进度和交付

请求固定 `model_digest`、`profile_id`、`operation`、`inputs` 和 `params`。素材通过运行时解析的引用与角色绑定。下面的摘要和配置名称用于展示请求结构。

```json
{
  "model_digest": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "profile_id": "h3-fl2va-cuda-example",
  "operation": "video.image_to_video@1",
  "inputs": {"first_frame": "asset-001"},
  "params": {
    "prompt": "风吹动窗帘",
    "width": 864,
    "height": 480,
    "frames": 56,
    "fps": {"numerator": 24, "denominator": 1},
    "seed": 42
  }
}
```

受理任务时在同一事务写入 `run_id`、幂等键、请求指纹、已解析的模型、输入绑定、参数和实际 seed。提交后才可启动引擎。进度公开加载、编码条件、采样、解码、封装及发布阶段。有真实计数时报告百分比，等待 I/O 或进度未知时报告当前阶段与耗时。连接状态和执行终态分别处理。

结果记录实际执行的模型摘要、适配器与后端版本、设备、参数及 seed。产物索引包含角色、媒体类型、相对路径、字节数和 SHA-256。图片带尺寸，视频带实际尺寸、帧数、帧率、时长和音轨信息。必须在产物写完、可读取且索引提交以后报告成功。

任务终态包括 `succeeded`、`failed`、`cancelled` 和 `interrupted`。运行中接受取消后要等本次计算停止并回收相应资源，才进入已取消状态。若已留存完整、可验证的产物，使用非终态 `delivery_pending` 并允许按原 `run_id` 重试交付。恢复过程不得重投已派发的推理。运行记录默认保存在本地。[状态迁移与崩溃恢复](ARCHITECTURE.md#4-文件数据库与恢复)

## 6. 兼容验收

每个已验证组合须提供模型清单摘要、组件版本、后端构建、设备和驱动、固定输入及有效参数。检查可解码性、出图尺寸、H3 帧数与音画交付，以及与参考实现之间的可接受质量。报告分阶段耗时、冷暖运行、峰值显存及主机内存。跨后端使用约定的质量或数值容差，以配置明确可重复的条件。

去重验收须覆盖同文件不同名、不同文件同名、两个模型包共用组件、从外部盘登记后重连，以及导入中断、并发提交和清理时的引用保护。

## 7. 原生工作流与 ComfyUI 导入

首版原生工作流是可保存、可交换的单操作预设。Arc 的生成表单、CLI 打开的工作流和成功导入的 ComfyUI 图都生成第 5 节的请求。预检、执行、取消与历史各沿用同一个入口。文件示例中的摘要和配置名仅用于说明格式。

```json
{
  "kind": "plintharc.workflow",
  "schema_version": "0.1",
  "name": "SDXL Base 单图",
  "request": {
    "model_digest": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "profile_id": "sdxl-base-example",
    "operation": "image.text_to_image@1",
    "inputs": {},
    "params": {
      "prompt": "a red sailboat at dusk", "negative_prompt": "blurry",
      "width": 1024, "height": 1024, "seed": 42,
      "steps": 20, "cfg": 8, "sampler": "euler", "scheduler": "normal"
    }
  }
}
```

保存时写入影响输出的有效参数。有素材的文件在顶层附带 `assets` 映射，例如 `"assets": {"asset-001": {"sha256": "<素材原始字节的 SHA-256>"}}`。`request.inputs` 按角色和顺序引用这些键。打开文件只创建草稿，先按摘要找回素材，再把引用解析为本机资产 ID。缺少原模型、配置或素材时保留原绑定并提示补齐。用户显式更换配置或输入后生成新草稿，历史回执仍可查到原值。单个 Pillar 执行整条模型流水线，文本条件、latent 和 VAE 在引擎内部传递。

### 首个兼容目标

首个候选为 **SDXL Base 1.0、单阶段、单张文生图**。先支持 ComfyUI「Export Workflow (API)」生成的节点映射，根据 `class_type`、具名输入、源节点 ID 和输出槽位转换。官方基础 API 示例展示了所需的七个节点实例，原样例使用 SD 1.5。正例沿用其连接方式，另行在真实 ComfyUI 中用已登记的 SDXL Base 权重导出。[官方 API 示例](https://github.com/Comfy-Org/ComfyUI/blob/master/script_examples/basic_api_example.py) · [SDXL 基座用法](https://comfyanonymous.github.io/ComfyUI_examples/sdxl/)

| 节点与端口 | 导入条件 |
|---|---|
| 一个 `CheckpointLoaderSimple` | 槽 0 提供采样模型，槽 1 提供正负两个文本节点的 CLIP，槽 2 提供解码 VAE。文件名只用于筛选候选。缺少来源摘要时展示已有登记信息并请用户确认绑定，重名的不同内容分别列出。 |
| 两个 `CLIPTextEncode` | 按连入采样器的 `positive`、`negative` 绑定文字。首批只验普通文本及该配置的 SDXL 双编码器、pooled 条件和尺寸语义。独立双提示、未验证的提示词权重或动态语法须指出具体字段。 |
| 一个 `EmptyLatentImage`、一个 `KSampler` | 检查有效尺寸、`batch_size=1`、`denoise=1`。种子、步数、CFG、采样器和调度器逐个映射。先验证 Euler 和 normal 组合。API 图缺少必填输入时报告字段错误。只有固定版本声明的可选默认值才可展开写入草稿。 |
| 一个 `VAEDecode`、一个 `SaveImage` | 验证采样输出、同一基座 VAE 和单一图片输出的连接。输出进入 PlinthArc 运行目录，导入摘要注明 ComfyUI 的文件名前缀由本地交付规则替代。 |

导入完整检查所有节点、连线、输出槽和额外字段。编辑器文件还要核对节点的执行模式。首版只忽略已知的纯展示信息，如坐标和标题。发现未知节点、额外输出、断链、环、Refiner、LoRA、ControlNet、子图或未映射的执行参数时，报告节点 ID、类型、字段与原因，保留原件。尤其要覆盖官方 **SDXL Simple** 反例，它含 Base 与 Refiner 两段高级采样，两段之间继续使用带剩余噪声的 latent。H3 首版使用原生操作，ComfyUI 的 H3 模板须另做音画和参考素材验收。[SDXL Simple 原图](https://github.com/Comfy-Org/workflow_templates/blob/3e0d149bff40f931538b918f0d6df7e232fcc17b/templates/sdxl_simple_example.json) · [SDXL 专用文本节点](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_clip_sdxl.py)

### 文件入口与复用

- **API JSON** 最先交付。模型绑定、转换摘要和草稿都就绪后，由用户提交。保存导入器版本及来源文件摘要供追溯。未知节点不触发加载 Python、安装插件或下载权重。
- **编辑器 JSON** 按官方 v0.4、v1.0 分别识别。未验证的布局提示在 ComfyUI 用「Export Workflow (API)」导出。后续只有在同一图的界面文件和 API 文件能产生相同请求时，才开放相应版本与节点组合。控件顺序、连线覆盖控件值、生成后随机种子策略，以及 bypass/mute 都会影响转换。[界面格式规范](https://docs.comfy.org/specs/workflow_json) · [控件序列化](https://github.com/Comfy-Org/ComfyUI_frontend/blob/main/docs/WIDGET_SERIALIZATION.md)
- **PNG** 作为下一条导入入口。用户选择「复用生成设置」时，优先读取有效的 `prompt` 执行图，沿用 API 导入器。`workflow` 只走已验证的编辑器格式。执行图损坏时说明原因，不能据另一份元数据静默还原设置。没有生成元数据的 PNG 可直接作为参考素材。用 Rust 的 `png` 包读取文本块并限制元数据解压大小。[ComfyUI 元数据](https://docs.comfy.org/development/api-development/workflow-metadata) · [Rust PNG 文本块](https://docs.rs/png/latest/png/text_metadata/)

MIT 的 Rust 原型 `onnx-genai-comfyui-config` 已展示从 API 图一次性转换和按节点诊断错误。它输出自己的 ONNX 组件、求解器及随机数契约。其识别逻辑按专用节点区分 SDXL 双编码器。本项目可借鉴用例，用计划采用的 Serde 解析文件，结合已绑定模型包验证普通文本节点的真实编码器。另一个 Rust 项目 `rucomfyui` 提供 ComfyUI 客户端和代码生成器，适合已有 ComfyUI 服务的调用场景。[ONNX 导入器](https://docs.rs/onnx-genai-comfyui-config/0.1.0-dev.6/onnx_genai_comfyui_config/) · [编码器识别逻辑](https://github.com/justinchuby/onnx-genai/blob/88585866ff3cd365a4f44e219549fd97730755d0/crates/onnx-genai-comfyui-config/src/recognize.rs#L293-L297) · [rucomfyui](https://github.com/philpax/rucomfyui)

### 验收与后续组合

1. 同一张 SDXL Base 图分别从原生文件、API JSON 打开，比较解析后的请求、模型及组件摘要和引擎调用。两条路径须各提交一次相同的引擎任务，执行期间不再读取源工作流或调用 ComfyUI 服务，已原地登记的权重继续从原目录读取。分别记录导入耗时、冷启动和同模型热跑耗时。按交错顺序重复测量，两入口的差异须处于原生路径自身的重复测量波动内。
2. 钉住 ComfyUI 参考版本、权重和设备，比较正负词、尺寸、初始噪声与采样时间表，再按预设的数值或质量容差核对产物。固定种子在同一已验证配置中应可复现。对超范围值验证原文往返，以 `42`、`4294967338`、`9007199254740993` 和 u64 上限检验每层的精度及拒绝原因。sd.cpp 的 CPU MT19937 用低 32 位初始化，跨引擎仅靠相同的 seed 文本无法证明采样一致。[ComfyUI 初始噪声](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy/sample.py) · [sd.cpp RNG](https://github.com/leejet/stable-diffusion.cpp/blob/52491bd9f1fc15281791723bdff13baab7fd6819/src/core/rng_mt19937.hpp#L125-L142)
3. 用官方双阶段模板、同名异权重、未知独立输出、损坏连接和缺失元数据检验诊断。导入失败不得启动推理。通过语义验收后仍需额外 CPU/GPU 传输、加载第二套运行时或显著拖慢生成的图形，暂缓导入支持，用户可另建原生工作流。
4. 首个多步用例是「出一张图 → 作为 H3 首帧」。先在图像结果上选择「作为首帧生成视频」，以已有产物的资产 ID 打开 H3 草稿。后续确有批量保存和重放的需求时，再扩展工作流版本，以步骤 ID、产物角色和输入角色声明有向依赖。视频失败时可用已交付的同一张图重试。
