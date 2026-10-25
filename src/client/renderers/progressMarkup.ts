import { PROGRESS_TOTAL_FIELDS, ProgressTotalField } from '../../contracts/combat-progress';
import type { ProgressLabels } from '../combat/ProgressViewModel';
import { element } from './elements';

/** Static, owned markup shared by the plain DOM and Knockout progress adapters. */
export function createProgressMarkup(document: Document, labels: ProgressLabels) {
    const root = element(document, 'section'); root.className = 'ecs-progress';
    root.appendChild(element(document, 'h2', labels.title));
    const totals = element(document, 'dl'); root.appendChild(totals);
    const fields = new Map<ProgressTotalField, HTMLElement>();
    for (const key of PROGRESS_TOTAL_FIELDS) {
        totals.appendChild(element(document, 'dt', labels[key]));
        const value = element(document, 'dd', labels.waiting); value.dataset.progressField = key;
        totals.appendChild(value); fields.set(key, value);
    }
    function table(name: 'captured' | 'routes', columns: readonly (keyof ProgressLabels)[]) {
        const table = element(document, 'table'); table.dataset.progressTable = name;
        table.appendChild(element(document, 'caption', labels[name]));
        const header = element(document, 'thead'), row = element(document, 'tr');
        for (const column of columns) {
            const cell = element(document, 'th', labels[column]); cell.scope = 'col'; row.appendChild(cell);
        }
        header.appendChild(row); table.appendChild(header);
        const body = element(document, 'tbody'); table.appendChild(body);
        root.appendChild(table);
        const notice = element(document, 'p', labels.waiting); notice.dataset.progressNotice = name; root.appendChild(notice);
        return { table, body, notice };
    }
    return { root, fields, captured: table('captured', ['pokemonId', 'count']), routes: table('routes', ['region', 'route', 'defeats', 'captures']) };
}
export type ProgressMarkup = ReturnType<typeof createProgressMarkup>;
