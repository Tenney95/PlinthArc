use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, Metadata},
    io::{self, Read, Seek, Write},
    path::{Component as PathComponent, Path, PathBuf},
};

const MODEL_ID: &str = "Tongyi-MAI/Z-Image-Turbo";
const PIPELINE_ID: &str = "z-image-turbo";
pub const OPERATION: &str = "image.text_to_image@1";
const ROLES: [Role; 3] = [Role::DiffusionModel, Role::TextEncoder, Role::Vae];
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Role {
    DiffusionModel,
    TextEncoder,
    Vae,
}

impl Role {
    fn id(self) -> &'static str {
        match self {
            Self::DiffusionModel => "diffusion_model",
            Self::TextEncoder => "text_encoder",
            Self::Vae => "vae",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Format {
    Gguf,
    Safetensors,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Component {
    id: String,
    role: Role,
    format: Format,
    path: PathBuf,
    bytes: u64,
    sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    quantization: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Pipeline {
    id: String,
    version: u32,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Source {
    pub url: String,
    pub license: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub component_ids: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    schema_version: String,
    model_id: String,
    revision: String,
    variant: String,
    pipeline: Pipeline,
    components: Vec<Component>,
    operations: Vec<String>,
    sources: Vec<Source>,
}

#[derive(Serialize)]
pub struct ModelSummary {
    pub model_id: String,
    pub revision: String,
    pub variant: String,
    pub model_digest: String,
    components: Vec<Component>,
}

pub struct VerifiedModel {
    pub summary: ModelSummary,
    pub diffusion_model: VerifiedComponent,
    pub text_encoder: VerifiedComponent,
    pub vae: VerifiedComponent,
}

pub struct VerifiedComponent {
    pub path: PathBuf,
    metadata: Metadata,
}

impl VerifiedModel {
    pub(crate) fn check_components_unchanged(&self) -> Result<()> {
        for component in [&self.diffusion_model, &self.text_encoder, &self.vae] {
            check_metadata(
                &component.path,
                &component.metadata,
                &component.path.symlink_metadata()?,
            )?;
        }
        Ok(())
    }
}

pub fn create(
    root: &Path,
    revision: String,
    variant: String,
    diffusion_model: PathBuf,
    text_encoder: PathBuf,
    vae: PathBuf,
    sources: Vec<Source>,
) -> Result<PathBuf> {
    let root = root
        .canonicalize()
        .context("cannot open model package directory")?;
    let destination = root.join("model.json");
    ensure_absent(&destination)?;
    let components = ROLES
        .into_iter()
        .zip([diffusion_model, text_encoder, vae])
        .map(|(role, path)| {
            let format = match path.extension().and_then(|ext| ext.to_str()) {
                Some(ext) if ext.eq_ignore_ascii_case("gguf") => Format::Gguf,
                Some(ext)
                    if ext.eq_ignore_ascii_case("safetensors")
                        || ext.eq_ignore_ascii_case("sft") =>
                {
                    Format::Safetensors
                }
                _ => bail!("unsupported extension for {}", path.display()),
            };
            let resolved = resolve_component(&root, &path)?;
            let (metadata, sha256) = hash(&resolved, Some(format))?;
            let quantization = if format == Format::Gguf {
                path.file_stem()
                    .and_then(|stem| stem.to_str())
                    .and_then(|stem| stem.rsplit_once('-'))
                    .filter(|(_, suffix)| suffix.bytes().any(|byte| byte.is_ascii_digit()))
                    .map(|(_, suffix)| suffix.to_owned())
            } else {
                None
            };
            Ok(Component {
                id: role.id().to_owned(),
                role,
                format,
                path,
                bytes: metadata.len(),
                sha256,
                quantization,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let manifest = Manifest {
        schema_version: "0.1".to_owned(),
        model_id: MODEL_ID.to_owned(),
        revision,
        variant,
        pipeline: Pipeline {
            id: PIPELINE_ID.to_owned(),
            version: 1,
        },
        components,
        operations: vec![OPERATION.to_owned()],
        sources,
    };
    validate_manifest(&manifest)?;
    let mut temporary = tempfile::NamedTempFile::new_in(&root)?;
    serde_json::to_writer_pretty(&mut temporary, &manifest)?;
    writeln!(temporary)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist_noclobber(&destination)
        .context("cannot publish model manifest")?;
    Ok(destination)
}

pub fn verify(path: &Path) -> Result<VerifiedModel> {
    let path = path.canonicalize().context("cannot open model manifest")?;
    let metadata = fs::metadata(&path)?;
    ensure!(
        metadata.is_file() && metadata.len() <= MAX_MANIFEST_BYTES,
        "model manifest must be a regular file of at most {MAX_MANIFEST_BYTES} bytes"
    );
    let mut original = Vec::new();
    File::open(&path)?
        .take(MAX_MANIFEST_BYTES + 1)
        .read_to_end(&mut original)?;
    ensure!(
        original.len() as u64 <= MAX_MANIFEST_BYTES,
        "model manifest is too large"
    );
    let manifest: Manifest = serde_json::from_slice(&original)
        .with_context(|| format!("invalid model manifest {}", path.display()))?;
    validate_manifest(&manifest)?;
    let root = path
        .parent()
        .context("model manifest has no parent directory")?;
    let mut paths = Vec::with_capacity(3);
    for role in ROLES {
        let component = manifest
            .components
            .iter()
            .find(|component| component.role == role)
            .with_context(|| format!("missing component role {}", role.id()))?;
        let resolved = resolve_component(root, &component.path)?;
        ensure!(
            fs::metadata(&resolved)?.len() == component.bytes,
            "size mismatch for {}",
            component.id
        );
        let (metadata, digest) = hash(&resolved, Some(component.format))?;
        ensure!(
            metadata.len() == component.bytes && digest == component.sha256,
            "SHA-256 mismatch for {}",
            component.id
        );
        paths.push(VerifiedComponent {
            path: resolved,
            metadata,
        });
    }
    let [diffusion_model, text_encoder, vae] = paths
        .try_into()
        .map_err(|_| anyhow::anyhow!("expected three verified components"))?;
    Ok(VerifiedModel {
        summary: ModelSummary {
            model_id: manifest.model_id,
            revision: manifest.revision,
            variant: manifest.variant,
            model_digest: format!("{:x}", Sha256::digest(&original)),
            components: manifest.components,
        },
        diffusion_model,
        text_encoder,
        vae,
    })
}

fn validate_manifest(manifest: &Manifest) -> Result<()> {
    ensure!(
        manifest.schema_version == "0.1",
        "unsupported model schema version"
    );
    ensure!(
        manifest.model_id == MODEL_ID,
        "this pilot supports only {MODEL_ID}"
    );
    ensure!(
        manifest.pipeline.id == PIPELINE_ID && manifest.pipeline.version == 1,
        "unsupported pipeline"
    );
    ensure!(
        manifest.operations == [OPERATION],
        "expected only {OPERATION}"
    );
    ensure!(
        !manifest.revision.trim().is_empty() && !manifest.variant.trim().is_empty(),
        "model revision and variant are required"
    );

    let mut ids = HashSet::new();
    let mut roles = HashSet::new();
    for component in &manifest.components {
        ensure!(
            !component.id.trim().is_empty() && ids.insert(component.id.as_str()),
            "component IDs must be nonempty and unique"
        );
        ensure!(
            roles.insert(component.role),
            "duplicate component role {}",
            component.role.id()
        );
        ensure!(
            component.bytes > 0
                && component.sha256.len() == 64
                && component
                    .sha256
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
            "invalid size or SHA-256 for {}",
            component.id
        );
        ensure!(
            component.role != Role::Vae || component.format == Format::Safetensors,
            "this pilot requires a Safetensors VAE"
        );
    }
    ensure!(
        roles.len() == ROLES.len(),
        "model must supply a diffusion model, text encoder, and VAE"
    );
    ensure!(
        !manifest.sources.is_empty(),
        "at least one model source is required"
    );
    for source in &manifest.sources {
        ensure!(
            source.url.starts_with("https://") && !source.license.trim().is_empty(),
            "each source requires an HTTPS URL and license"
        );
        ensure!(
            source
                .component_ids
                .iter()
                .all(|id| ids.contains(id.as_str())),
            "source refers to an unknown component ID"
        );
    }
    Ok(())
}

fn resolve_component(root: &Path, path: &Path) -> Result<PathBuf> {
    ensure!(
        !path.as_os_str().is_empty()
            && path
                .components()
                .all(|part| matches!(part, PathComponent::Normal(_))),
        "component path must be relative to the package: {}",
        path.display()
    );
    let resolved = root
        .join(path)
        .canonicalize()
        .with_context(|| format!("missing model component {}", path.display()))?;
    ensure!(
        resolved.starts_with(root) && resolved.is_file(),
        "component must be a regular file inside the package: {}",
        path.display()
    );
    Ok(resolved)
}

pub(crate) fn hash_file(path: &Path) -> Result<(u64, String)> {
    let (metadata, digest) = hash(path, None)?;
    Ok((metadata.len(), digest))
}

fn hash(path: &Path, format: Option<Format>) -> Result<(Metadata, String)> {
    let mut file = File::open(path).with_context(|| format!("cannot read {}", path.display()))?;
    let before = file.metadata()?;
    ensure!(before.is_file(), "not a regular file: {}", path.display());
    if let Some(format) = format {
        check_format(&mut file, &before, format)
            .with_context(|| format!("invalid model file {}", path.display()))?;
        file.rewind()?;
    }
    let mut digest = Sha256::new();
    let bytes = io::copy(&mut file, &mut digest)?;
    check_metadata(path, &before, &file.metadata()?)?;
    ensure!(
        bytes == before.len(),
        "file changed while reading {}",
        path.display()
    );
    Ok((before, format!("{:x}", digest.finalize())))
}

fn check_format(file: &mut File, metadata: &Metadata, format: Format) -> Result<()> {
    let mut prefix = [0; 9];
    file.read_exact(&mut prefix)?;
    match format {
        Format::Gguf => ensure!(
            &prefix[..4] == b"GGUF" && metadata.len() >= 24,
            "expected GGUF header"
        ),
        Format::Safetensors => {
            let header_len =
                u64::from_le_bytes(prefix[..8].try_into().expect("eight header bytes"));
            ensure!(
                (2..=100_000_000).contains(&header_len)
                    && header_len <= metadata.len() - 8
                    && prefix[8] == b'{',
                "expected Safetensors header"
            );
        }
    }
    Ok(())
}

fn check_metadata(path: &Path, before: &Metadata, after: &Metadata) -> Result<()> {
    ensure!(
        after.is_file() && before.len() == after.len() && before.modified()? == after.modified()?,
        "file changed: {}",
        path.display()
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        ensure!(
            (
                before.dev(),
                before.ino(),
                before.ctime(),
                before.ctime_nsec()
            ) == (after.dev(), after.ino(), after.ctime(), after.ctime_nsec()),
            "file changed: {}",
            path.display()
        );
    }
    Ok(())
}

pub(crate) fn ensure_absent(path: &Path) -> Result<()> {
    match path.symlink_metadata() {
        Ok(_) => bail!("refusing to overwrite {}", path.display()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("cannot check {}", path.display())),
    }
}
