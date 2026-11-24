# PlinthArc

PlinthArc is a Rust project for running image, video, and audio generation models locally through a shared interface.

A versioned manifest describes each model package, and adapters handle model-specific loading and inference. Compatibility is tracked by model variant, operation, backend, and device.

The project is in early design. The first milestone is a CLI that validates a model package, runs a supported model, and reports the configuration used to produce the result.
