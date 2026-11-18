import type {BrowserProject, BrowserProjects} from './browser-projects.js';
import {zipDirectory} from './zip.js';

const messages = {
    en: {
        openTitle: 'Project Folders in This Browser', createTitle: 'New Project Folder in This Browser',
        note: 'These folders are stored only in this browser. The browser may delete them when you clear site data or ' +
            'do not use this site for a while. Export a ZIP or push to GitHub to keep a copy.',
        usage: (used: string, quota: string) => `Using ${used} of ${quota}.`,
        persisted: 'The browser keeps this storage until you clear it.',
        empty: 'No project folders are stored in this browser yet.',
        name: 'Name', create: 'Create', open: 'Open', exportZip: 'Export ZIP', remove: 'Delete…', close: 'Close',
        updated: (date: string) => `Updated ${date}`,
        confirmRemove: (title: string) => `Delete “${title}” from this browser? This cannot be undone. Export a ZIP first to keep a copy.`,
        failed: 'The browser storage could not be used.'
    },
    ja: {
        openTitle: 'ブラウザー内の作品フォルダ', createTitle: '新しい作品フォルダをブラウザー内に作る',
        note: 'この作品フォルダは、このブラウザーの中にだけ保存されます。サイトのデータを消したときや、しばらくこのサイトを' +
            '使わなかったときに、ブラウザーが消すことがあります。ZIP で書き出すか、GitHub に送って残してください。',
        usage: (used: string, quota: string) => `${quota} のうち ${used} を使っています。`,
        persisted: 'このブラウザーは、データを消すまでこの保存領域を残します。',
        empty: 'このブラウザーには、まだ作品フォルダがありません。',
        name: '名前', create: '作成', open: '開く', exportZip: 'ZIP で書き出す', remove: '削除…', close: '閉じる',
        updated: (date: string) => `更新: ${date}`,
        confirmRemove: (title: string) => `「${title}」をこのブラウザーから削除しますか？元に戻せません。残すには、先に ZIP で書き出してください。`,
        failed: 'ブラウザーの保存領域を使えませんでした。'
    }
};

const closeIcon = 'M4 4l8 8M12 4l-8 8';

function formatBytes(value: number, locale: string) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = value;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
        size /= 1024;
        unit++;
    }
    return `${new Intl.NumberFormat(locale, {maximumFractionDigits: unit ? 1 : 0}).format(size)} ${units[unit]}`;
}

/** A file name for the exported ZIP that every OS accepts. */
export function zipFileName(title: string) {
    const name = title.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/gu, '_').replace(/^[.\s]+|[.\s]+$/gu, '').slice(0, 120);
    return `${name || 'project'}.zip`;
}

/** Saves the stored folder of `project` as a ZIP through the browser's download. */
export async function exportBrowserProject(document: Document, projects: BrowserProjects, project: BrowserProject) {
    const root = await projects.root(project.id);
    if (!root) throw new DOMException('The project folder was deleted', 'NotFoundError');
    const blob = await projects.exclusive(project.id, () => zipDirectory(root));
    const view = document.defaultView!;
    const url = view.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = zipFileName(project.title);
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    // Give the download time to start before the URL goes away.
    view.setTimeout(() => view.URL.revokeObjectURL(url), 60_000);
}

export type BrowserProjectChoice = {project: BrowserProject; directory: FileSystemDirectoryHandle};

/**
 * Shows the project folders kept in this browser. With `purpose: 'open'` the user picks one; with `'create'` the user
 * names a new empty one. Resolves with the chosen stored folder, or `null` when the dialog closes without one.
 */
