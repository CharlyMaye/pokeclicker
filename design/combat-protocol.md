# Route combat messages and save baselines

This slice defines the first simulation/presentation contract and adds synthetic legacy persistence fixtures. It does not implement an ECS world, a worker, an importer or a renderer. The existing game remains active.

## Message contract

Every message carries a protocol version, session identifier, sequence and `atMs` timestamp. The protocol version is independent of configuration and save versions. The host assigns a fresh session identifier when starting or replacing a world; a receiver rejects messages from any other session.

`atMs` is a nonnegative safe integer on the simulation's monotonic timeline, in milliseconds from the session origin. It is not a civil timestamp or `Date.now()`. The future host must translate input times into this timeline without rounding them to the simulation step. Commands at 50 ms and 100 ms remain distinct even if they are processed during one 100 ms update.

| Stream | Initial sequence | Ordering rule | Receiver behavior |
| --- | --- | --- | --- |
| Commands | 1 | Contiguous, nondecreasing time | Reject duplicates, gaps, backward time and foreign sessions. |
| Snapshots | 0 or a newer sequence | Gaps permitted, nondecreasing time for accepted updates | Keep the newest complete snapshot; ignore older or duplicate sequences. |
| Events | 1 | Contiguous, nondecreasing time | Reject gaps; ignore previously received sequences within this live session. |

Each stream has its own sequence. Equal timestamps are allowed and ordered by sequence. Sequence numbers cannot wrap; start a new session before the safe integer range is exhausted. Rejected messages do not advance receiver state.

Commands initially cover `ClickAttack` and `ChangeRoute`. A route reference uses the current numeric region and route identifiers, with routes starting at 1. This is a route-combat protocol; towns (`route: 0`), other battles and subregion transitions are outside its first version. Catalog existence, region unlocks, action availability, cooldowns and timestamps relative to the world's current time remain simulation/host checks. Passing message validation does not make an action legal or apply it.

Snapshots describe a location and an idle, fighting or capturing encounter. Enemy projections contain a session-local encounter identifier, a stable catalog Pokémon identifier, current health and maximum health. Fractional Pokémon form IDs are preserved. Capture snapshots include the simulation deadline; the renderer cannot decide capture completion. Dead enemies are not valid fighting projections, and capturing enemies must be defeated with a non-past deadline.

The initial events are `EnemyDefeated` and `CaptureResolved`. They describe outcomes, not instructions to grant money or modify inventory. Authoritative progression stays in the simulation. A future bridge that applies external rewards must add durable acknowledgment/idempotency around the actual mutation; this receiver only suppresses transport redelivery in memory. It does not promise exactly-once effects across crashes, handler failures or session replacement.

## Validation and ownership

The parsers accept unknown input and reconstruct a detached, frozen message with read-only TypeScript types. They require known versions, variants and exact fields, finite numbers, safe integer counters/times, and consistent health/phase relationships. Plain structured-clone data is expected; arrays, class instances, accessors and unexpected properties are rejected at object boundaries.

These are code-defined wire contracts. Their constants and field names are protocol structure, not gameplay tuning. They contain no observables, HTML, sprite paths, storage calls or rendering methods. Contracts and receivers compile without DOM and Node globals.

The command receiver stores only ordering state; it is not a queue or a scheduler. The snapshot receiver stores one projection for a display loop to read at any frequency. The event receiver detects a gap so the host can request resynchronization rather than silently skip it. The future host must define byte/queue limits, timestamp horizons, backpressure and resynchronization behavior before accepting external traffic. None of those policies is hidden in these receivers.

## Legacy save evidence

The fixture files in `tests/fixtures/legacy-saves/` are small synthetic subsystem extracts in the legacy `{ player, save, settings }` envelope. They contain no user data and are not advertised as complete playable saves. Tests execute the actual `Save`, `Player`, `Party`, `PartyPokemon`, `Pokeball` and `Pokeballs` persistence methods and the module `Wallet` serializers, with an isolated in-memory storage adapter. The actual `SaveSelector` codec checks Unicode and percent-sign preservation.

The harness supplies peripheral services, translation, catalog construction, empty settings/achievement data and the version marker. It avoids Party's unrelated constructor computations and does not run the old version-migration chain, complete game initialization, route validation or offline progression. This isolates serialized field compatibility from unrelated game startup behavior.

The cases cover a starter on route 1, later progress on route 29 with numeric Pokémon save keys and a fractional form ID, and an empty party in town after an absence. Module and player round trips must preserve the fixture and leave the input unchanged. Storage tests verify the separate `player`, `save` and `settings` keys and retain an untouched original copy.

Current save collection includes only objects with a `saveKey`. Active battle state, a capture countdown and RNG state are not represented by these legacy exports. An importer cannot reconstruct an in-flight encounter or a deterministic random history that the source never saved. Define recovery at the migration boundary explicitly; do not manufacture pending rewards or capture results from missing state.

## Checks and next work

Protocol tests cover validation, immutable projections, independent display sampling, sequence/session failures and recovery after rejection. Type checks ensure renderers cannot mutate nested projections. Ten persistence/codec tests cover the three fixtures and legacy rounding of fractional attack bonuses, alongside the existing combat baseline.

Next: implement the headless route-combat world against these contracts and the behavioral baseline. Keep save import inactive until its target save format, version policy, recovery rules and preservation of the original are implemented and tested.
