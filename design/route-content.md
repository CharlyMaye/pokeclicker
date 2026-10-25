# Route content compilation

`compileRouteScenario(content, healthPolicy)` turns a resolved route-content snapshot into an immutable weighted combat scenario. The compiler combines the pool resolver with catalog base health, route growth and species health adjustment. It runs without the DOM, game globals, storage or random draws. Its output is accepted by both direct and worker combat and the existing checkpoint format.

## Boundary and ownership

Content snapshot version 1 contains the initial location, route list, click damage/permission and initial Pokeball count. Each route contains:

- `location`, `unlocked` and an explicit positive integer `normalizedRoute` supplied by the content adapter;
- `healthOverride`: a positive safe integer, or explicit `null` to use growth;
- `pools` and `access`, using the [weighted encounter](weighted-encounters.md) contracts;
- `catalog`: exactly one `{ pokemonId, baseHealth, combat }` record for every unique species in every pool, including unavailable groups.

`combat` supplies already-resolved automatic damage, money/experience/token rewards, capture probability and capture duration. The compiler validates those inputs even for unavailable species. It does not guess party stats, multipliers, capture variation, money rounding or random rewards. Those calculations and the production catalog/name-to-ID extraction are separate migration work. The normalized position is explicit; this milestone does not reimplement historical region numbering.

The compiler preserves pool order and duplicate selection intervals, but emits unique opponent definitions for eligible species only. No source objects or executable requirements survive compilation. Missing references, duplicate or unrelated catalog records, invalid stats and arithmetic overflow reject the whole compilation without modifying inputs or game state.

## Health parity

The formula policy is `public/config/route-health.json`, schema version 1. All coefficients are required, finite and positive; minimum health is a positive safe integer. Runtime and build tools share the exact parser. There are no hidden balance defaults.

Without an override, route health follows the legacy order of operations:

```text
max(minimumHealth,
    floor((routeScale * normalizedRoute^routeExponent / routeDivisor)^growthExponent
          * (1 + region / regionDivisor)))
```

An override replaces that route-level result. Opponent health is then:

```text
round(routeHealth * (speciesOffset + (baseHealth / routeAverageBaseHealth) / speciesDivisor))
```

The route average uses every unique species across land, water, headbutt and special groups, including unavailable species. Duplicated IDs count once in the average and retain their separate weighted selection intervals. Availability changes can change the encounter pool without changing existing species' health. Overflow and unsafe/nonpositive results fail explicitly; the legacy invalid-data fallback is not reproduced.

The JSON values match the existing `PokemonFactory` coefficients. Differential tests execute its actual `routeHealth` and `generateWildPokemon` methods with controlled content, selected species and non-health services. They cover multiple regions and normalized positions, overrides, duplicate pools and unavailable species. This establishes health parity for the tested resolved inputs, not full encounter-generation parity.

## Publication and persistence

The policy participates in the generated SHA-256 release manifest, build validation and canonical/versioned publication. `loadRouteHealthPolicy` loads its pinned bytes under the deployment subpath with the same integrity, size, timeout and cancellation checks as other configuration documents.

The lab explicitly loads its three required documents. Its existing scenario and balance remain unchanged. Adding the health policy changes the release identity, but does not alter embedded checkpoint scenario data or invalidate existing lab saves.

Compiled scenarios use weighted scenario version 2. Checkpoints store the concrete compiled health and rules, not a dependency on mutable catalog data. Recompiling to different health or rules rejects old checkpoints through existing scenario compatibility checks. No migration or overwrite happens automatically. An emitted-worker test compiles content, runs combat, saves, terminates and restores the session, comparing subsequent events, snapshots, progress and RNG state with direct combat.

## Next integration work

Connect production catalog and region normalization, then migrate damage, reward and capture calculations with their own parity fixtures and RNG ordering. Dynamic eligibility changes, historical wallet/party ownership, indirect battle effects and legacy-save migration remain necessary before activating ECS in the live game. This PR deliberately adds no production activation switch.
