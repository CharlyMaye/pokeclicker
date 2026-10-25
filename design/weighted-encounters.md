# Weighted route encounters

The route ECS accepts two explicit scenario formats. Existing unversioned scenarios retain uniform `floor(draw * opponentCount)` selection and their original serialized shape. A scenario with `formatVersion: 2` requires an `encounters` table on every route. There are no inferred weights or automatic save migrations.

## Data and selection

Each route keeps a unique `opponents` catalog of combat definitions and an ordered table of `{ pokemonId, weight }` entries. IDs must resolve to that route's catalog, and every definition must appear in the table. Duplicate table entries are intentional: their position and separate intervals match the legacy route pools. Fractional catalog IDs and finite fractional weights are supported.

Weights must be nonnegative with a positive finite total. Totals that overflow or lose a positive interval through floating-point addition are rejected. Sparse arrays, accessors, extra fields, unknown versions and missing tables are rejected before simulation startup. Validated data is copied and frozen.

Each spawn consumes exactly one random draw, including single-entry tables. Weighted selection uses the legacy ordered subtraction and inclusive boundary from `SeededRand.fromWeightedArray`, including its first-entry fallback for rounding residue. A zero draw can therefore select a leading zero-weight entry. This compatibility edge is intentional; changing it would change replay outcomes. The ECS continues to use its own versioned xorshift32 generator: matching selection for identical draws does not imply matching the legacy RNG sequence.

Example table for a catalog containing IDs 16 and 19:

```json
[
  { "pokemonId": 16, "weight": 1 },
  { "pokemonId": 19, "weight": 2.5 },
  { "pokemonId": 16, "weight": 0.5 }
]
```

## Resolving eligibility

`resolveRouteEncounterPools(pools, access)` is a pure boundary for already resolved eligibility. Pools contain `land`, `water`, `headbutt` ID arrays, explicit `ordinaryWeight`, and `special` groups with `pokemonIds`, `weight` and boolean `available`. Access requires `waterUnlocked` and `includeHeadbutt` booleans. There are no implicit defaults, executable requirements or global game reads.

The resolver preserves legacy order: land, eligible water, included headbutt, then available special groups. Water is eligible when unlocked or when land is empty. Duplicate IDs remain separate. Set `ordinaryWeight` to the legacy value of 1 for compatibility. All input groups are validated, including unavailable ones. An empty eligible result is rejected; the historical missing-route Rattata fallback is deliberately not a data repair mechanism.

The result can populate a version 2 route's `encounters`; callers supply the corresponding unique combat definitions. Eligibility is a session snapshot. Dynamic weather, requirements and unlock changes will need explicit simulation inputs and checkpoint semantics in a later milestone.

## Checkpoints, worker and configuration

The embedded scenario discriminates selection behavior, so combat checkpoint version 1 and worker transport version 3 remain unchanged. Older code rejects weighted scenarios rather than misinterpreting them. New code restores unversioned checkpoints without adding a version field. Changing weights, table order or scenario format makes an existing checkpoint incompatible; no original is rewritten.

The same validated scenario reaches direct combat and the emitted worker bundle. Save/restore tests compare snapshots, events, command outcomes, progress and RNG state after a pending capture and route transition. Existing rendering and storage protocols require no new fields.

The default public lab configuration remains unversioned and unchanged, preserving existing lab saves and balance. New synthetic scenarios and pool policies are JSON fixtures in `tests/fixtures/simulation/`. Production configuration will use the existing validated public JSON publication path when its content adapter is ready. This milestone does not import the production catalog, derive party damage/rewards, activate ECS in the legacy game, or migrate legacy saves.

## Validation and review

- Differential tests execute the real legacy `RouteHelper` for all water/headbutt/empty-land combinations.
- Weighted selection is compared with real `SeededRand.fromWeightedArray` at exact boundaries and a deterministic draw grid, including duplicates, zero and fractional weights.
- Simulation tests cover defensive input rejection, immutable tables, unchanged uniform selection, weighted checkpoint replay and incompatible revisions.
- Emitted-worker tests save, terminate and restore both uniform and weighted sessions through checkpoint storage.

Review the inclusive zero boundary, preservation of interval order, explicit eligibility snapshot and strict checkpoint compatibility. These are compatibility decisions, not new balance defaults.
