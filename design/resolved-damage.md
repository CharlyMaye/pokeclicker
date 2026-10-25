# Resolved combat damage snapshots

`applyDamageSnapshot(scenario, snapshot)` validates a complete resolved party snapshot and returns an immutable scenario with calculated click and automatic damage. It is independent of route-content compilation and accepts both existing uniform and weighted scenarios. It does not mutate a running world, consume items, change the party or read presentation/global state.

## Explicit inputs

Snapshot version 1 requires a `click` object (`baseAttack`, `multiplier`) and an `opponents` array. Each opponent profile contains `location`, `pokemonId` and `party`. There must be exactly one profile for each route/opponent definition, including locked routes; unknown, duplicate or missing profiles fail the whole operation.

Each party requires its final `multiplier`, `includeTempBonuses` boolean and ordered `contributors`. A contributor contains:

- a unique `pokemonId` and already-calculated `attack`;
- explicit `active`, `breeding` and `includeBreeding` flags;
- resolved `typeMultiplier` and `regionMultiplier`;
- ordered `weatherMultipliers` and `fluteMultipliers` arrays;
- resolved `zMoveMultiplier`.

Every field is required. Empty arrays mean no matching factors, not an omitted policy. For dual-type matches the adapter supplies both factors in the same order as the legacy game. Multipliers and base damage are supplied as data; the calculation contains no balance defaults. JSON fixtures document the complete input shape in `tests/fixtures/simulation/damage-snapshot.json`.

The caller resolves active subregion membership, type effectiveness, regional challenge exemptions, weather, flute types, Z-moves and other bonuses. Base Pokémon attack (level, breeding bonuses, EVs and items) and base click attack (party counts and status bonuses) are not derived here. These remain explicit adapter responsibilities until their rules are migrated. Synthetic fixtures are test data, not a new public balance configuration.

## Calculation and validation

Automatic damage preserves the legacy sequence: start with attack or zero for an excluded/breeding member; multiply by type, region and each weather factor; apply flute factors and Z-move bonus only when temporary bonuses are included; sum unrounded contributions in input order; multiply by the party bonus; finally `Math.round`.

Click damage multiplies its resolved base by the resolved bonus and then `Math.floor`. No intermediate per-member rounding is introduced. Empty parties, zero bonuses and immunity yield zero damage. Contributor order is meaningful for floating-point accumulation and is preserved.

The boundary rejects missing/extra fields, accessors, malformed arrays, duplicate contributors, nonboolean flags, negative/nonfinite numbers and unsafe intermediate products or sums. Inactive members and disabled bonuses are still validated. It deliberately rejects corrupt data rather than reproducing legacy propagation of NaN or unsafe values. Rounding is the numerical contract, not a configurable balance value.

## Session and persistence integration

The resolved scenario retains its original format, encounter tables, rewards, capture policy and route availability. The adapter performs no live damage updates. A new session receives a complete snapshot; current checkpoints keep the resolved integer damage. Restoring against different resolved damage fails existing scenario compatibility checks, with no implicit migration or overwrite.

An emitted-worker regression test starts from a resolved snapshot, verifies increased automatic damage and fractional click rounding, saves during a pending capture, restarts the worker and compares subsequent events, snapshots, progression and final checkpoint with direct combat. No renderer participates in these calculations.

## Evidence and remaining work

Differential tests execute the actual legacy `Party.calculatePokemonAttack`, `calculateOnePokemonAttack` and `calculateClickAttack` methods against controlled resolved inputs. Cases cover type immunity/resistance/weakness, region penalties, two weather/flute factors, Z-moves, temporary-bonus exclusion, inactive/breeding members, fractional contribution sums and click rounding.

This establishes parity for the resolved-input calculation boundary. It does not establish parity for production bonus discovery, item-use side effects or changing party/weather state during a session. Those need explicit simulation inputs, ownership rules and replay tests before live activation. No lab configuration, public balance or existing save is changed by this PR.
