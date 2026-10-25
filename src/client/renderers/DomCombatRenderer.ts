import type { CombatSnapshot } from '../../contracts/combat-protocol';
import type { CombatRenderer } from '../combat/PresentationLoop';
import { CombatViewModel, CombatTextField, COMBAT_TEXT_FIELDS } from '../combat/CombatViewModel';
import { element, requireContainer } from './elements';

/** A diagnostic definition list with no framework dependency. */
export class DomCombatRenderer implements CombatRenderer {
    private readonly model: CombatViewModel;
    private readonly root: HTMLElement;
    private readonly fields = new Map<CombatTextField, HTMLElement>();
    private disposed = false;

    constructor(container: HTMLElement, sessionId: string, suppliedLabels: unknown) {
        const document = requireContainer(container);
        this.model = new CombatViewModel(sessionId, suppliedLabels);
        this.root = element(document, 'section');
        this.root.className = 'ecs-combat-diagnostics';
        this.root.appendChild(element(document, 'h2', this.model.labels.title));
        const list = element(document, 'dl');
        for (const field of COMBAT_TEXT_FIELDS) {
            list.appendChild(element(document, 'dt', this.model.labels[field]));
            const value = element(document, 'dd', this.model.current.text[field]);
            value.dataset.combatField = field;
            if (field === 'status') {
                value.setAttribute('role', 'status');
            }
            list.appendChild(value);
            this.fields.set(field, value);
        }
        this.root.appendChild(list);
        container.appendChild(this.root);
    }

    render(snapshot: CombatSnapshot): void {
        if (this.disposed) {
            throw new Error('DOM combat renderer is disposed');
        }
        const view = this.model.update(snapshot);
        if (view) {
            for (const [field, node] of this.fields) {
                if (node.textContent !== view.text[field]) {
                    node.textContent = view.text[field];
                }
            }
        }
    }

    dispose(): void {
        if (!this.disposed) {
            this.disposed = true;
            this.root.remove();
            this.fields.clear();
        }
    }
}
