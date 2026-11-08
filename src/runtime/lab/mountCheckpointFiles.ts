import { CombatSessionRenderer } from '../../client/renderers/CombatSessionRenderer';
import { element } from '../../client/renderers/elements';
import { CheckpointDownload, readCheckpointFile } from '../persistence/checkpointFiles';
import type { CombatLabController } from './CombatLabController';
import type { LabConfiguration } from './configuration';

export interface CheckpointFileUiPorts {
    readonly changed: () => void;
    readonly execute: (action: () => Promise<void>, success?: string) => Promise<void>;
}

/** File selection and preview are read-only. Only the explicit confirmation imports the staged text. */
export function mountCheckpointFiles(container: HTMLElement, controller: CombatLabController, lab: LabConfiguration, ports: CheckpointFileUiPorts) {
    const document = container.ownerDocument, text = lab.text;
    const root = element(document, 'section'); root.className = 'ecs-checkpoint-files';
    root.appendChild(element(document, 'h2', text.fileHeading));
    const exportButton = element(document, 'button', text.export); exportButton.type = 'button'; exportButton.dataset.action = 'export'; root.appendChild(exportButton);
    const downloadLink = element(document, 'a', text.download); downloadLink.dataset.action = 'download'; root.appendChild(downloadLink);
    const label = element(document, 'label', text.chooseFile);
    const input = element(document, 'input'); input.type = 'file'; input.accept = '.json,application/json'; input.dataset.control = 'checkpoint-file';
    label.appendChild(input); root.appendChild(label);
    root.appendChild(element(document, 'p', text.importHelp));
    const preview = element(document, 'fieldset'); preview.hidden = true;
    preview.appendChild(element(document, 'legend', text.confirmImport));
    const filename = element(document, 'p'); preview.appendChild(filename);
    const details = element(document, 'div'); details.dataset.checkpointPreview = ''; preview.appendChild(details);
    const confirm = element(document, 'button', text.confirm); confirm.type = 'button'; confirm.dataset.action = 'import-confirm'; preview.appendChild(confirm);
    root.appendChild(preview);
    const cancel = element(document, 'button', text.cancel); cancel.type = 'button'; cancel.dataset.action = 'import-cancel'; cancel.hidden = true; root.appendChild(cancel);
    container.appendChild(root);

    const download = new CheckpointDownload(downloadLink, {
        createObjectURL: blob => URL.createObjectURL(blob), revokeObjectURL: url => URL.revokeObjectURL(url),
    });
    let disposed = false, reading = false, blocked = false;
    let staged: string | null = null;
    let abort: AbortController | null = null;
    let previewRenderer: CombatSessionRenderer | null = null;
    const cleanups: (() => void)[] = [];
    function listen(target: EventTarget, name: string, callback: EventListener) {
        target.addEventListener(name, callback); cleanups.push(() => target.removeEventListener(name, callback));
    }
    function clearPreview() {
        staged = null; previewRenderer?.dispose(); previewRenderer = null;
        preview.hidden = true; filename.textContent = ''; cancel.hidden = !reading;
    }
    function update(disabled: boolean) {
        blocked = disabled;
        if (disposed) {
            return;
        }
        const usable = controller.state === 'running' || controller.state === 'stopped';
        exportButton.disabled = blocked || reading || staged !== null || !usable;
        input.disabled = blocked || reading || staged !== null;
        confirm.disabled = blocked || reading || staged === null;
        cancel.disabled = blocked && !reading;
    }
    listen(exportButton, 'click', () => {
        void ports.execute(async () => {
            const value = await controller.exportCheckpoint();
            if (!disposed) {
                download.prepare(value, lab.checkpointFilename); downloadLink.focus();
            }
        }, text.exportReady);
    });
    listen(input, 'change', () => {
        const file = input.files?.[0]; input.value = '';
        if (!file || disposed || reading || staged !== null || blocked) {
            return;
        }
        const operation = new AbortController(); abort = operation; reading = true; cancel.hidden = false; ports.changed();
        void ports.execute(async () => {
            try {
                const value = await readCheckpointFile(file, lab.maxCheckpointBytes, operation.signal);
                if (disposed || operation.signal.aborted) {
                    return;
                }
                const checkpoint = controller.previewImport(value);
                const renderer = new CombatSessionRenderer(details, checkpoint.combat.snapshot.sessionId, 'dom', lab.combatLabels, lab.progressLabels, {
                    maxCaptured: new Set(lab.scenario.routes.flatMap(route => route.opponents.map(opponent => opponent.pokemonId))).size,
                    maxRoutes: lab.scenario.routes.length,
                    ...(lab.scenario.formatVersion === 4 ? { maxParty: lab.scenario.party.members.length } : {}),
                });
                try {
                    renderer.render({ snapshot: checkpoint.combat.snapshot, progress: { ...checkpoint.combat.progress, pokeballs: checkpoint.combat.pokeballs },
                        ...(checkpoint.combat.formatVersion === 3 ? { party: checkpoint.combat.party } : {}) });
                } catch (error) {
                    renderer.dispose(); throw error;
                }
                previewRenderer = renderer; staged = value;
                filename.textContent = `${text.selectedFile}: ${file.name}`; preview.hidden = false;
            } catch (error) {
                if (!operation.signal.aborted) {
                    throw error;
                }
            } finally {
                reading = false; abort = null;
                if (!disposed) {
                    cancel.hidden = staged === null; ports.changed();
                    if (staged !== null) {
                        confirm.focus();
                    } else if (operation.signal.aborted) {
                        input.focus();
                    }
                }
            }
        });
    });
    listen(confirm, 'click', () => {
        const value = staged;
        if (value === null || blocked || reading || disposed) {
            return;
        }
        void ports.execute(async () => {
            await controller.importCheckpoint(value);
            if (!disposed) {
                clearPreview(); ports.changed(); input.focus();
            }
        }, text.imported);
    });
    listen(cancel, 'click', () => {
        abort?.abort(); clearPreview(); ports.changed(); input.focus();
    });
    return {
        get reading() {
            return reading;
        },
        get pending() {
            return reading || staged !== null;
        },
        update,
        dispose() {
            if (!disposed) {
                disposed = true; abort?.abort(); clearPreview(); download.dispose();
                cleanups.forEach(cleanup => cleanup()); root.remove();
            }
        },
    };
}
