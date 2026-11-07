import {FolderError} from './source.js';
import {createFolderSession} from './session.js';
import type {FolderHost, FolderVM, PickerWindow} from './session.js';

export type {FolderHost, FolderVM, OpenResult} from './session.js';

const messages = {
    en: {
        open: 'Open Project Folder…', save: 'Save to Project Folder',
        replace: 'Replace the open project and discard its unsaved changes?',
        opened: 'Project folder opened.', saved: 'Project folder saved.', unchanged: 'No changes to save.',
        conflict: 'The project folder changed outside the editor or is no longer open. Your edits are still in the editor.',
        unsupported: 'This project or edit is outside the folder prototype scope.',
        failed: 'Could not access the project folder.'
    },
    ja: {
        open: 'プロジェクトフォルダを開く…', save: 'プロジェクトフォルダに保存',
        replace: '未保存の変更を破棄して、別の作品を開きますか？',
        opened: 'プロジェクトフォルダを開きました。', saved: 'プロジェクトフォルダに保存しました。', unchanged: '保存する変更はありません。',
        conflict: '外部でフォルダが変更されたか、作品が切り替わりました。編集中の変更はエディターに残っています。',
        unsupported: 'この作品または編集はフォルダ編集の試作対象外です。',
        failed: 'プロジェクトフォルダにアクセスできませんでした。'
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

export function mountProjectFolder({vm, document, host}: {vm: FolderVM; document: Document; host: FolderHost}) {
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
    menus.set(vm, {
        session,
        open(locale) {
            const message = messageFor(locale);
            session.open(options => pickDirectory.call(view, options), () => view.confirm(message.replace))
                .then(result => {if (result === 'opened') report(message.opened);}, error => fail(locale, error));
        },
        save(locale) {
            if (!session.busy) session.save().then(result => report(messageFor(locale)[result]), error => fail(locale, error));
        }
    });
    return {
        openDirectory: session.openDirectory,
        dispose() {
            menus.delete(vm);
            session.dispose();
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
