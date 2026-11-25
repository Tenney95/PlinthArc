# PlinthArc

PlinthArc is a Rust project for running image, video, and audio generation models locally through a shared interface.

A versioned manifest describes each model package, and adapters handle model-specific loading and inference. Compatibility is tracked by model variant, operation, backend, and device.

The project is in early design. The first milestone is a CLI that validates a model package, runs a supported model, and reports the configuration used to produce the result.

## Design philosophy

PlinthArc takes its name from the structure of an arch and its supports.

- **Plinth** is the Rust foundation. It manages the shared model library, runs tasks, and delivers their outputs.
- **Pillars** is the extension system. A **Pillar** adds a capability through a common runtime interface. The first Pillars are model adapters.
- **Arc** is the frontend. It brings together the creation workspace, model library, and run history.

## Documentation

- [Runtime specification](docs/SPEC.md)
- [Implementation plan](docs/PLAN.md)
- [Frontend plan](docs/UI-PLAN.md)
