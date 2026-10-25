# Encounter rules and route session preparation

`prepareRouteSession` composes the route-content compiler, resolved damage adapter and encounter-rule adapter into one pure preparation operation. It returns a validated immutable weighted scenario before a host, worker or storage slot is created. Any invalid stage rejects preparation without mutating caller data.

The input has five required fields: `content`, `healthPolicy`, `damage`, `encounters` and `encounterPolicy`. Content and damage use the existing snapshot contracts. Encounter snapshot version 1 requires exactly one profile per route/opponent definition, including locked routes. Each profile has `location`, `pokemonId` and these explicit `inputs`:

- `normalizedRoute`, `moneyDeviation`, `moneyMultiplier`, `tokenMultiplier`;
- `baseCatchRate`, `catchVariation`, `pokeballBonus`, `oakBonus`;
- `captureDurationMs`.

Missing, duplicate, unknown or invalid profiles reject the entire operation. All values are copied into validated results; no global game object, renderer, wallet or random generator is accessed. `applyEncounterSnapshot` can also operate on an existing uniform or weighted scenario without changing its format, health, damage, experience reward, availability or encounter table.

## Formula policy and numerical order

`public/config/encounter-rules.json` contains required versioned coefficients and variation bounds matching the legacy factory. The same strict TypeScript parser validates this document in builds and at runtime. The policy participates in the SHA-256 release manifest and canonical/versioned publication. `loadRoutePreparationPolicies` loads health and encounter policies from that one pinned release with shared size, timeout, cancellation and integrity checks; it never returns a partial bundle.

Money follows `PokemonFactory.routeMoney`, then `Amount`, then `Wallet`:

1. Calculate route money with the explicit sampled deviation and configured minimum.
2. Round the base with `Math.round`, as the `Amount` constructor does.
3. Apply the resolved money bonus and floor the result.

The intermediate round is observable: normalized route 10, deviation -25 and multiplier 1.5 yield 114, not 113.

Normal capture tokens follow `PokemonFactory.routeDungeonTokens`, then `Battle.gainTokens`, then `Wallet`. Preserve the legacy division and multiplication by the configured currency conversion rate, round up, apply the resolved token bonus, then round down. The algebraically redundant conversion remains to preserve floating-point operation order. Luxury Ball random currency rewards are not covered by this token-only adapter.

Catch chance follows `PokemonFactory.catchRateHelper` and `Battle.calculateActualCatchRate`: floor the powered base catch stat, add the explicit sampled variation, clamp to 0–100, add resolved ball and Oak bonuses, clamp again, then convert percent to probability. Capture duration is a required positive integer supplied by the ball adapter; no default ball or duration is inferred.

Numbers must be finite and within supported ranges; sampled deviations must be integers inside the configured bounds. Unsupported versions, missing/extra fields, accessors, unsafe arithmetic and invalid duration are rejected. The legacy wallet's corrupt-input repair is deliberately not reproduced. Zero wallet multipliers are allowed; final zero rewards are valid.

## Sampling, persistence and scope

These are **resolved session snapshots**, not dynamic encounter generation. The caller supplies sampled money/catch deviations. The preparation code consumes no random draws and does not reroll on each spawn. Repeated spawns use the prepared opponent rules. Full production migration still requires per-encounter sampling, explicit RNG ordering and versioned checkpoint storage of sampled encounter attributes; this PR does not claim that parity.

Checkpoints retain the concrete prepared money, tokens, chance and duration through existing scenario serialization. Restoring against changed prepared rules is rejected rather than silently migrating or overwriting the original. Existing lab scenario data, balance and save compatibility remain unchanged. The release manifest changes because a new policy document is published; the lab still loads its three required documents.

Experience remains the existing explicit scenario value. This adapter does not distribute experience across party members, apply level caps, manage balls, select Luxury Ball currency, consume bonus items or mutate historical statistics/quests/breeding. Dynamic party/weather changes and live-game activation remain outside this preparation boundary.

## Validation

- Differential tests call the actual factory, `Amount`/`Wallet`, `Battle.gainTokens` and catch-rate methods with controlled resolved inputs: 60 route/region/deviation combinations and 60 catch-stat/variation/ball-bonus combinations.
- Simulation tests cover both clamp stages, intermediate money rounding, fractional bonuses, policy validation, complete profile matching, preparation atomicity and checkpoint compatibility.
- Configuration tests verify pinned loading, missing/stale second documents, build validation and release identity.
- The emitted-worker persistence suite runs the complete prepared scenario, saves during capture and a route transition, terminates/restores the worker and compares subsequent snapshots, events, command outcomes, progress and checkpoint state against direct combat.

Review numerical operation order, the explicit sampling boundary, complete profiles and the normal-token-only scope before merging.
