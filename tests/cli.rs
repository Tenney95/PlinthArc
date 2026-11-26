#![cfg(unix)]

use std::{fs, os::unix::fs::PermissionsExt, path::Path, process::Command};

#[test]
fn verifies_components_and_only_publishes_a_complete_successful_image() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path();
    let cli = || {
        let mut command = Command::new(env!("CARGO_BIN_EXE_plintharc"));
        command.current_dir(root);
        command
    };
    let mut gguf = [0; 24];
    gguf[..4].copy_from_slice(b"GGUF");
    fs::write(root.join("model-Q3_K.gguf"), gguf).unwrap();
    fs::write(root.join("encoder-Q4_K_M.gguf"), gguf).unwrap();
    fs::write(root.join("vae.sft"), b"\x02\0\0\0\0\0\0\0{}").unwrap();
    let prepare = cli()
        .args([
            "prepare",
            ".",
            "--revision",
            "test",
            "--variant",
            "test",
            "--diffusion-model",
            "model-Q3_K.gguf",
            "--text-encoder",
            "encoder-Q4_K_M.gguf",
            "--vae",
            "vae.sft",
            "--source",
            "all",
            "https://example.test/models/test",
            "MIT",
        ])
        .output()
        .unwrap();
    assert!(
        prepare.status.success(),
        "{}",
        String::from_utf8_lossy(&prepare.stderr)
    );

    let png_path = root.join("fixture.png");
    write_png(&png_path);
    let engine = root.join("test engine");
    fs::write(
        &engine,
        r#"#!/bin/sh
case "$1" in
  --version) echo 'sd-cli test double' ;;
  --list-devices) printf 'MTL0\tTest device\n' ;;
  -M)
    test "$(cat prompt.txt)" = 'test prompt' || exit 2
    case "$TEST_MODE" in
      corrupt) printf 'not a PNG' > result.png ;;
      failed) cp "$TEST_PNG" result.png && exit 1 ;;
      *) cp "$TEST_PNG" result.png ;;
    esac ;;
  *) exit 2 ;;
esac
"#,
    )
    .unwrap();
    fs::set_permissions(&engine, fs::Permissions::from_mode(0o700)).unwrap();
    let generate = |mode: &str, output: &str| {
        cli()
            .args([
                "generate",
                "--manifest",
                "model.json",
                "--engine",
                "test engine",
                "--backend",
                "mtl0",
                "--prompt",
                "test prompt",
                "--output",
                output,
                "--width",
                "64",
                "--height",
                "64",
            ])
            .env("TEST_MODE", mode)
            .env("TEST_PNG", &png_path)
            .output()
            .unwrap()
    };

    let ok = generate("ok", "result%02d.png");
    assert!(
        ok.status.success(),
        "{}",
        String::from_utf8_lossy(&ok.stderr)
    );
    let receipt: serde_json::Value = serde_json::from_slice(&ok.stdout).unwrap();
    assert_eq!(receipt["backend"], "MTL0");
    assert_eq!(receipt["generation"]["seed"], 42);
    assert_eq!(
        fs::read(root.join("result%02d.png")).unwrap(),
        fs::read(&png_path).unwrap()
    );
    assert!(!generate("ok", "result%02d.png").status.success());
    for mode in ["failed", "corrupt"] {
        assert!(!generate(mode, "bad.png").status.success());
        assert!(!root.join("bad.png").exists());
    }
    gguf[23] = 1;
    fs::write(root.join("encoder-Q4_K_M.gguf"), gguf).unwrap();
    assert!(
        !cli()
            .args(["verify", "model.json"])
            .output()
            .unwrap()
            .status
            .success()
    );
    assert!(!generate("ok", "tampered.png").status.success());
    assert!(!root.join("tampered.png").exists());
}

fn write_png(path: &Path) {
    let output = fs::File::create(path).unwrap();
    let mut encoder = png::Encoder::new(output, 64, 64);
    encoder.set_color(png::ColorType::Grayscale);
    let mut writer = encoder.write_header().unwrap();
    writer.write_image_data(&[128; 64 * 64]).unwrap();
}
