import * as ko from 'knockout';
import type { ProgressView, ProgressLabels } from '../combat/ProgressViewModel';
import { createProgressMarkup } from './progressMarkup';
import { element, requireContainer } from './elements';

export class KnockoutProgressRenderer {
    private readonly markup;
    private readonly view: ko.Observable<ProgressView>;
    private readonly subscriptions: Array<{ dispose(): void }> = [];
    private disposed = false;
    constructor(container: HTMLElement, labels: ProgressLabels, initial: ProgressView) {
        this.view = ko.observable(initial);
        this.markup = createProgressMarkup(requireContainer(container), labels);
        try {
            for (const [key, field] of this.markup.fields) {
                this.bind(field, 'text', () => this.view().totals[key]);
            }
            for (const name of ['captured', 'routes'] as const) {
                const row = element(container.ownerDocument, 'tr');
                const columns = name === 'captured' ? ['pokemonId', 'count'] : ['region', 'route', 'defeats', 'captures'];
                for (const column of columns) {
                    const cell = element(container.ownerDocument, 'td');
                    // Fixed binding identifiers come from this adapter, never from JSON labels or game data.
                    cell.setAttribute('data-bind', `text: ${column}`); row.appendChild(cell);
                }
                this.markup[name].body.appendChild(row);
                this.bind(this.markup[name].body, 'foreach', () => this.view()[name]);
                this.bind(this.markup[name].notice, 'text', () => name === 'captured' ? this.view().capturedNotice : this.view().routesNotice);
            }
            container.appendChild(this.markup.root);
        } catch (error) {
            this.dispose(); throw error;
        }
    }
    private bind<T>(node: HTMLElement, name: string, read: () => T): void {
        const value = ko.pureComputed(read);
        // Equal committed totals avoid rebuilding unchanged tables on every simulation step.
        value.equalityComparer = (previous, next) => JSON.stringify(previous) === JSON.stringify(next);
        this.subscriptions.push(value);
        ko.applyBindingsToNode(node, { [name]: value }, {});
    }
    render(view: ProgressView): void {
        if (this.disposed) {
            throw new Error('Progress renderer is disposed');
        }
        this.view(view);
    }
    dispose(): void {
        if (!this.disposed) {
            this.disposed = true;
            ko.cleanNode(this.markup.root); this.markup.root.remove();
            this.subscriptions.forEach(subscription => subscription.dispose());
        }
    }
}
