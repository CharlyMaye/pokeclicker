# Live party progression

Scenario version 4 now publishes party experience and levels in the same committed frame as combat and aggregate progress. Consumers no longer need to pause and export a checkpoint to inspect party state. The simulation remains the only owner of progression; renderers format immutable values and never apply reward events.

## Frame and transport contracts

`CombatFrame` and `AdvanceResult` carry `party` for party-enabled scenarios. It contains `grants`, `shadowExperience` and ordered `members` with stable Pokémon ID, experience and level. The component projection is detached and deeply frozen before the combat advance commits. Direct hosts retain the projection belonging to each queued batch. Worker initialization, queued output and restored sessions deliver the same shape.

`ProgressLimits.maxParty` is derived from the initialized roster. Its presence requires a party payload, including when the roster is empty. Its absence rejects party payloads and preserves the old non-party frame shape. The presentation parser rejects malformed, oversized, sparse, accessor-backed or duplicate records, invalid numbers and grants inconsistent with the frame's defeat count. Fractional experience and Pokémon IDs are preserved.

The worker proxy additionally checks membership, roster order, level curves, caps and initial-state constraints using the existing party checkpoint validator. Initialization must match the requested initial or saved party. Later frames cannot regress experience, levels or shadow experience, or change party state without a new defeat. These are consistency checks, not authentication or a replay of all historical rewards. No experience is awarded on the main thread. A checkpoint must match the last delivered party as well as combat/progress and stream cursors.

Transport version **4** rejects old cached workers explicitly. Combat protocol, scenario, checkpoint and storage versions are unchanged. Party-enabled checkpoints remain combat version 3; older saved scenarios retain their previous formats. Worker and client bundles must be deployed together.

## Replaceable presentation

The DOM and Knockout adapters consume the same validated frame and display the roster's experience and levels, grant count and calculated shadow experience. Shadow experience is the accumulated input for future purification integration, not final chamber flow. An enabled empty roster and a session without party progression have distinct notices. No level thresholds, caps or reward calculations are duplicated in either renderer.

All new labels are required in public `lab.json`; the lab configuration advances to schema version **4** and its pinned release manifest is regenerated. The default lab scenario and save slot remain unchanged, so it reports that party progression is disabled. A prepared version-4 scenario supplied through the existing lab configuration receives the new panels automatically. This does not activate the historical party or change existing balance.

Both adapters avoid rewriting unchanged party table rows. A malformed frame is rejected before any combat/progress panel is updated or its sequence is consumed. Stale/duplicate frames are ignored. Renderer replacement or differing presentation frequencies do not advance the world. Checkpoint file previews use the same party panel without importing the file or changing the active session; cancel/dispose removes the preview and bindings.

## Validation and limits

Tests cover immutable projections, malformed data, initialization, delayed worker delivery, consistency failures, checkpoint comparison and pre-wake restore. Real emitted workers are compared with direct combat with zero, one and seven presentation frames per wake, including renderer replacement. DOM/Knockout tests verify actual fractional gains and cap levels, unchanged nodes, safe text labels, disposal and corrected-frame retries. A jsdom checkpoint preview test verifies saved party values without import or simulation mutation.

Evolution, dynamic roster/caps/bonuses, damage recalculation, recruitment and historical party/purification ownership remain separate work. The fixed roster is bounded by the supplied scenario and the existing checkpoint byte limit; this milestone does not establish a measured full-production roster performance budget. UI tests use jsdom, not manual browser gameplay.
