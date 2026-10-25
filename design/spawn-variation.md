# Per-encounter variation and sampled checkpoints

Scenario version 3 opts into spawn-time sampling. `prepareSampledRouteSession` compiles route content and resolved damage, then validates `spawnRules` containing the existing encounter policy and one complete profile per route/opponent. Profiles use the previous encounter inputs without `catchVariation` or `moneyDeviation`: those two values now belong to each encounter rather than the session snapshot.

## Simulation order and ownership

Every version 3 spawn consumes three draws from the world's versioned xorshift32 state:

1. Select the opponent from the ordered weighted table.
2. Sample the inclusive catch-variation interval.
3. Sample the inclusive money-deviation interval.

The latter two draws are consumed even for singleton intervals. Their mapping preserves the legacy `Rand.intBetween` calculation order. Encounter resolution still consumes its separate capture-success draw. Moving routes without a pending capture discards the old encounter and samples a new one; moving during capture retains that encounter and its source-route profile until the capture resolves.

The ECS encounter component owns an immutable sample and a resolved definition. Money, catch probability, token reward and duration are calculated from the profile, sample and embedded policy at spawn. They override the corresponding validated template fields; health, damage, experience and species identity continue to come from the route template. No renderer, clock or main-thread callback determines these values.

The first spawn and every later spawn follow the same path. An invalid draw or arithmetic failure during a step leaves the previous committed world intact and faults the simulation. Profile references, duplicate/missing profiles, range widths and both endpoint calculations are checked before creating a world. Resolved snapshot application to a sampled scenario is rejected instead of silently overwriting template fields that sampling would ignore.

This specifies the RNG order for the implemented ECS subset. Full legacy encounter generation also involves roaming, shininess, held items, gender and other draws; this is not a claim of complete legacy seeded-timeline parity. The ECS random generator remains distinct from the legacy generator.

## Checkpoint version 2

Version 3 scenarios emit combat checkpoint version 2 with a required `spawnSample` holding the active encounter's catch and money variations. The existing random state is the state **after** those draws. Restoring validates the sample against the embedded policy, reconstructs the encounter definition using its source route and consumes no additional randomness.

This matters during capture: the selected destination can differ from the encounter source. Restore uses the source profile, including its capture duration, probability and token reward. The next spawn uses the selected destination normally.

Version 2 checkpoints are accepted only with scenario version 3. Missing, extra, accessor, fractional or out-of-range sample data and incompatible scenario/policy revisions are rejected. Stored samples are consistency-checked, not cryptographically authenticated; local save editing remains possible, as with previous checkpoint fields.

Unversioned and version 2 scenarios keep their original one-draw spawn behavior and emit the original combat checkpoint version 1 shape, without a sample field. Existing lab saves need no migration. Older code rejects the new scenario/checkpoint format instead of interpreting it as the old format. Host/storage envelopes and worker transport remain unchanged because they already carry a versioned combat checkpoint. Changing rules still requires an explicit migration; all scenario fields participate in compatibility checks, including template fields overridden by sampling.

## Configuration and activation

Spawn rules embed the validated `public/config/encounter-rules.json` policy and JSON profile data. No new balance constants or implicit defaults are added. The public lab remains on its existing scenario; this PR does not silently change its balance or activate ECS in the historical game. The opt-in preparation helper can be used by the future content adapter.

Static profile inputs such as ball/Oak bonuses and party damage remain session snapshots. Dynamic requirement/weather/party updates, Luxury Ball random currency rewards, production catalog extraction, experience distribution and indirect battle effects still need explicit simulation inputs and ownership work.

## Validation and review

Tests cover draw order/count, singleton intervals, unchanged old checkpoints, source-route captures, sampled duration, invalid data and atomic step failure. Multiple save points replay against uninterrupted simulation, including pending captures and queued route changes. The emitted-worker suite sends a sampled scenario through real worker execution, storage, termination and restore, then compares subsequent output and final checkpoints with direct combat. Boundary draws are compared with the real legacy integer sampler.

Review the three-draw contract, source-route restore, template/profile precedence and strict version pairing. Passing CI supports, but does not replace, the maintainer's review.
