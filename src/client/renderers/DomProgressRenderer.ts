import type { ProgressView, ProgressLabels } from '../combat/ProgressViewModel';
import { createProgressMarkup } from './progressMarkup';
import { element, requireContainer } from './elements';

export class DomProgressRenderer {
    private readonly markup;
    private previous: ProgressView | null = null;
    private disposed = false;
    constructor(container: HTMLElement, labels: ProgressLabels) {
        this.markup = createProgressMarkup(requireContainer(container), labels);
        container.appendChild(this.markup.root);
    }
    render(view: ProgressView): void {
        if (this.disposed) {
            throw new Error('Progress renderer is disposed');
        }
        for (const [key, field] of this.markup.fields) {
            if (field.textContent !== view.totals[key]) {
                field.textContent = view.totals[key];
            }
        }
        this.rows(this.markup.captured.body, this.previous?.captured, view.captured, ['pokemonId', 'count']);
        this.rows(this.markup.routes.body, this.previous?.routes, view.routes, ['region', 'route', 'defeats', 'captures']);
        this.rows(this.markup.party.body, this.previous?.party, view.party, ['pokemonId', 'level', 'experience']);
        for (const [key, field] of this.markup.partyFields) {
            if (field.textContent !== view.partyTotals[key]) {
                field.textContent = view.partyTotals[key];
            }
        }
        for (const name of ['captured', 'routes', 'party'] as const) {
            const notice = name === 'captured' ? view.capturedNotice : name === 'routes' ? view.routesNotice : view.partyNotice;
            if (this.markup[name].notice.textContent !== notice) {
                this.markup[name].notice.textContent = notice;
            }
        }
        this.previous = view;
    }
    private rows<T extends Record<string, string>>(body: HTMLTableSectionElement, previous: readonly T[] | undefined, current: readonly T[], columns: readonly (keyof T)[]): void {
        if (JSON.stringify(previous) === JSON.stringify(current)) {
            return;
        }
        const rows = current.map(entry => {
            const row = element(body.ownerDocument, 'tr');
            for (const column of columns) {
                row.appendChild(element(body.ownerDocument, 'td', entry[column]));
            }
            return row;
        });
        body.replaceChildren(...rows);
    }
    dispose(): void {
        this.disposed = true; this.markup.root.remove(); this.previous = null;
    }
}
