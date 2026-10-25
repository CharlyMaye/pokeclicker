# Live progression across simulation, worker and presentation

The combat lab now displays money, experience, dungeon tokens, remaining balls, defeats, applied click attacks, captured Pokemon counts and per-route defeats/captures. Both the Knockout and diagnostic presentations receive complete committed totals. Rendering, view replacement and reloading a save never apply rewards.

## One committed frame

`CombatProgress` is an immutable data contract. `CombatFrame` pairs it with the existing version-one `CombatSnapshot`; the snapshot header identifies the session, sequence and committed time for the entire frame. No second independently timed progress stream exists.

The engine projects progress from the candidate world before committing an advance. The returned `AdvanceResult` retains that advance's progress even when later advances change the world. Projection failure remains inside the existing transaction boundary. The direct host exposes `latestFrame` and keeps its legacy `latest` combat-only accessor.

Worker transport version 3 adds required progress to initialization and each output batch. An old version-two worker is rejected rather than treated as a source of zero totals. The main-thread proxy validates the entire batch, then replaces its frame and stream cursors together. A queued batch carries its own earlier totals: the server must not attach the current world progress when delivering an older retained batch. Acknowledgment and bounded backpressure are unchanged.

## Defensive boundary

The contract parser copies and freezes all data, rejects extra/missing properties, accessors, sparse or oversized arrays, duplicate identifiers, invalid numbers and inconsistent aggregate totals. Catalog IDs may be fractional. Lists are sorted canonically after validation; input order is not gameplay state. List capacities come from the initialized scenario's route and unique opponent counts, not a presentation default.

The worker proxy additionally checks known Pokemon and eligible route references, remaining inventory, event/click cursors, nondecreasing accumulated rewards and route totals, defeat deltas and exact per-Pokemon capture deltas against delivered events. Initial progress must match the requested fresh state or checkpoint. A checkpoint reply must agree with the already delivered progress. Invalid data terminates the proxy while retaining its last complete frame for diagnostics.

These checks detect transport/state inconsistencies, not cheating. The proxy does not reimplement the simulation's reward calculations or independently authorize wallet changes. A same-origin script with control of the client remains outside this validation guarantee.

The monotonic rules match the current prototype, where accumulated money/experience/tokens cannot be spent and capture inventory cannot be replenished. Adding shops, inventory replenishment, rewards from other systems or reset mechanics requires an explicit protocol/rule change and tests; those features must not silently bypass these checks.

## Replaceable presentations

`PresentationLoop<T>` retains its existing combat-snapshot default and can now read a complete frame through the same scheduler/lifecycle logic. The lab supplies a frame source to `CombatSessionRenderer`. The latter validates and orders the entire frame before passing combat and progress to its chosen adapters.

`ProgressViewModel` produces strings and canonical table rows without DOM, Knockout, clocks or simulation imports. Plain DOM and Knockout adapters render the same model. All labels and empty/waiting messages come from required `lab.json` progress labels, using lab configuration version 2. Labels become text nodes or text bindings, never HTML or executable bindings. Table bindings use only fixed adapter-owned identifiers.

Duplicate/stale frames do not update either panel. Newer frames with unchanged progress do not rewrite totals or table rows. Disposal removes the private subtree and Knockout subscriptions/bindings. A replacement view can render the current frame immediately without restarting combat or replaying events.

Tables include every record within the current scenario's bounds. This is suitable for the small lab scenario; production-size catalogs will need measured rendering budgets and pagination or another view policy before expansion. No virtualized-list performance claim is made.

## Checkpoint compatibility

Combat commands/snapshots, host checkpoints and combat checkpoints remain version 1. Their stored fields and gameplay rules are unchanged. Existing lab saves restore in a fresh stopped worker, and initialization publishes their totals before the first wake or command. Canonicalization also permits valid checkpoint records with differently ordered capture/route arrays.

The new lab labels and bundle change the hashed configuration release, but checkpoint compatibility still compares only the existing combat/simulation rules and scenario. Presentation changes do not invalidate progress. Legacy saves and progression are still separate and are never read or written by this lab.

## Review and validation

1. Defeat an opponent: money and experience update immediately, one ball is consumed, and the route defeat appears while capture is pending.
2. Finish a successful capture: the captured count, route capture and tokens update together. Failure does not grant those rewards.
3. Change routes during capture: the pending encounter keeps its source-route progress while the selected destination changes.
4. Switch presentations repeatedly and pause. Totals must remain unchanged without extra combat advances or reward application.
5. Save, make more progress, then reload or restore the previous save. Confirm that the stopped session displays the restored totals immediately.

Tests cover immutable/canonical contracts, malformed and oversized records, queued progress, atomic rejection, checkpoint compatibility, both renderers, unchanged-frame DOM writes, teardown and labels containing markup. Existing real-worker timelines now compare progress in every batch at zero/one/seven display frames. The emitted lab test verifies displayed rewards through renderer switching and save/reload/recovery. The existing simulation and legacy characterization suites remain in CI.

The browser-bundle test uses jsdom plus an actual Node worker thread. Manual browser/layout/accessibility checks remain distinct from those integration tests. Production party inputs, content, indirect progression, offline rules and activation inside the legacy game remain outstanding.
