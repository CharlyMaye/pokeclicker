# Transactional party experience and levels

Scenario version 4 adds opt-in party experience components to route combat. Each committed defeat applies its shared reward to the party once, advances eligible members' levels and accumulates shadow experience in the same transaction as combat rewards, inventory, commands and RNG. This is headless party progression, not activation in the historical game.

## Definition and components

Prepare a sampled version 3 scenario as before, then call `withPartyExperience(scenario, party)` to produce a validated version 4 scenario. The party definition contains `levelCurves` and an explicit `members` list. Each member requires `pokemonId`, `curveId`, initial `experience` and `level`, `maxLevel`, `multiplier` and boolean `shadow`. IDs may include fractional forms. The party roster is independent of the route opponent catalog.

The world stores experience/level components by stable Pokémon ID, plus a grant count and cumulative `shadowExperience`. Static curve, cap and bonus inputs stay in the immutable scenario definition. Components are replaced by new values for each grant; the original world remains unchanged until the entire combat advance succeeds. A failure later in the same advance rolls back party grants along with all combat state and stops the simulation.

Initial snapshots must be internally consistent. Experience must reach the threshold for the supplied level and, while below the cap, remain below the next threshold. A member already at or above a lowered cap may retain excess experience. Caps and levels must fit their curve. Duplicate IDs, unknown curves, invalid/accessor fields, negative bonuses and unsupported numeric values fail before starting a world. Empty parties are explicitly allowed.

## Level data and semantics

`public/config/level-curves.json` contains the six existing historical growth tables, with named curve IDs. Its version 1 parser requires unique names and strictly increasing safe-integer thresholds beginning at zero and ending at the safe-integer sentinel. Table length defines the supported level range. The sentinel is a numeric representation boundary, not another playable level. Stored experience must remain below it; reaching it fails explicitly rather than reproducing the historical no-match fallback.

The policy is validated at build time, hashed into the release manifest and published beneath the project subpath. `loadLevelCurves` loads the pinned bytes through the shared size/integrity/timeout/cancellation pipeline. No threshold or level cap is silently supplied by TypeScript. Initial caps come from the supplied party snapshot.

For each defeat, the previous [grant planner](experience-rules.md) calculates individual amounts from the shared reward. The system adds the full amount only if the member starts below the cap, then follows `PartyPokemon.calculateLevelFromExp`'s ordered threshold scan and applies the cap. Exact equality promotes to the next level. Fractional experience survives; no extra floor is introduced. The grant that reaches a cap may overshoot its threshold, and subsequent grants stop adding experience. Members initially above a lowered cap retain their level and experience.

Every defeat is processed separately, even when one advance processes many simulation steps. Summing rewards first would change cap behavior and is not equivalent. Capped shadow members still contribute their calculated amount to `shadowExperience`, matching the historical return-value behavior. That total is an input for future purification integration, not final chamber flow.

## Checkpoints and observation

Version 4 scenarios require combat checkpoint version 3. The checkpoint stores `party` with `grants`, `shadowExperience` and one experience/level record per member, alongside the existing active encounter sample and RNG state. Restore reconstructs the components without awarding experience again or drawing randomness.

Validation checks exact identities, complete membership, curve/level consistency, monotonic progression from initial state, unchanged initially capped or zero-bonus members, and `grants === progress.defeats`. A zero-grant save must match initial member values and have no shadow experience. Saves cannot contain shadow experience without an eligible shadow recipient. These are consistency checks, not cryptographic proof of every historical grant; edited local saves are not authenticated.

The direct simulation exposes a detached immutable `partyExperience` projection, or `null` for older scenarios. Workers preserve and expose the same state through their existing checkpoint barrier and storage/import/export path. Live combat frames and renderers are unchanged in this milestone; they do not yet display individual party levels. No party state is inferred or mutated by a renderer.

Unversioned/version 2 scenarios retain checkpoint version 1; sampled version 3 scenarios retain checkpoint version 2. All previous shapes remain unchanged. Mismatched versions or a changed party definition/curve are rejected without migration. Host/storage envelopes and worker transport remain unchanged because they already carry versioned combat checkpoints. Choose party and route sizes within the configured checkpoint byte limit.

## Remaining integration

This state belongs only to the opt-in ECS session. The system does not read or mutate the historical party, evolve Pokémon, emit evolution effects, recalculate prepared attack damage after leveling, update caps/bonuses during play, recruit captured Pokémon into the fixed initial roster, or credit the purification chamber. Those behaviors need explicit commands, updated projections and ownership rules before live activation. The default lab still uses its existing scenario and balance.

There is no promise of full-game parity when level-triggered evolution or attack changes would occur. This milestone establishes parity for experience and level components under fixed roster, curves, caps and multipliers. Tests execute the real level/gain methods while replacing evolution's external effects.

## Validation and review

Tests compare all historical curve tables and every exact threshold promotion against real `PartyPokemon` methods, plus repeated fractional grants at multiple caps. Simulation tests cover sequential versus batched advances, pending captures, checkpoint replay, old formats, invalid data and atomic rollback after party overflow or a later spawn failure. The emitted-worker persistence suite saves, terminates and restores a party-enabled session and compares its final checkpoint with direct combat.

Review the transaction boundary, per-defeat cap semantics, version pairing, checkpoint consistency rules and the fixed-roster/evolution limitations. Passing CI supports maintainer review; it does not replace it.
