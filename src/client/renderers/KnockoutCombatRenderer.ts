import * as ko from 'knockout';
import type { CombatSnapshot } from '../../contracts/combat-protocol';
import type { CombatRenderer } from '../combat/PresentationLoop';
import { CombatViewModel, CombatView, CombatTextField } from '../combat/CombatViewModel';
import { element, requireContainer } from './elements';

/** An isolated Knockout presentation model, never the legacy App/game model. */
export class KnockoutCombatRenderer implements CombatRenderer {
    private readonly model: CombatViewModel;
    private readonly view: ko.Observable<CombatView>;
    private readonly root: HTMLElement;
    private readonly subscriptions: Array<{ dispose(): void }> = [];
    private disposed = false;

    constructor(container: HTMLElement, sessionId: string, suppliedLabels: unknown) {
        const document = requireContainer(container);
        this.model = new CombatViewModel(sessionId, suppliedLabels);
        this.view = ko.observable(this.model.current);
        this.root = element(document, 'section');
        this.root.className = 'card ecs-combat-panel';
        try {
            const header = element(document, 'div');
            header.className = 'card-header';
            this.root.appendChild(header);
            header.appendChild(element(document, 'h2', this.model.labels.title));
            this.textField(document, header, 'status');
            const body = element(document, 'div');
            body.className = 'card-body';
            this.root.appendChild(body);
            for (const field of ['region', 'route', 'opponent', 'health'] as const) {
                this.textField(document, body, field);
            }
            const health = element(document, 'progress');
            health.max = 1;
            health.setAttribute('aria-label', this.model.labels.health);
            const ratio = ko.pureComputed(() => this.view().healthRatio);
            this.subscriptions.push(ratio);
            body.appendChild(health);
            ko.applyBindingsToNode(health, { attr: { value: ratio } }, this.view);
            this.textField(document, body, 'capture');
            container.appendChild(this.root);
        } catch (error) {
            try {
                this.dispose();
            } catch { /* Preserve the construction failure after attempting cleanup. */ }
            throw error;
        }
    }

    private textField(document: Document, parent: HTMLElement, field: CombatTextField): void {
        const row = element(document, 'p');
        const label = element(document, 'span', this.model.labels[field]);
        const value = element(document, 'span');
        value.dataset.combatField = field;
        if (field === 'status') {
            value.setAttribute('role', 'status');
        }
        const text = ko.pureComputed(() => this.view().text[field]);
        this.subscriptions.push(text);
        row.append(label, document.createTextNode(': '), value);
        parent.appendChild(row);
        ko.applyBindingsToNode(value, { text }, this.view);
    }

    render(snapshot: CombatSnapshot): void {
        if (this.disposed) {
            throw new Error('Knockout combat renderer is disposed');
        }
        const next = this.model.update(snapshot);
        if (next) {
            this.view(next);
        }
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        try {
            ko.cleanNode(this.root);
        } finally {
            for (const subscription of this.subscriptions) {
                subscription.dispose();
            }
            this.subscriptions.length = 0;
            this.root.remove();
        }
    }
}
