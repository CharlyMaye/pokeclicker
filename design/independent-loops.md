# Independent simulation and presentation loops

`DirectCombatHost` owns a headless ECS engine and its scheduling. `PresentationLoop` reads immutable snapshots through a `CombatSnapshotSource` and passes them to a `CombatRenderer`. The renderer exposes only `render(snapshot)` and `dispose()`; it cannot advance the engine, mutate combat or acknowledge output through that interface.

This is the direct-host lifecycle foundation. The browser adapters use a timer for simulation wakes, `requestAnimationFrame` for display frames and `performance.now()` for monotonic time. They do not start themselves or replace the legacy game loop. Actual worker execution, concrete Knockout/DOM renderers, production input resolution and live activation remain future work. Both loops still share a thread in the direct host, so long rendering work can delay timer delivery; this slice establishes independent scheduling and state ownership, not CPU isolation.

## Active time and lifecycle

The host samples its injected clock when starting, waking, stopping or explicitly requesting `inputTimeMs()`. It accumulates active elapsed time and floors only the final millisecond timestamp, preserving fractional time across samples and pauses. The simulation still processes complete configured steps and preserves intra-step command/capture times.

`start()` is idempotent. `stop()` samples outstanding active time, cancels the pending wake and retains time debt, queued input and undelivered output. Starting again anchors the clock at its new value: explicitly stopped time is excluded, while previously accumulated debt is preserved. This is a pause policy, not offline progression. A throttled or blocked host that has not been stopped still accrues active-time debt. A production visibility/resume adapter must decide when to stop and how to apply offline rewards before activation.

Each wake advances at most `maxStepsPerAdvance` and schedules another wake after `stepMs` if capacity allows. `sampledTimeMs` reports the last sampled active time; display reads do not sample the clock. Commands are still validated by the engine, including queue limits, sequence order and the future horizon. `inputTimeMs()` does not silently move an input into the future: a command submitted at an already committed boundary is explicitly rejected without consuming its sequence. The future input adapter must handle that case and backpressure during large time debt.

`dispose()` ends the session's scheduling permanently and retains its bounded unread output and last committed projections for inspection. Stale, canceled and repeated callbacks cannot advance a stopped, restarted or disposed host. A renderer can be replaced by disposing its presentation loop and creating another against the same snapshot source; the host's world and clock continue unchanged.

## Delivery and bounded buffering

Simulation configuration version 3 adds required `maxPendingOutputs`, initially 8. It bounds the count of committed `AdvanceResult` batches retained by the direct host. Per-call work remains bounded by the engine's existing limits. This initial capacity is a configurable safety policy, not a measured performance target.

`pendingOutput` exposes the oldest immutable batch. After handling it, the runtime consumer calls `acknowledge(batch.snapshot.sequence)`. Acknowledgments must match the oldest batch exactly; duplicate, missing and out-of-order acknowledgments reject without removing output. Reading `latest` for presentation does not acknowledge commands or events. The latest snapshot can replace an older display projection, while unacknowledged batches retain every event and command outcome.

An optional synchronous `onOutputAvailable` callback notifies the runtime after commit, outside the engine mutation. It can drain and acknowledge batches without a display or a polling loop. For asynchronous transport it should initiate delivery and acknowledge later; returning a promise is rejected to prevent overlapping consumers. With no consumer, or delayed acknowledgment, the host stops scheduling when the queue reaches capacity. Releasing capacity schedules the next wake and processes accumulated debt within the existing budget.

The output queue is in memory, not a durable save or an exactly-once transaction with external storage. Consumers must acknowledge only after the delivery guarantee they actually need. Durable reward bridges and crash recovery still need their own protocol. Events do not independently award rewards: progression remains owned by the engine.

## Failure isolation

Expected command errors reject that submission without faulting the host. Invalid or regressing clocks, scheduler faults and simulation faults stop scheduling and retain diagnostics. A simulation processing fault keeps the engine's previous committed state, as before. Failure while delivering output or scheduling the next wake occurs after commit: the committed state and unread batch remain available, and the host stops rather than rolling back an already published result. A faulted host permits acknowledgment of already handled output but cannot restart.

The presentation loop has its own fault state. Source, renderer or frame-scheduler failure stops that display loop without touching the simulation host. Disposal is idempotent and records cleanup failures. Explicit callback identity and lifecycle checks reject stale frames, including a snapshot source that stops and restarts the display during a read.

Scheduler ports return idempotent cancellation functions and must invoke callbacks asynchronously. Inline callbacks and missing cancellation functions are rejected. Cancellation failures invalidate callbacks before cleanup is attempted, so a late callback still cannot resume work. Browser timer range limits are checked by the browser adapter rather than silently overflowing a delay.

## Validation and assembly boundary

Tests run the real ECS engine with independent manual clocks/schedulers at zero, one and seven display frames per wake, and compare snapshots, events, command outcomes and progress. Other cases cover renderer replacement after failure, FIFO saturation, acknowledgment order, fractional time, pause/resume debt, late callbacks, invalid clocks, processing/delivery failures and browser timer cancellation. Client code compiles without DOM/Node globals and cannot import simulation/runtime/legacy modules; simulation cannot import the client.

No complete game or production renderer is activated by this PR. The next assembly slice can attach two concrete presentations to this contract while completing worker execution, content resolution and progression compatibility separately. Existing Pages deployment and legacy saves remain controlled by their current code paths.
