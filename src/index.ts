import {FolderError} from './source.js';
import {createFolderSession} from './session.js';
import type {FolderHost, FolderVM, PickerWindow} from './session.js';

export type {FolderHost, FolderVM, OpenResult} from './session.js';
export type {ReloadTarget} from './block-reload.js';

const messages = {
    en: {
        open: 'Open Project Folder…', save: 'Save to Project Folder',
        replace: 'Replace the open project and discard its unsaved changes?',
        opened: 'Project folder opened.', saved: 'Project folder saved.', unchanged: 'No changes to save.',
        conflict: 'The project folder changed outside the editor or is no longer open. Your edits are still in the editor.',
        unsupported: 'This project or edit is outside the folder prototype scope.',
        failed: 'Could not access the project folder.',
        external: 'External changes detected.', reload: 'Reload from Disk', reloaded: 'Changes loaded from disk.',
        dirty: 'Save or set aside your unsaved edits before reloading.',
        running: 'Stop the project before reloading.', busy: 'Please wait for the current operation.',
        blocked: 'These changes cannot be applied as a partial reload.'
    },
    ja: {
        open: 'プロジェクトフォルダを開く…', save: 'プロジェクトフォルダに保存',
        replace: '未保存の変更を破棄して、別の作品を開きますか？',
        opened: 'プロジェクトフォルダを開きました。', saved: 'プロジェクトフォルダに保存しました。', unchanged: '保存する変更はありません。',
        conflict: '外部でフォルダが変更されたか、作品が切り替わりました。編集中の変更はエディターに残っています。',
        unsupported: 'この作品または編集はフォルダ編集の試作対象外です。',
        failed: 'プロジェクトフォルダにアクセスできませんでした。',
        external: '外部変更あり', reload: 'ディスクから再読み込み', reloaded: 'ディスクの変更を読み込みました。',
        dirty: '未保存の編集があります。', running: '作品を停止してから再読み込みできます。',
        busy: '処理が終わるまでお待ちください。', blocked: 'この変更は部分的に反映できません。'
    }
};

type MenuElement = (component: any, props: any, ...children: any[]) => any;
interface MenuProps {
    vm: FolderVM;
    locale?: string;
    MenuItem: any;
    MenuSection: any;
    onRequestClose(): void;
}
type MenuEntry = {session: ReturnType<typeof createFolderSession>; open(locale: string): void; save(locale: string): void};
const menus = new WeakMap<FolderVM, MenuEntry>();

export function mountProjectFolder({vm, document, host, locale = 'en'}: {vm: FolderVM; document: Document; host: FolderHost; locale?: string}) {
    const view = document.defaultView as PickerWindow;
    const pickDirectory = view?.showDirectoryPicker;
    if (!pickDirectory || !vm.runtime?.storage) return null;
    const session = createFolderSession(vm, host);
    const status = document.createElement('output');
    status.dataset.projectFolderStatus = '';
    status.setAttribute('role', 'status');
    status.hidden = true;
    Object.assign(status.style, {
        position: 'fixed', insetInlineEnd: '1rem', bottom: '1rem', zIndex: '1000', padding: '0.6rem 0.85rem',
        maxWidth: 'min(28rem, calc(100vw - 2rem))', background: 'Canvas', color: 'CanvasText',
        border: '1px solid currentColor', borderRadius: '0.4rem'
    });
    document.body.append(status);
    let timer: number;
    const report = (text: string) => {
        if (!status.isConnected) return;
        status.hidden = false;
        status.textContent = text;
        view.clearTimeout(timer);
        timer = view.setTimeout(() => {status.hidden = true;}, 7500);
    };
    const messageFor = (locale: string) => locale.startsWith('ja') ? messages.ja : messages.en;
    const fail = (locale: string, error: unknown) => {
        const message = messageFor(locale);
        const detail = error instanceof FolderError && error.message !== error.code ? ` (${error.message})` : '';
        report((error instanceof FolderError ? message[error.code] : message.failed) + detail);
    };
    let stopWatching: (() => void) | undefined;
    let renderReload = () => {};
    if (host.blockReload) {
        const message = messageFor(locale);
        const notice = document.createElement('aside');
        notice.dataset.projectFolderExternal = '';
        notice.hidden = true;
        Object.assign(notice.style, {
            position: 'fixed', insetInlineEnd: '1rem', bottom: '4.5rem', zIndex: '1000', padding: '0.65rem 0.85rem',
            maxWidth: 'min(27rem, calc(100vw - 2rem))', background: 'Canvas', color: 'CanvasText',
            border: '1px solid currentColor', borderRadius: '0.4rem'
        });
        const text = document.createElement('div');
        text.setAttribute('role', 'status');
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = message.reload;
        notice.append(text, button);
        document.body.append(notice);
        renderReload = () => {
            const state = session.reloadState;
            notice.hidden = !state;
            button.disabled = state !== 'ready';
            const label = !state || state === 'ready' ? message.external : `${message.external} ${message[state]}`;
            if (text.textContent !== label) text.textContent = label;
        };
        const refresh = () => {
            if (document.visibilityState === 'visible') void session.refresh().then(renderReload, error => fail(locale, error));
        };
        button.addEventListener('click', () => {
            const reload = session.reload();
            renderReload();
            void reload.then(applied => {if (applied) report(message.reloaded);}, error => fail(locale, error)).finally(renderReload);
        });
        const unsubscribe = host.blockReload.subscribe(renderReload);
        const interval = view.setInterval(refresh, 2000);
        view.addEventListener('focus', refresh);
        document.addEventListener('visibilitychange', refresh);
        stopWatching = () => {
            unsubscribe();
            view.clearInterval(interval);
            view.removeEventListener('focus', refresh);
            document.removeEventListener('visibilitychange', refresh);
            notice.remove();
        };
    }
    menus.set(vm, {
        session,
        open(locale) {
            const message = messageFor(locale);
            session.open(options => pickDirectory.call(view, options), () => view.confirm(message.replace))
                .then(result => {if (result === 'opened') report(message.opened);}, error => fail(locale, error)).finally(renderReload);
            renderReload();
        },
        save(locale) {
            if (!session.busy) {
                void session.save().then(result => report(messageFor(locale)[result]), error => fail(locale, error)).finally(renderReload);
                renderReload();
            }
        }
    });
    return {
        openDirectory: (...args: Parameters<typeof session.openDirectory>) =>
            session.openDirectory(...args).finally(renderReload),
        dispose() {
            menus.delete(vm);
            session.dispose();
            stopWatching?.();
            view.clearTimeout(timer);
            status.remove();
        }
    };
}

export function renderProjectFolderMenu(createElement: MenuElement, {
    vm, locale = 'en', MenuItem, MenuSection, onRequestClose
}: MenuProps) {
    const entry = menus.get(vm);
    if (!entry) return null;
    const labels = locale.startsWith('ja') ? messages.ja : messages.en;
    const item = (action: 'open' | 'save') => {
        const run = () => {onRequestClose(); entry[action](locale);};
        return createElement(MenuItem, {command: `project-folder-${action}`, onClick: run},
            createElement('span', {role: 'button', tabIndex: 0, onKeyDown(event: KeyboardEvent) {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                event.stopPropagation();
                run();
            }}, labels[action]));
    };
    return createElement(MenuSection, null, item('open'), entry.session.canSave ? item('save') : null);
}
