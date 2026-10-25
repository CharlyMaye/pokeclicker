# Combat in a dedicated worker

The browser worker now runs `DirectCombatHost` and the real route ECS itself. The main thread receives frozen combat projections through `WorkerCombatHost`; it does not receive a tick instructing it to execute combat. `PresentationLoop` accepts either host through its existing snapshot-source interface, so display scheduling and renderer replacement stay independent of worker execution.

This milestone includes the transport, input translation, lifecycle, emitted browser worker, build integration and cross-thread tests. It does not activate combat on the legacy page. Production scenario/content resolution, wallet and indirect progression bridges, legacy save import/export, offline progression, visibility policy and live mounting remain separate integration work. Progression still belongs exclusively to the engine inside the worker; the transport can export a validated stopped-session checkpoint and does not award rewards from events.

## Ownership and messages

`CombatWorkerServer` owns one session and one engine. `WorkerCombatHost` owns the channel, pending request, latest received snapshot and one received batch. The transport contract requires ordered, asynchronous, structured-clone delivery. The browser adapter attaches message, messageerror and error listeners, and owns termination of its Worker.

Transport version 2 is separate from combat/configuration versions. Requests carry session ID, contiguous request ID and an exact payload: initialize, start, stop, input, acknowledge or checkpoint. Initialization validates configuration, the resolved route scenario and RNG seed on both ends. Replies identify their request and distinguish ready (with restored stream cursors), accepted, checkpoint, done and rejected. Unknown versions, foreign sessions, extra fields, invalid payloads, replayed requests or unexpected replies fail the session. All parsed outgoing projections are detached and frozen again after structured cloning.

The proxy allows one outstanding request. Callers must await it; a concurrent attempt rejects without sending or consuming a request ID. There is no implicit request queue or retry. This bounds lifecycle/input traffic from the supported proxy and makes busy input explicit. A future UI controller must serialize delivery acknowledgments and user actions, reporting busy or rejected input rather than silently discarding it.

## Input timing

The UI sends intent only: ClickAttack or ChangeRoute with its destination. The worker assigns a contiguous combat command sequence and samples its own active clock. Main-thread timestamps and clock synchronization are not needed.

If a fixed-step boundary is already committed, the command is assigned at least the next millisecond. For example, a click received exactly after the worker commits 100 ms targets 101 ms, not the past. Otherwise the original intra-step ingress time is retained, preserving distinct clicks at 50 ms intervals. This is a deliberate worker-ingress policy: transport delay can delay an action, and the protocol does not promise to reconstruct when the user physically clicked.

A running worker with available output capacity accepts valid commands into the engine queue. The accepted reply includes their assigned sequence/time; the later batch reports the gameplay result (applied, cooldown, disabled, no target, unchanged route or unavailable route). A rejected submission does not consume a combat command sequence. Stopped/full workers reject input. Queue limits and excessive catch-up debt still reject explicitly under the existing engine horizon policy. Route authorization remains owned by the simulation.

## Output and backpressure

Each output batch contains a full snapshot, all combat events and command outcomes from the committed advance, and remaining time debt. The server sends only the oldest unacknowledged batch. The direct host retains additional batches up to JSON `simulation.maxPendingOutputs`, including the batch in flight. At capacity it stops scheduling and retains active-time debt. Reading a display snapshot never acknowledges anything.

After handling a batch, the runtime calls `await host.acknowledge(batch.snapshot.sequence)`. The worker validates FIFO order, releases capacity, replies, then sends the next retained batch. That ordering prevents two batches from occupying the proxy's single slot. The proxy validates the entire received batch before advancing event/outcome cursors or replacing its snapshot: strict event/outcome continuity, session/time checks, snapshot step progression, recognized outcomes and configured batch-size bounds.

