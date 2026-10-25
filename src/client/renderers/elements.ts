export function requireContainer(container: HTMLElement): Document {
    if (!container || container.nodeType !== 1 || !container.ownerDocument || typeof container.appendChild !== 'function') {
        throw new Error('A host element is required for the combat renderer');
    }
    return container.ownerDocument;
}

/** Content is always plain text; labels and snapshots never become HTML or binding expressions. */
export function element<K extends keyof HTMLElementTagNameMap>(document: Document, tag: K, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (text !== undefined) {
        node.textContent = text;
    }
    return node;
}
