# Portable ECS checkpoints

The combat lab can export a running or paused session to a JSON file and import a compatible file after preview and confirmation. These are ECS host checkpoints, not legacy Pokeclicker saves. Combat rules, scenarios and checkpoint formats remain unchanged.

## Export without replacing browser storage

Export and pause stops the worker, drains acknowledged output and requests the same checkpoint barrier used by Save. It includes unsaved combat progress, fractional active time, pending capture, command queue, RNG and accumulated progression. `CheckpointStore.serializeCheckpoint` validates compatibility and the configured UTF-8 byte limit without reading or writing storage or acquiring a storage lock.

The page creates a Blob and exposes a Download prepared checkpoint link. The user clicks that link to save the file; preparing it does not claim that a download has completed. The filename comes from required `lab.json` configuration. A prepared download is a point-in-time snapshot and does not automatically track later progress. Its object URL remains alive until another export replaces it or the page is disposed. Allocation failure leaves any prior prepared download available.

Export stays paused on success or failure. It does not alter the saved slot's revision, create a browser-storage backup, trigger an automatic save or change the legacy save namespace.

## Select, validate and preview

The file picker accepts a user-selected file. The adapter checks its declared size against `maxCheckpointBytes` before creating a FileReader, reads an ArrayBuffer and checks the actual byte length. UTF-8 decoding is strict: malformed byte sequences fail rather than being replaced. Empty, oversized or unreadable files are rejected. Cancellation/page teardown aborts the reader and releases callbacks; late completion cannot publish a preview.

`CheckpointStore.previewImport` performs the same bounded JSON, exact checkpoint schema and configuration/scenario checks used by import, returning detached frozen data. It performs no storage reads or writes. File extension and MIME type are picker hints; content validation decides compatibility.

The preview shows the saved encounter, selected route, capture phase and progression through the existing diagnostic renderer. The selected filename and all labels are text, never HTML. Preview does not stop combat or change the saved slot. The existing session may continue while confirmation is open; confirming explicitly discards its unsaved progress. Cancel removes the preview and returns control to the original session. Labels explain the replacement and backup behavior.

## Confirm and commit

The controller revalidates the staged text, pauses/drains the current session and prepares a new stopped worker before acquiring the storage commit. Invalid input and worker startup failure do not write the save. The storage adapter then imports under the existing exclusive Web Lock and compares the expected revision. A changed revision rejects instead of overwriting another tab's save.

On successful commit, storage retains the exact decoded imported text in `import-original` and the previously saved record in `previous`, then replaces `current` with a new revision. The original source file is never modified. The prepared worker becomes active in the stopped state and the old worker/view are disposed. Displayed totals are available before the first wake.

The single current-key write remains the storage commit point. An auxiliary backup/original write can succeed before a later quota or commit failure; import is not a multi-key transaction. The backup is the previous **saved slot**, not an automatic backup of unsaved live progress. Export first when that unsaved progress must also be retained.

If storage commits but the candidate faults, page teardown occurs or the new display cannot mount, the error explicitly says the import reached storage and instructs the user to reload saved progress. The old visible session remains paused when the page still exists. Its stale revision prevents it from silently overwriting the committed import. A prepared worker is terminated immediately on teardown even while a storage lock is pending; an already requested storage operation may finish afterward, with revision protection still applied.

Existing malformed/incompatible current data blocks an ordinary import, just as it blocks Save. There is no implicit reset or fallback; previous-save recovery remains explicit. Web Storage still does not guarantee physical disk durability or immunity to browser eviction.

## Configuration and compatibility

Lab JSON version 3 requires the export filename and English file/preview/confirmation messages. File reading and import/export use the existing `maxCheckpointBytes`; there is no hidden file-size fallback or download timer policy. Regenerate the hashed release after changing JSON.

Worker transport stays version 3. Combat commands/snapshots, combat checkpoints and host checkpoints stay version 1. Files exported before the UI existed remain compatible when their combat/simulation configuration and scenario match. Labels, theme, renderer and filename are not gameplay compatibility inputs. Files from another game/scenario/configuration are rejected before replacement.

## Review and evidence

1. Export during capture before saving; verify that browser storage remains unchanged and the file contains the current pending capture/progress.
2. Preview the file in another lab session. Verify its encounter/totals and that Cancel leaves the session and saved slot intact.
3. Confirm import. The prior saved slot should remain recoverable and the imported session should start paused with restored totals.
4. Try malformed, invalid-UTF-8, empty, oversized and incompatible files; none should create a replacement worker or overwrite progress.
5. Change the saved revision from another tab between preview and confirmation; import must reject and preserve that newer record.
6. Check download behavior, focus handling, file-picker cancellation and page navigation in the target browser.

Unit tests cover reader allocation bounds/cancellation, object-URL ownership, storage-free validation/export, controller arbitration, candidate startup failure, stale revisions, commit/activation failure and teardown. The compiled browser bundle is tested with jsdom File/FileReader APIs and real Node worker threads for cross-session capture export/import, confirmation/cancel, backup recovery and hostile filenames. Actual browser download dialogs, OS filesystem writes and cross-browser storage behavior still need manual review. Production legacy-save migration and indirect progression integration remain separate work.
