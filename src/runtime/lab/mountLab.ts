import type { Configuration } from '../../contracts/configuration-types';
import { CombatSessionRenderer } from '../../client/renderers/CombatSessionRenderer';
import { element } from '../../client/renderers/elements';
import { createBrowserCheckpointStore } from '../persistence/CheckpointStore';
import { browserFrameScheduler } from '../scheduling/browserSchedulers';
import { createBrowserCombatHost } from '../worker/browserWorker';
import { CombatLabController, LabControllerOptions, LabStore } from './CombatLabController';
import { LabConfiguration, RendererKind } from './configuration';

export interface LabMountPorts {
    readonly store?: LabStore;
    readonly createHost?: LabControllerOptions['createHost'];
    readonly frames?: LabControllerOptions['frames'];
    readonly newSessionId?: () => string;
}

export function mountCombatLab(container: HTMLElement, base: URL, configuration: Configuration, lab: LabConfiguration, ports: LabMountPorts = {}) {
    const document = container.ownerDocument;
    const root = element(document, 'main'); root.className = 'ecs-lab';
    const text = lab.text;
    for (const [key, value] of Object.entries(lab.theme)) {
        const variable = key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
        root.style.setProperty(`--${variable}`, `${value}${key.endsWith('Rem') ? 'rem' : ''}`);
    }
    root.appendChild(element(document, 'h1', text.title));
    root.appendChild(element(document, 'p', text.intro));
    const back = element(document, 'a', text.back); back.href = base.href; root.appendChild(back);
    const status = element(document, 'p'); status.setAttribute('role', 'status'); status.setAttribute('aria-label', text.status); root.appendChild(status);
    const notice = element(document, 'p'); notice.setAttribute('role', 'alert'); root.appendChild(notice);
    const toolbar = element(document, 'section'); toolbar.className = 'ecs-lab-controls'; root.appendChild(toolbar);
    const view = element(document, 'section'); view.className = 'ecs-lab-view'; root.appendChild(view);
    const confirmation = element(document, 'fieldset'); confirmation.hidden = true;
    const prompt = element(document, 'legend'); confirmation.appendChild(prompt); root.appendChild(confirmation);
    root.appendChild(element(document, 'p', text.storageNotice));
    root.appendChild(element(document, 'p', text.rendererNotice));
    container.appendChild(root);
    let disposed = false;
    let confirmAction: (() => Promise<void>) | null = null;
    let confirmOrigin: HTMLElement | null = null;
    let controller: CombatLabController | undefined;
    const cleanups: (() => void)[] = [];
    const controls = new Map<string, HTMLButtonElement>();
    function listen(target: EventTarget, name: string, callback: EventListener) {
        target.addEventListener(name, callback); cleanups.push(() => target.removeEventListener(name, callback));
    }
    function requireController(): CombatLabController {
        if (!controller) {
            throw new Error('Lab is not initialized');
        }
        return controller;
    }
    function report(error: unknown) {
        if (!disposed) {
            notice.textContent = `${text.failed}: ${error instanceof Error ? error.message : String(error)}`; update();
        }
    }
    async function execute(action: () => Promise<void>, success = '') {
        if (disposed) {
            return;
        }
        notice.textContent = '';
        try {
            await action(); if (!disposed) {
                notice.textContent = success;
            }
        } catch (error) {
            report(error);
        } finally {
            update();
        }
    }
    function button(name: string, label: string, action: () => void, parent = toolbar) {
        const control = element(document, 'button', label); control.type = 'button'; control.dataset.action = name;
        listen(control, 'click', action); parent.appendChild(control); controls.set(name, control); return control;
    }
    function ask(origin: HTMLElement, message: string, action: () => Promise<void>) {
        confirmAction = action; confirmOrigin = origin; prompt.textContent = message;
        confirmation.hidden = false; update(); controls.get('confirm')?.focus();
    }
    button('start', text.start, () => {
        void execute(() => requireController().start());
    });
    button('pause', text.pause, () => {
        void execute(() => requireController().pause());
    });
    button('attack', text.attack, () => {
        void execute(() => requireController().attack());
    });
    button('save', text.save, () => {
        void execute(() => requireController().save(), text.saved);
    });
    const load = button('load', text.load, () => ask(load, text.confirmLoad, () => requireController().load()));
    const recover = button('recover', text.recover, () => ask(recover, text.confirmRecover, () => requireController().recover()));
    button('confirm', text.confirm, () => {
        const action = confirmAction; confirmAction = null; confirmation.hidden = true;
        if (action) {
            void execute(action);
        }
    }, confirmation);
    button('cancel', text.cancel, () => {
        confirmAction = null; confirmation.hidden = true; update(); confirmOrigin?.focus();
    }, confirmation);
    const rendererLabel = element(document, 'label', text.renderer);
    const renderer = element(document, 'select'); renderer.dataset.control = 'renderer';
    for (const kind of ['knockout', 'dom'] as const) {
        const option = element(document, 'option', text[kind]); option.value = kind; renderer.appendChild(option);
    }
    renderer.value = lab.initialRenderer; rendererLabel.appendChild(renderer); toolbar.appendChild(rendererLabel);
    listen(renderer, 'change', () => {
        const kind = renderer.value as RendererKind; void execute(() => requireController().switchRenderer(kind));
    });
    const routeLabel = element(document, 'label', text.route);
    const route = element(document, 'select'); route.dataset.control = 'route';
    const locations = new Map<string, { region: number; route: number }>();
    for (const entry of lab.scenario.routes) {
        const key = `${entry.location.region}:${entry.location.route}`;
        locations.set(key, entry.location);
        const option = element(document, 'option', `${entry.location.region} / ${entry.location.route}`);
        option.value = key; option.disabled = !entry.unlocked || entry.location.region !== lab.scenario.initialLocation.region;
        route.appendChild(option);
    }
    routeLabel.appendChild(route); toolbar.appendChild(routeLabel);
    listen(route, 'change', () => {
        const location = locations.get(route.value);
        if (location) {
            void execute(() => requireController().changeRoute(location));
        }
    });

    function update() {
        if (disposed) {
            return;
        }
        const busy = !controller || controller.busy;
        const state = controller?.state ?? 'empty';
        const running = state === 'running';
        const usable = state === 'running' || state === 'stopped';
        status.textContent = busy ? text.busy : running ? text.running : state === 'empty' ? text.ready : text.stopped;
        for (const [name, control] of controls) {
            if (name === 'confirm' || name === 'cancel') {
                control.disabled = busy; continue;
            }
            control.disabled = busy || !!confirmAction || (['load', 'recover'].includes(name) ? false : !usable)
                || (['attack', 'pause'].includes(name) && !running) || (name === 'start' && running);
        }
        renderer.disabled = busy || !!confirmAction || !usable;
        route.disabled = busy || !!confirmAction || !running;
        if (controller) {
            renderer.value = controller.rendererKind;
            const location = controller.latest?.location;
            if (location) {
                route.value = `${location.region}:${location.route}`;
            }
            if (controller.lastError) {
                notice.textContent = `${text.failed}: ${controller.lastError.message}`;
            }
        }
    }

    try {
        const store = ports.store ?? createBrowserCheckpointStore({ slot: lab.saveSlot, maxBytes: lab.maxCheckpointBytes, configuration, scenario: lab.scenario });
        controller = new CombatLabController({ store, frames: ports.frames ?? browserFrameScheduler,
            initialRenderer: lab.initialRenderer, maxPendingOutputs: configuration.simulation.maxPendingOutputs,
            newSessionId: ports.newSessionId ?? (() => crypto.randomUUID()), changed: update,
            createHost: ports.createHost ?? ((sessionId, checkpoint, onOutputAvailable, onFault) => createBrowserCombatHost(new URL('ecs/combat.worker.js', base), {
                sessionId, session: { configuration, scenario: lab.scenario, seed: lab.seed, ...(checkpoint ? { checkpoint } : {}) },
                requestTimeoutMs: lab.requestTimeoutMs, onOutputAvailable, onFault,
            })),
            createRenderer: (kind, sessionId) => new CombatSessionRenderer(view, sessionId, kind, lab.combatLabels, lab.progressLabels, {
                maxCaptured: new Set(lab.scenario.routes.flatMap(route => route.opponents.map(opponent => opponent.pokemonId))).size, maxRoutes: lab.scenario.routes.length,
            }),
        });
        controller.setVisible(!document.hidden);
        const ready = controller.initialize();
        void ready.catch(report);
        listen(document, 'visibilitychange', () => {
            controller?.setVisible(!document.hidden);
            if (document.hidden) {
                notice.textContent = text.hidden;
            }
        });
        const window = document.defaultView;
        if (window) {
            listen(window, 'pagehide', event => {
                if ((event as PageTransitionEvent).persisted) {
                    controller?.setVisible(false);
                } else {
                    dispose();
                }
            });
            listen(window, 'pageshow', () => controller?.setVisible(!document.hidden));
        }
        return { controller, ready, dispose };
    } catch (error) {
        dispose(); throw error;
    }

    function dispose() {
        if (disposed) {
            return;
        }
        disposed = true; controller?.dispose(); cleanups.forEach(cleanup => cleanup()); root.remove();
    }
}
