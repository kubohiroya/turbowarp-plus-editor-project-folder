import {EditorView, ViewPlugin, type ViewUpdate} from '@codemirror/view';
import type {Extension} from '@codemirror/state';

// Sample at most one document line per canvas row, including lines outside CodeMirror's viewport.
export const textMinimap = (label: string): Extension => ViewPlugin.fromClass(class {
    readonly dom: HTMLDivElement;
    readonly canvas: HTMLCanvasElement;
    readonly viewport: HTMLDivElement;
    readonly observer: ResizeObserver;
    private drawnDoc?: EditorView['state']['doc'];
    private drawnColor = '';
    private drawnWidth = 0;
    private drawnHeight = 0;
    private disposed = false;

    constructor(readonly view: EditorView) {
        const document = view.dom.ownerDocument;
        this.dom = document.createElement('div');
        this.dom.className = 'twpf-text-minimap';
        this.dom.tabIndex = 0;
        this.dom.setAttribute('role', 'slider');
        this.dom.setAttribute('aria-label', label);
        this.dom.setAttribute('aria-orientation', 'vertical');
        this.dom.setAttribute('aria-valuemin', '1');
        this.canvas = document.createElement('canvas');
        this.canvas.setAttribute('aria-hidden', 'true');
        this.viewport = document.createElement('div');
        this.viewport.className = 'twpf-text-minimap-viewport';
        this.dom.append(this.canvas, this.viewport);
        view.dom.append(this.dom);
        this.dom.addEventListener('pointerdown', event => {
            if (event.button !== 0) return;
            event.preventDefault();
            this.dom.focus({preventScroll: true});
            this.dom.setPointerCapture(event.pointerId);
            this.seek(event);
        });
        this.dom.addEventListener('pointermove', event => {
            if (this.dom.hasPointerCapture(event.pointerId)) this.seek(event);
        });
        this.dom.addEventListener('pointerup', event => {
            if (this.dom.hasPointerCapture(event.pointerId)) this.dom.releasePointerCapture(event.pointerId);
        });
        this.dom.addEventListener('keydown', event => {
            const scroll = view.scrollDOM;
            const line = view.defaultLineHeight;
            const destinations: Record<string, number> = {
                ArrowUp: scroll.scrollTop - line, ArrowDown: scroll.scrollTop + line,
                PageUp: scroll.scrollTop - scroll.clientHeight, PageDown: scroll.scrollTop + scroll.clientHeight,
                Home: 0, End: scroll.scrollHeight
            };
            if (!(event.key in destinations)) return;
            event.preventDefault();
            event.stopPropagation();
            scroll.scrollTop = destinations[event.key];
        });
        view.scrollDOM.addEventListener('scroll', this.measure, {passive: true});
        const browser = document.defaultView!;
        this.observer = new browser.ResizeObserver(this.measure);
        this.observer.observe(this.dom);
        this.measure();
    }

    private seek(event: PointerEvent) {
        const bounds = this.dom.getBoundingClientRect();
        if (!bounds.height) return;
        const scroll = this.view.scrollDOM;
        scroll.scrollTop = (event.clientY - bounds.top) / bounds.height * scroll.scrollHeight - scroll.clientHeight / 2;
    }

    readonly measure = () => {
        if (this.disposed) return;
        this.view.requestMeasure({
            key: this,
            read: view => ({
                width: this.dom.clientWidth, height: this.dom.clientHeight,
                top: view.scrollDOM.scrollTop, total: view.scrollDOM.scrollHeight, visible: view.scrollDOM.clientHeight,
                color: view.dom.ownerDocument.defaultView!.getComputedStyle(view.contentDOM).color
            }),
            write: ({width, height, top, total, visible, color}, view) => {
                if (this.disposed || !width || !height || !total) return;
                const doc = view.state.doc;
                if (doc !== this.drawnDoc || width !== this.drawnWidth || height !== this.drawnHeight || color !== this.drawnColor) {
                    this.canvas.width = width;
                    this.canvas.height = height;
                    const context = this.canvas.getContext('2d');
                    if (context) {
                        context.fillStyle = color;
                        context.globalAlpha = .65;
                        const rows = Math.min(doc.lines, height);
                        const rowHeight = Math.min(2, height / rows);
                        for (let row = 0; row < rows; row++) {
                            const line = doc.line(1 + Math.floor(row * doc.lines / rows));
                            // Reading a bounded slice also keeps a large, single-line JSON file cheap to draw.
                            const text = doc.sliceString(line.from, Math.min(line.to, line.from + width));
                            for (let column = 0; column < text.length; column++) {
                                if (!/\s/u.test(text[column])) context.fillRect(column, row * rowHeight, 1, rowHeight);
                            }
                        }
                    }
                    this.drawnDoc = doc;
                    this.drawnWidth = width;
                    this.drawnHeight = height;
                    this.drawnColor = color;
                }
                this.viewport.style.top = `${top / total * 100}%`;
                this.viewport.style.height = `${Math.min(1, visible / total) * 100}%`;
                this.dom.setAttribute('aria-valuemax', String(doc.lines));
                this.dom.setAttribute('aria-valuenow', String(Math.min(doc.lines, 1 + Math.floor(top / total * doc.lines))));
            }
        });
    };

    update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged || update.geometryChanged) this.measure();
    }

    destroy() {
        this.disposed = true;
        this.observer.disconnect();
        this.view.scrollDOM.removeEventListener('scroll', this.measure);
        this.dom.remove();
    }
});
