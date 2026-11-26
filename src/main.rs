use anyhow::{Result, ensure};
use clap::{Args, Parser, Subcommand};
use plintharc::{model, sd_cli};
use std::{
    io::{self, Write},
    path::PathBuf,
};

#[derive(Parser)]
#[command(version, about = "Run a local Z-Image-Turbo model package")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Write model.json without copying the component files
    Prepare(Prepare),
    /// Verify a local model package and print its identity
    Verify { manifest: PathBuf },
    /// Generate and verify one PNG with a local sd-cli executable
    Generate(Generate),
}

#[derive(Args)]
struct Prepare {
    /// Common parent directory of the components
    root: PathBuf,
    #[arg(long)]
    revision: String,
    #[arg(long)]
    variant: String,
    /// Relative path to the Z-Image-Turbo diffusion weights
    #[arg(long)]
    diffusion_model: PathBuf,
    /// Relative path to the Qwen3 text encoder
    #[arg(long)]
    text_encoder: PathBuf,
    /// Relative path to the FLUX VAE
    #[arg(long)]
    vae: PathBuf,
    /// Component source triple. ROLE is diffusion_model, text_encoder, vae, or all
    #[arg(long, value_names = ["ROLE", "URL", "LICENSE"], num_args = 3, required = true)]
    source: Vec<String>,
}

#[derive(Args)]
struct Generate {
    #[arg(long)]
    manifest: PathBuf,
    /// Path to the trusted sd-cli executable
    #[arg(long)]
    engine: PathBuf,
    /// Device name printed by sd-cli --list-devices
    #[arg(long)]
    backend: String,
    /// Keep model weights in host memory between compute operations
    #[arg(long)]
    offload_to_cpu: bool,
    #[arg(long)]
    prompt: String,
    /// New .png file inside an existing output directory
    #[arg(long)]
    output: PathBuf,
    #[arg(long, default_value_t = 512)]
    width: u32,
    #[arg(long, default_value_t = 512)]
    height: u32,
    #[arg(long, default_value_t = 8)]
    steps: u32,
    #[arg(long, default_value_t = 42)]
    seed: u32,
}

fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Prepare(args) => {
            let sources = args
                .source
                .chunks_exact(3)
                .map(|fields| {
                    let [role, url, license] = fields else {
                        unreachable!()
                    };
                    ensure!(
                        matches!(
                            role.as_str(),
                            "all" | "diffusion_model" | "text_encoder" | "vae"
                        ),
                        "unknown source role {role}"
                    );
                    Ok(model::Source {
                        url: url.clone(),
                        license: license.clone(),
                        component_ids: if role == "all" {
                            vec![]
                        } else {
                            vec![role.clone()]
                        },
                    })
                })
                .collect::<Result<_>>()?;
            let path = model::create(
                &args.root,
                args.revision,
                args.variant,
                args.diffusion_model,
                args.text_encoder,
                args.vae,
                sources,
            )?;
            println!("{}", path.display());
        }
        Command::Verify { manifest } => print_json(&model::verify(&manifest)?.summary)?,
        Command::Generate(args) => print_json(&sd_cli::generate(
            &args.manifest,
            &args.engine,
            &args.backend,
            args.offload_to_cpu,
            &args.output,
            sd_cli::Generation {
                prompt: args.prompt,
                width: args.width,
                height: args.height,
                steps: args.steps,
                seed: args.seed,
            },
        )?)?,
    }
    Ok(())
}

fn print_json(value: &impl serde::Serialize) -> Result<()> {
    let mut stdout = io::stdout().lock();
    serde_json::to_writer_pretty(&mut stdout, value)?;
    writeln!(stdout)?;
    Ok(())
}
