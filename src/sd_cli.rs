use crate::model::{self, ModelSummary};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, BufReader},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Instant,
};

const MAX_PNG_BYTES: u64 = 64 * 1024 * 1024;
const CFG: u32 = 1;
const FLOW_SHIFT: u32 = 3;
const SAMPLER: &str = "euler";
const SCHEDULER: &str = "discrete";
const RNG: &str = "cuda";

#[derive(Clone, Deserialize, Serialize)]
pub struct Generation {
    pub prompt: String,
    pub width: u32,
    pub height: u32,
    pub steps: u32,
    pub seed: u32,
}

impl Generation {
    pub(crate) fn validate(&self) -> Result<()> {
        ensure!(
            !self.prompt.trim().is_empty() && !self.prompt.contains('\0'),
            "prompt must be nonempty and contain no NUL characters"
        );
        for size in [self.width, self.height] {
            ensure!(
                (64..=2048).contains(&size) && size % 32 == 0,
                "width and height must be multiples of 32 between 64 and 2048"
            );
        }
        ensure!(
            (1..=50).contains(&self.steps),
            "steps must be between 1 and 50"
        );
        Ok(())
    }
}

#[derive(Serialize)]
pub struct Report {
    operation: &'static str,
    model: ModelSummary,
    engine_version: String,
    backend: String,
    device_description: String,
    force_cpu_offload: bool,
    generation: Generation,
    cfg: u32,
    flow_shift: u32,
    sampler: &'static str,
    scheduler: &'static str,
    rng: &'static str,
    output: PathBuf,
    output_bytes: u64,
    output_sha256: String,
    preflight_ms: u128,
    engine_ms: u128,
    total_ms: u128,
}

pub fn generate(
    manifest: &Path,
    engine: &Path,
    backend: &str,
    offload_to_cpu: bool,
    output: &Path,
    request: Generation,
) -> Result<Report> {
    let started = Instant::now();
    request.validate()?;
    ensure!(
        output
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("png")),
        "output must have a .png extension"
    );
    let parent = output
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."))
        .canonicalize()
        .context("cannot open output directory")?;
    let output = parent.join(output.file_name().context("missing output filename")?);
    ensure!(output.to_str().is_some(), "output path must be UTF-8");
    model::ensure_absent(&output)?;

    let engine = engine
        .canonicalize()
        .context("cannot open sd-cli executable")?;
    ensure!(engine.is_file(), "sd-cli must be a regular executable file");
    let staging = tempfile::Builder::new()
        .prefix(".plintharc-")
        .tempdir_in(&parent)?;
    let engine_version = query_engine(&engine, staging.path(), "--version")?;
    let devices = query_engine(&engine, staging.path(), "--list-devices")?;
    let (backend, device_description) = devices
        .lines()
        .filter_map(|line| line.split_once('\t'))
        .find(|(id, _)| id.eq_ignore_ascii_case(backend))
        .with_context(|| format!("backend {backend:?} was not listed by sd-cli:\n{devices}"))?;
    let model = model::verify(manifest)?;
    fs::write(staging.path().join("prompt.txt"), &request.prompt)?;
    model.check_components_unchanged()?;
    let preflight_ms = started.elapsed().as_millis();

    let engine_started = Instant::now();
    let mut command = Command::new(&engine);
    command
        .current_dir(staging.path())
        .args(["-M", "img_gen", "--diffusion-model"])
        .arg(&model.diffusion_model.path)
        .arg("--llm")
        .arg(&model.text_encoder.path)
        .arg("--vae")
        .arg(&model.vae.path)
        .args([
            "--backend",
            backend,
            "--prompt-file",
            "prompt.txt",
            "-o",
            "result.png",
        ])
        .args([
            "--sampling-method",
            SAMPLER,
            "--scheduler",
            SCHEDULER,
            "--rng",
            RNG,
        ])
        .arg("--flow-shift")
        .arg(FLOW_SHIFT.to_string())
        .arg("--cfg-scale")
        .arg(CFG.to_string())
        .arg("--width")
        .arg(request.width.to_string())
        .arg("--height")
        .arg(request.height.to_string())
        .arg("--steps")
        .arg(request.steps.to_string())
        .arg("--seed")
        .arg(request.seed.to_string())
        .arg("--disable-image-metadata");
    if offload_to_cpu {
        command.arg("--offload-to-cpu");
    } else {
        command.args(["--auto-fit", "on"]);
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .context("cannot start sd-cli generation")?;
    // Keep stdout available for the JSON report while streaming engine logs.
    let mut logs = child.stdout.take().expect("engine stdout is piped");
    let copied = io::copy(&mut logs, &mut io::stderr());
    drop(logs);
    let status = child.wait().context("cannot wait for sd-cli")?;
    ensure!(status.success(), "sd-cli generation failed ({status})");
    copied.context("cannot write sd-cli diagnostics")?;
    let engine_ms = engine_started.elapsed().as_millis();

    let staged = staging.path().join("result.png");
    validate_png(&staged, &request)?;
    let (output_bytes, output_sha256) = model::hash_file(&staged)?;
    OpenOptions::new().write(true).open(&staged)?.sync_all()?;
    model.check_components_unchanged()?;
    fs::hard_link(&staged, &output)
        .with_context(|| format!("cannot publish {} without overwriting it", output.display()))?;
    Ok(Report {
        operation: model::OPERATION,
        model: model.summary,
        engine_version,
        backend: backend.to_owned(),
        device_description: device_description.to_owned(),
        force_cpu_offload: offload_to_cpu,
        generation: request,
        cfg: CFG,
        flow_shift: FLOW_SHIFT,
        sampler: SAMPLER,
        scheduler: SCHEDULER,
        rng: RNG,
        output,
        output_bytes,
        output_sha256,
        preflight_ms,
        engine_ms,
        total_ms: started.elapsed().as_millis(),
    })
}

fn query_engine(engine: &Path, cwd: &Path, flag: &str) -> Result<String> {
    let output = Command::new(engine)
        .current_dir(cwd)
        .arg(flag)
        .stdin(Stdio::null())
        .output()
        .with_context(|| format!("cannot run sd-cli {flag}"))?;
    ensure!(
        output.status.success(),
        "sd-cli {flag} failed ({}): {}",
        output.status,
        String::from_utf8_lossy(&output.stderr).trim()
    );
    let text = String::from_utf8(output.stdout)?;
    ensure!(!text.trim().is_empty(), "sd-cli {flag} returned no data");
    Ok(text.trim().to_owned())
}

fn validate_png(path: &Path, request: &Generation) -> Result<()> {
    let metadata = path
        .symlink_metadata()
        .context("sd-cli did not produce result.png")?;
    ensure!(
        metadata.is_file() && (1..=MAX_PNG_BYTES).contains(&metadata.len()),
        "sd-cli produced an invalid PNG file"
    );
    let mut png = png::Decoder::new(BufReader::new(File::open(path)?))
        .read_info()
        .context("cannot read the generated PNG")?;
    let info = png.info();
    ensure!(
        (info.width, info.height) == (request.width, request.height),
        "expected {}x{} PNG, got {}x{}",
        request.width,
        request.height,
        info.width,
        info.height
    );
    ensure!(
        info.animation_control.is_none(),
        "expected a single PNG image"
    );
    let buffer_size = png
        .output_buffer_size()
        .context("PNG exceeds decoding limits")?;
    let mut pixels = vec![0; buffer_size];
    png.next_frame(&mut pixels)
        .context("cannot decode the generated PNG")?;
    png.finish().context("generated PNG is incomplete")?;
    Ok(())
}
