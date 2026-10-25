# Combat checkpoints and recovery

This milestone adds a versioned route-combat checkpoint, restoration through the direct/worker hosts and a separate browser storage adapter. It preserves simulation time, attack timers, pending captures, accepted queued commands, progression, encounter identity and random state. Tests compare resumed play with uninterrupted play, including termination and reconstruction of the emitted worker.

This is persistence for the current ECS route prototype. It is not an importer for the legacy game's complete save, a wallet/quest bridge, automatic saving, offline progression or live-page activation. Existing player saves are neither read nor modified.

## Persisted data and validation

`CombatCheckpoint` format 1 names the `xorshift32` algorithm and carries the validated combat/simulation configuration and resolved scenario. These embedded rules are compared with the caller's expected rules before restoration; changed rules, unknown versions and custom random functions reject explicitly. Object-property order does not affect compatibility, while catalog array order remains significant because it can affect deterministic selection. There is no silent migration or fallback to current balance values.

The save uses stable route/Pokemon references and plain progression records, not component-map layout, Knockout observables or JavaScript class serialization. Its full combat snapshot retains encounter identity and committed time. The opponent's source route is stored separately from the selected route: changing routes while a capture is pending must still settle that capture against its original route.

Boundary validation checks exact data fields, numeric ranges, step/time consistency, known unlocked routes and opponents, catalog health, capture deadlines, RNG range, encounter identity progression, attack counters, command sequence/time/horizon, duplicates and progression totals. Ball inventory and the event sequence must agree with defeat/capture-attempt counts. Unknown or incompatible input rejects before replacing a world. Valid input is detached and frozen; the original remains unchanged. These checks enforce format and state consistency, not authenticity or anti-cheat protection.

An engine checkpoint preserves already accepted but unprocessed input. Restoration creates a new command receiver at the accepted cursor and rebinds queued commands to the requested session ID. It does not re-submit those commands, re-award past rewards or replay historical events. New input continues the combat sequence; the host's `seed` option is only used for a fresh world, while restoration uses the persisted RNG state.

## Host boundary and worker protocol

`HostCheckpoint` format 1 wraps combat state with `activeTimeMs`, including fractional milliseconds and unprocessed active-time debt. A newly restored host starts stopped. Starting anchors its external monotonic clock at the new process's current reading, preserving the saved timeline without adding time spent stopped or between processes. Offline rewards require a separate policy and are not inferred from wall-clock time.

`host.checkpoint()` requires a usable stopped host with no unacknowledged output. Stop first, consume and acknowledge every pending batch, then request a checkpoint. Queued commands may remain; they are included in the save. Refusing undrained output prevents restoration from losing delivery state or re-emitting events that a consumer may already have handled. Reading a snapshot still does not acknowledge anything. A failed save request does not resume, reset or discard the session.

Worker transport version **2** adds a checkpoint request/reply and validated stream cursors to initialization. The proxy validates restored snapshot/cursors against the requested checkpoint and verifies exported state against its delivered snapshot and stream positions. A resumed session emits only new events and outcomes. Version 1/2 combinations reject instead of guessing compatibility; deploy the matching proxy and worker together.

The one-outstanding-request policy remains in force. A runtime controller must serialize stop, output acknowledgments, checkpoint acquisition and storage. A checkpoint attempted while an output delivery is still in flight can reject; finish handling output before retrying. Faulted/disposed hosts cannot export a new checkpoint. Previously committed storage remains available independently of a worker failure.

## Browser storage and commit semantics

`CheckpointStore` accepts storage and exclusive-access ports plus required slot/byte-limit policy and expected rules. `createBrowserCheckpointStore` uses localStorage and Web Locks; it fails explicitly if locks are unavailable. Cooperating writers share an origin-scoped exclusive lock for the slot. No fallback performs an unlocked read/modify/write.

Keys use `pokeclicker:ecs:checkpoints:v1:<slot>:` with `current`, `previous`, `import-original` and `recovery-original` suffixes. The adapter never enumerates or accesses legacy save keys. It retains one previous record and the most recent original import/recovery document, not unbounded history.

A write supplies the expected revision UUID (or null for an empty slot). Under the lock the store rereads and validates the current record; a stale revision rejects. Each successful write/recovery obtains a fresh UUID, preventing an old writer from matching a revision reused by rollback. All cooperating writers must use this adapter/lock; it cannot police unrelated scripts that write directly to storage.

The adapter validates and checks UTF-8 byte limits before writes. It preserves the previous current record before replacing `current`; that single-key replacement is the commit point. If validation, quota, permission, backup or current-key writing fails, the prior current record is not replaced. Auxiliary backup/original keys may already have been written before a later failure; this is not a multi-key transaction. Web Storage's failure-atomic replacement does not promise physical disk durability or immunity to browser eviction.

`importText` validates a host-checkpoint JSON document before any writes and retains its exact original text on a successful commit path. The source text/file is not modified. `exportText` returns the current validated host checkpoint. A malformed or incompatible current record blocks ordinary writes rather than being overwritten.

`recoverBackup()` is an explicit rollback: validate the backup, retain current bytes in `recovery-original`, then replace current with the backup under a new revision. It never silently selects older progress during an ordinary read. An absent/invalid backup, an oversized original or failure to preserve that original prevents recovery. Recovery can intentionally lose progress newer than the backup, so a future UI must label that action clearly.

No persistence size, slot or interval is hidden in production code. The required storage policy used in tests comes from `tests/fixtures/runtime/checkpoint-policy.json`. Production assembly must supply validated JSON policy; no auto-save interval or runtime configuration fallback is introduced here.

## Validation and remaining integration

Engine tests round-trip JSON at multiple points before, during and after capture, then compare subsequent snapshots, commands, events, RNG and progression exactly. Other cases cover cooldown continuity, source-route capture, fractional Pokemon IDs, rule incompatibility, mutated caller objects and malformed checkpoints.

Host/worker tests cover fractional time and debt, stop/drain gating, resumed stream cursors, pending commands and invalid checkpoint replies. Storage tests cover competing writers, stale revisions, write failures, byte limits, preserved imports, corrupt-current recovery and browser lock selection. The emitted worker test persists during capture, terminates the first worker, restores a new session from storage and compares a 12-second timeline with an uninterrupted engine.

The storage failure/coordination tests use injected ports; browser API selection is mocked. Real-browser quota/eviction, multi-tab UI behavior, production autosave, legacy import/export, offline policy and a single-authority bridge to historical progression still need integration checks before activation.

Platform references: [Web Locks](https://www.w3.org/TR/web-locks/) and [Web Storage failure semantics](https://www.w3.org/TR/2021/SPSD-webstorage-20210128/).

## Portable lab workflow

The [portable checkpoint UI](portable-checkpoints.md) now uses storage-free `previewImport` and `serializeCheckpoint`, bounded strict UTF-8 file reading, explicit confirmation and prepared worker replacement. The existing import/recovery commit semantics and version-one checkpoint formats remain unchanged. Exporting live progress pauses the session without replacing the saved slot.