export function chooseBrowserProject({document, projects, locale = 'en', purpose, title = ''}: {
    document: Document; projects: BrowserProjects; locale?: string; purpose: 'open' | 'create'; title?: string;
}): Promise<BrowserProjectChoice | null> {
    const message = locale.startsWith('ja') ? messages.ja : messages.en;
    const view = document.defaultView!;
    const dialog = document.createElement('dialog');
    dialog.dataset.browserProjects = purpose;
    dialog.setAttribute('aria-labelledby', 'tw-plus-browser-projects-title');
    Object.assign(dialog.style, {
        width: 'min(34rem, calc(100vw - 2rem))', maxHeight: 'calc(100vh - 4rem)', padding: '1rem 1.25rem',
        background: 'Canvas', color: 'CanvasText', border: '1px solid GrayText', borderRadius: '0.5rem',
        fontFamily: 'inherit', fontSize: '0.875rem', boxSizing: 'border-box'
    });
    const header = document.createElement('header');
    Object.assign(header.style, {display: 'flex', alignItems: 'center', gap: '0.5rem', marginBlockEnd: '0.5rem'});
    const heading = document.createElement('h2');
    heading.id = 'tw-plus-browser-projects-title';
    heading.textContent = purpose === 'open' ? message.openTitle : message.createTitle;
    Object.assign(heading.style, {flex: '1', margin: '0', fontSize: '1rem'});
    const close = document.createElement('button');
    close.type = 'button';
    close.dataset.browserProjectsClose = '';
    close.title = message.close;
    close.setAttribute('aria-label', message.close);
    Object.assign(close.style, {display: 'grid', placeItems: 'center', width: '2rem', height: '2rem', padding: '0',
        background: 'transparent', color: 'inherit', border: '0', borderRadius: '0.25rem', cursor: 'pointer'});
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', closeIcon);
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('stroke-linecap', 'round');
    svg.append(path);
    close.append(svg);
    header.append(heading, close);
    const note = document.createElement('p');
    note.textContent = message.note;
    Object.assign(note.style, {margin: '0 0 0.25rem'});
    const usage = document.createElement('p');
    usage.dataset.browserProjectsUsage = '';
    Object.assign(usage.style, {margin: '0 0 0.75rem', color: 'GrayText'});
    const status = document.createElement('p');
    status.setAttribute('role', 'alert');
    status.hidden = true;
    Object.assign(status.style, {margin: '0 0 0.75rem'});
    dialog.append(header, note, usage, status);

    let settled = false;
    let resolveChoice: (choice: BrowserProjectChoice | null) => void;
    const result = new Promise<BrowserProjectChoice | null>(resolve => {resolveChoice = resolve;});
    const finish = (choice: BrowserProjectChoice | null) => {
        if (settled) return;
        settled = true;
        if (dialog.open) dialog.close();
        dialog.remove();
        resolveChoice(choice);
    };
    const fail = (error: unknown) => {
        status.hidden = false;
        status.textContent = message.failed + (error instanceof Error && error.message ? ` (${error.message})` : '');
    };
    let busy = false;
    const run = async (action: () => Promise<void>) => {
        if (busy) return;
        busy = true;
        dialog.setAttribute('aria-busy', 'true');
        try {
            await action();
        } catch (error) {
            fail(error);
        } finally {
            busy = false;
            dialog.removeAttribute('aria-busy');
        }
    };
    close.addEventListener('click', () => finish(null));
    dialog.addEventListener('cancel', event => {
        event.preventDefault();
        finish(null);
    });
    dialog.addEventListener('close', () => finish(null));

    if (purpose === 'create') {
        const form = document.createElement('form');
        Object.assign(form.style, {display: 'flex', gap: '0.5rem', alignItems: 'end'});
        const label = document.createElement('label');
        Object.assign(label.style, {display: 'grid', gap: '0.25rem', flex: '1'});
        const caption = document.createElement('span');
        caption.textContent = message.name;
        const input = document.createElement('input');
        input.name = 'title';
        input.required = true;
        input.maxLength = 200;
        input.value = title;
        input.autocomplete = 'off';
        label.append(caption, input);
        const submit = document.createElement('button');
        submit.type = 'submit';
        submit.textContent = message.create;
        form.append(label, submit);
        form.addEventListener('submit', event => {
            event.preventDefault();
            const name = input.value.trim();
            if (!name) return;
            void run(async () => {
                const created = await projects.create(name);
                finish({project: {id: created.id, title: created.title, projectPath: created.projectPath,
                    createdAt: created.createdAt, updatedAt: created.updatedAt}, directory: created.directory});
            });
        });
        dialog.append(form);
    } else {
        const list = document.createElement('ul');
        list.dataset.browserProjectsList = '';
        Object.assign(list.style, {listStyle: 'none', margin: '0', padding: '0', display: 'grid', gap: '0.5rem',
            overflowY: 'auto', maxHeight: '50vh'});
        const dateFormat = new Intl.DateTimeFormat(locale, {dateStyle: 'medium', timeStyle: 'short'});
        const render = async () => {
            const stored = await projects.list();
            list.replaceChildren();
            if (!stored.length) {
                const empty = document.createElement('li');
                empty.textContent = message.empty;
                empty.style.color = 'GrayText';
                list.append(empty);
            }
            for (const project of stored) {
                const item = document.createElement('li');
                item.dataset.browserProject = project.id;
                Object.assign(item.style, {display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap',
                    padding: '0.5rem', border: '1px solid GrayText', borderRadius: '0.375rem'});
                const text = document.createElement('div');
                Object.assign(text.style, {flex: '1', minWidth: '10rem'});
                const name = document.createElement('strong');
                name.textContent = project.title;
                const updated = document.createElement('div');
                updated.textContent = message.updated(dateFormat.format(project.updatedAt));
                updated.style.color = 'GrayText';
                text.append(name, updated);
                const button = (label: string, action: () => Promise<void>) => {
                    const element = document.createElement('button');
                    element.type = 'button';
                    element.textContent = label;
                    element.addEventListener('click', () => void run(action));
                    return element;
                };
                item.append(text,
                    // The project is at the root of the stored folder, as on the device.
                    button(message.open, async () => {
                        const directory = await projects.root(project.id);
                        if (!directory) return render();
                        finish({project, directory});
                    }),
                    button(message.exportZip, () => exportBrowserProject(document, projects, project)),
                    button(message.remove, async () => {
                        if (!view.confirm(message.confirmRemove(project.title))) return;
                        await projects.remove(project.id);
                        await render();
                        await showUsage();
                    }));
                list.append(item);
            }
        };
        dialog.append(list);
        void run(render);
    }
    const showUsage = async () => {
        const state = await projects.storage().catch(() => null);
        if (!state) return;
        const parts = [];
        if (state.usage !== undefined && state.quota) parts.push(message.usage(formatBytes(state.usage, locale), formatBytes(state.quota, locale)));
        if (state.persisted) parts.push(message.persisted);
        usage.textContent = parts.join(' ');
        usage.hidden = !parts.length;
    };
    void showUsage();
    document.body.append(dialog);
    dialog.showModal();
    (dialog.querySelector('input') ?? dialog.querySelector('[data-browser-projects-list] button') ?? close as HTMLElement)?.focus();
    return result;
}