Because delivery is acknowledged, a slow consumer can make the displayed snapshot lag behind the worker's last committed state. This is an explicit bounded-delivery tradeoff. Rendering can run at any cadence, but a runtime delivery consumer must operate independently of display frames. The optional `onOutputAvailable` callback must return synchronously; it may signal asynchronous handling, which acknowledges separately. It must not return a promise or apply rewards a second time.

Queues are volatile. Acknowledgment means the consumer handled that batch, not that a durable save transaction completed. Termination loses worker-resident state and undelivered batches unless a stopped, drained session has already produced a persisted checkpoint. Crash recovery, durable delivery and exactly-once persistence are not claimed.

## Lifecycle and failures

Fresh initialization returns a time-zero snapshot and leaves the engine stopped. Checkpoint initialization returns the saved projection and validated stream cursors, also stopped. Start and stop are asynchronous, idempotent requests. Their promises resolve once the worker processed them. Stop excludes subsequent stopped time but retains previously accumulated debt, queued commands and pending output. Already posted output may arrive while stopping. Resume uses the same session and RNG state.

`dispose()` is synchronous and idempotent on the main thread: reject outstanding work, cancel its deadline, detach listeners and terminate the worker. Late callbacks/messages cannot revive it. Faults stop the session rather than silently recreating it. Previously received snapshot/output remain available for diagnostics.

A required `requestTimeoutMs` deployment option applies to initialization and each request, using an injected deadline scheduler. The browser adapter enforces its timer's representation range. No timeout value is embedded as a production default; the JSON test policy lives in `tests/fixtures/runtime/worker-policy.json`. Production assembly must supply its validated policy from configuration. A timed-out input may already have been accepted, so the proxy terminates and never retries it automatically.

Malformed protocol traffic, worker clock/engine/scheduler faults, channel failure and invalid acknowledgments are distinguishable from ordinary rejected input. Engine faults retain the direct host's last commit until worker shutdown. A consumer failure stops this transport; a renderer failure belongs to `PresentationLoop` and does not stop or mutate the worker. Browser throttling and device sleep can still delay worker timers; this implementation does not substitute active catch-up for legacy offline rewards.

## Build and assembly

`npm run build:ecs` emits `build/ecs/combat.worker.js` and a source map using a separate WebWorker TypeScript target. The normal Gulp build includes the worker and website copying preserves its subpath. CI builds the worker and executes its emitted artifact. Existing legacy script compilation remains separate.

`createBrowserCombatHost(workerUrl, options)` accepts an explicit HTTP(S) asset URL, such as `new URL('ecs/combat.worker.js', applicationBaseUrl)`, and waits for validated initialization. Supplying the URL explicitly supports deployments beneath `/pokeclicker/`. Browser origin/CSP policy still applies. Import this factory in the application assembly layer; presentation modules continue to import only their client/contracts dependencies.

The assembly supplies session ID, validated configuration, resolved scenario, seed and request deadline policy. After initialization it can construct a `PresentationLoop` using the returned host and either existing renderer, then await `host.start()`. It must also serialize input and consume/acknowledge pending output. No global legacy binding or automatic activation is added by importing the factory.

## Validation

Runtime tests exercise structured-clone channels, deterministic direct/worker comparison, pause/resume, committed-boundary input, time-debt rejection, FIFO saturation/release, failure atomicity, malformed messages, duplicate replies/requests, lost acknowledgment without retry, shutdown, deadline cancellation and browser adapter cleanup.

The emitted browser worker is also loaded in actual Node worker threads through a test-only Web Worker API bridge. Three 12-second deterministic timelines match direct-engine snapshots, all events and command outcomes at zero, one and seven display frames per update, including renderer replacement during capture. Another test blocks the main thread while native worker timers continue and verifies bounded delivery afterward. These are executable-bundle and cross-thread tests, not a real-browser visual/compatibility test or a benchmark. Production browser integration remains a later acceptance check.

See [combat checkpoints and recovery](combat-checkpoints.md) for versioned state, stopped/drained export, new-session restoration and separate storage.
