# Runtime configuration loading

This slice extends the [combat baseline](combat-baseline.md) with the configuration boundary the new simulation will consume. It does not activate the ECS engine, change the current startup path or migrate saves.

## One validation boundary

The JSON schemas remain the source of truth. `npm run generate:config` generates TypeScript declarations, standalone Ajv validators and a release descriptor. `npm run check:config-generated` compares deterministic output with the committed files and fails on schema, settings or generated-file drift. Normal builds perform this check before publishing configuration.

`src/contracts/configuration.js` applies the generated schema validators and the cross-file timing rule once, for both build tooling and runtime loading. This small CommonJS module is JavaScript with checked JSDoc so Node build tools can consume it directly; strict TypeScript checks its implementation and its generated type guards. Its return value is a detached, frozen `Configuration`. The two current schemas contain scalar fields only; adding nested settings requires extending the copy/freeze policy and its tests.

The contracts compile with `lib: ["ES2020"]` and `types: []`, without DOM, Node or Knockout globals. Compile-time negative tests guard that boundary and the read-only settings contract. Browser APIs belong in `src/runtime/`, which has its own strict TypeScript configuration. Both directories are excluded from the legacy global compilation.

## Code and data consistency

The generated release descriptor contains SHA-256 digests of the exact JSON bytes and a version derived from the complete set of digests. It is imported by the runtime loader, so the future application bundle carries the data identity it expects.

Gulp publishes:

- `configuration/<version>/combat.json` and `simulation.json`: immutable-by-name assets used by the new loader.
- `configuration/manifest.json`: the release descriptor, for diagnostics and inspection.
- `config/*.json`: the original readable baseline paths retained by the preceding PR.

The loader uses its embedded descriptor, not the mutable manifest URL. It checks downloaded bytes before parsing and validation. A stale response or a mixture of files from different releases cannot silently become live settings. Missing files fail startup; there is no fallback to another version or to values embedded in code. This protects deployment consistency, not authenticity against someone who can replace both the application and its data.

The normal website build starts clean. Deployments therefore need not retain older versions; an old application tab trying to start against a newer deployment may receive a missing-file error and need a reload. Retaining older assets and designing user-facing recovery belong to deployment/startup integration.

## Loader contract

`loadConfiguration(applicationBaseUrl, options)` accepts an explicit absolute HTTP(S) URL ending in `/`, such as `https://charlymaye.github.io/pokeclicker/`. Relative asset paths resolve under that directory. Query strings, fragments and embedded credentials are rejected to avoid ambiguous bases.

The host supplies `timeoutMs`, an optional abort signal and, for tests or alternative hosts, a Fetch-compatible implementation. The Fetch implementation must honor abort signals, including while reading a response body. The loader owns its internal abort controller, deadline timer and listener cleanup. A single startup budget covers the whole load.

The loader limits each body to 64 KiB by counting actual streamed bytes rather than trusting Content-Length. It verifies SHA-256 using Web Crypto, decodes UTF-8 strictly, parses JSON, applies shared validation, then returns the complete frozen settings set. No partially loaded settings are published. HTTPS or a secure localhost context is required for Web Crypto.

Errors have a `code`, failing `file` and contextual message. Codes distinguish invalid options, transport/HTTP failures, size limits, integrity mismatch, JSON/validation errors, cancellation and timeout. Startup code will decide how to present and recover from those errors. This loader does not create timers for gameplay, access saves or construct an ECS world.

## Validation

- Generation tests detect stale data identities and stale schema-derived types.
- Runtime tests load actual published assets through HTTP at both the domain root and `/pokeclicker/`.
- Adversarial cases cover wrong bases, missing files, stale or malformed content, missing bodies, dishonest Content-Length, transport failure, cancellation and timeout cleanup.
- Existing configuration and combat baseline tests remain in CI.
- The publication check verifies both the manifest and the bytes served at canonical and versioned paths.

Next stage 1 work: save fixtures and simulation command/snapshot contracts, followed by the headless combat implementation. Connect this loader at the new host's startup boundary when that host exists.
