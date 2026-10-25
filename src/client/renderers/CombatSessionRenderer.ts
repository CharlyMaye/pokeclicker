import type { CombatFrame, ProgressLimits } from '../../contracts/combat-progress';
import type { CombatRenderer } from '../combat/PresentationLoop';
import { ProgressViewModel } from '../combat/ProgressViewModel';
import type { CombatLabels } from '../combat/CombatViewModel';
import { DomCombatRenderer } from './DomCombatRenderer';
import { KnockoutCombatRenderer } from './KnockoutCombatRenderer';
import { DomProgressRenderer } from './DomProgressRenderer';
import { KnockoutProgressRenderer } from './KnockoutProgressRenderer';
import { element, requireContainer } from './elements';

/** Both adapters receive one validated frame; replacing this object does not own combat lifetime. */
export class CombatSessionRenderer implements CombatRenderer<CombatFrame> {
    private readonly root: HTMLElement;
    private readonly model: ProgressViewModel;
    private combat: CombatRenderer | null = null;
    private progress: DomProgressRenderer | KnockoutProgressRenderer | null = null;
    private disposed = false;
    constructor(container: HTMLElement, sessionId: string, kind: 'dom' | 'knockout', combatLabels: CombatLabels, progressLabels: unknown, limits: ProgressLimits) {
        if (!['dom', 'knockout'].includes(kind)) {
            throw new Error('Unknown combat presentation');
        }
        this.model = new ProgressViewModel(sessionId, progressLabels, limits);
        this.root = element(requireContainer(container), 'section'); this.root.className = 'ecs-session';
        try {
            this.combat = kind === 'dom' ? new DomCombatRenderer(this.root, sessionId, combatLabels) : new KnockoutCombatRenderer(this.root, sessionId, combatLabels);
            this.progress = kind === 'dom' ? new DomProgressRenderer(this.root, this.model.labels) : new KnockoutProgressRenderer(this.root, this.model.labels, this.model.current);
            this.progress.render(this.model.current);
            container.appendChild(this.root);
        } catch (error) {
            this.dispose(); throw error;
        }
    }
    render(value: CombatFrame): void {
        if (this.disposed) {
            throw new Error('Combat session renderer is disposed');
        }
        const update = this.model.update(value);
        if (update) {
            this.combat?.render(update.frame.snapshot);
            this.progress?.render(update.view);
        }
    }
    dispose(): void {
        if (!this.disposed) {
            this.disposed = true;
            try {
                this.combat?.dispose();
            } finally {
                try {
                    this.progress?.dispose();
                } finally {
                    this.root.remove();
                }
            }
        }
    }
}
