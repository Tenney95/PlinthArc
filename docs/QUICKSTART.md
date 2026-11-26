# Z-Image-Turbo 试跑

这个试跑覆盖三步。用已有权重生成 `model.json`，核对权重身份，再调用本机 `sd-cli` 出一张图。生成成功后，标准输出提供实际设备、权重摘要、种子和分段耗时。模型库、常驻引擎与 H3 由后续里程碑实现。[底层架构](ARCHITECTURE.md)

## 准备引擎与权重

使用 Rust 1.89 或更高版本。引擎参数按 stable-diffusion.cpp 提交 `52491bd9f1fc15281791723bdff13baab7fd6819` 对照。使用这个提交构建 `sd-cli`，并把其可执行文件的路径交给 PlinthArc。CLI 记录用户提供的引擎版本。[引擎构建说明](https://github.com/leejet/stable-diffusion.cpp/blob/52491bd9f1fc15281791723bdff13baab7fd6819/docs/build.md)

- RTX 4070 Ti 12 GB 和 RTX 4090 24 GB 使用 `-DSD_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=89`。
- Apple Silicon 使用 `-DSD_METAL=ON`。
- 执行 `sd-cli --list-devices` 查看设备名。下文用 `CUDA0` 举例，Apple Silicon 一般显示 `MTL0`。

首轮对照用三份独立权重，约 5.6 GiB。已有同等组件时，在命令中填入实际文件名和来源。三份文件只需在同一目录树内，路径相对于 `model.json` 的位置，可使用已有 ComfyUI 模型树。

| 角色 | 首轮文件 |
|---|---|
| 扩散模型 | [z_image_turbo-Q3_K.gguf](https://huggingface.co/leejet/Z-Image-Turbo-GGUF/blob/c61c0e422dc8b541b7548cf33a4ef8302b0f8085/z_image_turbo-Q3_K.gguf) |
| 文本编码器 | [Qwen3-4B-Instruct-2507-Q4_K_M.gguf](https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/blob/a06e946bb6b655725eafa393f4a9745d460374c9/Qwen3-4B-Instruct-2507-Q4_K_M.gguf) |
| FLUX VAE | [ae.safetensors](https://huggingface.co/Comfy-Org/Z-Image-Turbo/blob/6fc90a3b1b653e935a0d175e260736de25b84df5/split_files/vae/ae.safetensors) |

## 构建和生成

在 PlinthArc 仓库根目录运行。以下为 Bash / zsh 写法，`WEIGHTS` 和 `SD_CLI` 换成本机路径。如果三份权重在不同子目录，保留路径前缀。

```sh
cargo build --release --locked
PLINTH=./target/release/plintharc
WEIGHTS=/path/to/weights
SD_CLI=/path/to/sd-cli

"$PLINTH" prepare "$WEIGHTS" \
  --revision pilot-1 --variant q3-k-q4-k-m \
  --diffusion-model z_image_turbo-Q3_K.gguf \
  --text-encoder Qwen3-4B-Instruct-2507-Q4_K_M.gguf \
  --vae ae.safetensors \
  --source diffusion_model https://huggingface.co/leejet/Z-Image-Turbo-GGUF/tree/c61c0e422dc8b541b7548cf33a4ef8302b0f8085 Apache-2.0 \
  --source text_encoder https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/tree/a06e946bb6b655725eafa393f4a9745d460374c9 Apache-2.0 \
  --source vae https://huggingface.co/Comfy-Org/Z-Image-Turbo/tree/6fc90a3b1b653e935a0d175e260736de25b84df5 Apache-2.0

"$PLINTH" verify "$WEIGHTS/model.json"

"$PLINTH" generate --manifest "$WEIGHTS/model.json" \
  --engine "$SD_CLI" --backend CUDA0 \
  --prompt 'A red sailboat on a calm lake at dusk, editorial photography' \
  --width 512 --height 512 --steps 8 --seed 42 --output smoke-512.png
```

先让两张 CUDA 卡使用同一组权重，固定 512×512、8 步和种子 42。若 4070 Ti 遇到显存不足，在下一次显式加 `--offload-to-cpu`。记录该模式的耗时，把 4090 的 1024×1024 对照单独记。后端在默认模式下可自动决定权重放置，回执中的 `force_cpu_offload` 记录是否由用户强制指定卸载。

输出使用支持硬链接的本地文件系统和新文件名，例如 APFS、NTFS 或 ext4。原权重在验证及生成期间保持可读且内容稳定。Windows PowerShell 中用 `& .\target\release\plintharc.exe` 调用程序，换行符用反引号，或把每条命令写在一行。

`preflight_ms` 包含组件 SHA-256 和引擎设备检查。`engine_ms` 包含本次进程的装载、采样、解码及生成文件。`total_ms` 计到 PNG 验证并发布。这个版本每次启动新引擎进程，适用于冷进程及重复启动对照。

## 已验证的结果

Apple M3、24 GiB 统一内存，使用 `MTL0` 和上述三份权重。512×512、8 步、种子 42 的单次试跑生成了可完整解码的 PNG，校验与设备检查 15.94 秒，引擎 303.41 秒，端到端 319.36 秒。启动前已枚举设备，系统的 Metal 着色器缓存已预热。RTX 4070 Ti 和 RTX 4090 的同配置实测待完成。

## 从 Arc 界面生成

先按上面的 `prepare` 命令给已有权重生成一次 `model.json`。如果已有该清单，直接在 Arc 设置里选择它所在的模型目录。产物目录可以选在另一块磁盘，须为支持硬链接的已存在目录。输出文件采用按运行 ID 命名的 PNG。

在仓库根目录构建并启动本机网页服务。把引擎路径换成绝对路径。

```sh
pnpm --dir ui install --frozen-lockfile
pnpm --dir ui build
cargo run --release --locked -- serve --engine /absolute/path/to/sd-cli
```

浏览器打开终端给出的 `http://127.0.0.1:47361`，点击右上角设置，填入模型目录、产物目录和设备名。目录以启动 Rust 服务的机器为准。网页与桌面都可以使用同一个运行中的服务。进程持有应用数据目录锁，已开启一个服务时直接打开它的地址。

启动 Tauri 桌面开发版时，先结束独立的网页服务。在 `ui` 目录运行以下命令。桌面版可以用系统对话框选择文件夹，浏览器也可打开桌面内置服务的相同地址。[Tauri 开发环境](https://v2.tauri.app/start/prerequisites/)

```sh
PLINTHARC_ENGINE=/absolute/path/to/sd-cli pnpm tauri dev
```

Windows PowerShell 先执行 `$env:PLINTHARC_ENGINE = 'C:\path\to\sd-cli.exe'`，再执行 `pnpm tauri dev`。用于推理的可执行文件由启动者提供，界面显示本机设置的引擎。

填好提示词后点击「生成图片」。成功的 PNG 可在画布查看，也可从历史下载和复用参数。GPUCanvas 默认自动探测可用的 GPU 渲染，生成期间使用 DOM，完成后恢复「自动」或「DOM」偏好。设置和运行记录保存在 PlinthArc 的本机 SQLite 库，权重和 PNG 保存在用户配置的目录。
