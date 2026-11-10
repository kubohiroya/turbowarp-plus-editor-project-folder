import {FolderError} from './source.js';
import {createFolderSession} from './session.js';
import {registerFolder} from './folder-registry.js';
import type {FolderHost, FolderVM, PickerWindow} from './session.js';

export type {Comparison, ComparisonRequest, ComparisonSection, FolderHost, FolderVM, OpenResult} from './session.js';
export type {ReloadTarget} from './block-reload.js';
export {followProjectFolder} from './folder-registry.js';
export type {FollowedFolder} from './folder-registry.js';
export type {DeserializeBlocks} from './script-reload.js';

const messages = {
    en: {
        open: 'Open Project Folder…', save: 'Save to Project Folder',
        replace: 'Replace the open project and discard its unsaved changes?',
        opened: 'Project folder opened.', saved: 'Project folder saved.', unchanged: 'No changes to save.',
        sourceRemoved: (ids: string[]) => `Removed source metadata for replaced extensions: ${ids.join(', ')}. Use sb3-toolchain to fetch the managed sources again if you need to keep their provenance.`,
        conflict: 'The project folder changed outside the editor or is no longer open. Your edits are still in the editor.',
        unsupported: 'This project or edit cannot be saved to a project folder yet.',
        failed: 'Could not access the project folder.',
        external: 'External changes detected.', reload: 'Reload from Disk', reloaded: 'Changes loaded from disk.',
        reloadAll: 'Reload Whole Project', discard: 'Discard Edits and Reload…',
        discardConfirm: 'Discard your unsaved edits and load the project from the folder?',
        compare: 'Compare and Choose…', compareTitle: 'External changes and your unsaved edits',
        compareDescription: 'The project folder changed while the Editor has unsaved edits. Loading from the folder discards your edits.',
        compareUnsaved: 'Some of your edits are outside what the project folder can save, so they are not shown here.',
        yourEdits: 'Your unsaved edits', diskChanges: 'Changes in the folder',
        keep: 'Keep My Edits', discardLoad: 'Discard Edits and Load from Folder', close: 'Close',
        dirty: 'You have unsaved edits.', running: 'Stop the project before reloading.',
        runningAuto: 'The changes load when the project stops.', busy: 'Please wait for the current operation.',
        waiting: 'Waiting for the external write to finish.',
        full: 'These changes need the whole project to be reloaded.'
    },
    ja: {
        open: 'プロジェクトフォルダを開く…', save: 'プロジェクトフォルダに保存',
        replace: '未保存の変更を破棄して、別の作品を開きますか？',
        opened: 'プロジェクトフォルダを開きました。', saved: 'プロジェクトフォルダに保存しました。', unchanged: '保存する変更はありません。',
        sourceRemoved: (ids: string[]) => `差し替えた拡張機能（${ids.join('、')}）の出どころ情報を削除しました。出どころを保つには、sb3-toolchain で拡張機能を取得し直してください。`,
        conflict: '外部でフォルダが変更されたか、作品が切り替わりました。編集中の変更はエディターに残っています。',
        unsupported: 'この作品または編集は、まだプロジェクトフォルダに保存できません。',
        failed: 'プロジェクトフォルダにアクセスできませんでした。',
        external: '外部変更あり', reload: 'ディスクから再読み込み', reloaded: 'ディスクの変更を読み込みました。',
        reloadAll: '作品全体を再読み込み', discard: '編集を破棄して再読み込み…',
        discardConfirm: '未保存の編集を破棄して、フォルダの作品を読み込みますか？',
        compare: '比較して選ぶ…', compareTitle: '外部の変更と未保存の編集',
        compareDescription: 'Editor に未保存の編集がある間に、プロジェクトフォルダが変更されました。フォルダから読み込むと、未保存の編集は失われます。',
        compareUnsaved: '未保存の編集の一部はプロジェクトフォルダに保存できない種類のため、ここには表示していません。',
        yourEdits: 'あなたの未保存の編集', diskChanges: 'フォルダでの変更',
        keep: '編集を残す', discardLoad: '編集を破棄してフォルダから読み込む', close: '閉じる',
        dirty: '未保存の編集があります。', running: '作品を停止してから再読み込みできます。',
        runningAuto: '作品の停止後に反映します。', busy: '処理が終わるまでお待ちください。',
        waiting: '外部の書き込みが終わるのを待っています。',
        full: 'この変更は作品全体の再読み込みが必要です。'
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

type ObserverWindow = PickerWindow & {FileSystemObserver?: new (callback: () => void) => {
    observe(handle: FileSystemDirectoryHandle, options: {recursive: boolean}): Promise<void>;
    disconnect(): void;
}};

/**
 * `autoReload` (default true) applies value and position changes without a click when the Editor has no unsaved
 * edits and the project is stopped. Other changes always wait for the reload command.
 */
export function mountProjectFolder({vm, document, host, locale = 'en', autoReload = true}: {
    vm: FolderVM; document: Document; host: FolderHost; locale?: string; autoReload?: boolean;
}) {
    const view = document.defaultView as ObserverWindow;
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
        const compareChanges = host.blockReload.compareChanges?.bind(host.blockReload);
        let comparing = false;
        // Lets the user see their unsaved edits next to the folder's changes before choosing to replace them.
        const compare = async (show: NonNullable<typeof compareChanges>) => {
            if (comparing) return;
            comparing = true;
            try {
                const texts = await session.comparison();
                if (!texts) return;
                const sections = [{title: message.diskChanges, before: texts.base, after: texts.disk}];
                if (texts.editor !== null) sections.unshift({title: message.yourEdits, before: texts.base, after: texts.editor});
                const choice = await show({
                    title: message.compareTitle, description: message.compareDescription,
                    notes: texts.editor === null ? [message.compareUnsaved] : [], sections,
                    actions: [{id: 'keep', label: message.keep}, {id: 'discard', label: message.discardLoad}],
                    closeLabel: message.close
                });
                if (choice === 'discard' && session.reloadState === 'dirty') apply(() => session.reloadAll(() => true));
            } catch (error) {
                fail(locale, error);
            } finally {
                comparing = false;
                renderReload();
            }
        };
        let settle: number | undefined;
        let autoTried: string | null = null;
        let observed: FileSystemDirectoryHandle | null = null;
        let observer: InstanceType<NonNullable<ObserverWindow['FileSystemObserver']>> | null = null;
        const apply = (run: () => Promise<boolean | string>) => {
            const done = run();
            renderReload();
            void done.then(result => {if (result === true || result === 'opened') report(message.reloaded);}, error => fail(locale, error))
                .finally(renderReload);
        };
        renderReload = () => {
            const state = session.reloadState;
            const kind = session.reloadKind;
            if (autoReload && session.canAutoReload && session.pendingVersion !== autoTried) {
                autoTried = session.pendingVersion;
                apply(() => session.reload());
                return;
            }
            notice.hidden = !state;
            button.hidden = !kind;
            button.disabled = !['ready', 'full', 'dirty'].includes(state ?? '');
            const action = state === 'dirty' ? (compareChanges ? message.compare : message.discard) :
                kind === 'full' ? message.reloadAll : message.reload;
            if (button.textContent !== action) button.textContent = action;
            const detail = !state || state === 'ready' ? '' :
                state === 'running' && kind === 'partial' && autoReload ? message.runningAuto : message[state];
            const label = detail ? `${message.external} ${detail}` : message.external;
            if (text.textContent !== label) text.textContent = label;
            const directory = session.directory;
            if (observer && observed !== directory) {
                observer.disconnect();
                observed = directory;
                if (directory) observer.observe(directory, {recursive: true}).catch(() => {});
            }
        };
        const refresh = () => {
            if (document.visibilityState !== 'visible') return;
            void session.refresh().then(() => {
                renderReload();
                // Look again soon after a new or incomplete change instead of waiting for the next interval.
                if (session.settling) schedule(500);
            }, error => fail(locale, error));
        };
        const schedule = (delay: number) => {
            view.clearTimeout(settle);
            settle = view.setTimeout(refresh, delay);
        };
        if (view.FileSystemObserver) {
            try {
                observer = new view.FileSystemObserver(() => schedule(300));
            } catch {
                observer = null;
            }
        }
        button.addEventListener('click', () => {
            const state = session.reloadState;
            if (state === 'ready') apply(() => session.reload());
            else if (state === 'full') apply(() => session.reloadAll(() => true));
            else if (state === 'dirty' && compareChanges) void compare(compareChanges);
            else if (state === 'dirty') apply(() => session.reloadAll(() => view.confirm(message.discardConfirm)));
        });
        const unsubscribe = host.blockReload.subscribe(renderReload);
        const interval = view.setInterval(refresh, 2000);
        view.addEventListener('focus', refresh);
        document.addEventListener('visibilitychange', refresh);
        stopWatching = () => {
            unsubscribe();
            view.clearInterval(interval);
            view.clearTimeout(settle);
            observer?.disconnect();
            view.removeEventListener('focus', refresh);
            document.removeEventListener('visibilitychange', refresh);
            notice.remove();
        };
    }
    const menu: MenuEntry = {
        session,
        open(locale) {
            const message = messageFor(locale);
            session.open(options => pickDirectory.call(view, options), () => view.confirm(message.replace))
                .then(result => {if (result === 'opened') report(message.opened);}, error => fail(locale, error)).finally(renderReload);
            renderReload();
        },
        save(locale) {
            if (!session.busy) {
                const message = messageFor(locale);
                void session.save().then(({status, sourceRemoved}) => {
                    const detail = sourceRemoved.length ? ` ${message.sourceRemoved(sourceRemoved)}` : '';
                    report(message[status] + detail);
                }, error => fail(locale, error)).finally(renderReload);
                renderReload();
            }
        }
    };
    menus.set(vm, menu);
    const unregister = registerFolder(vm, {
        get directory() {return session.directory;},
        subscribe: listener => session.subscribe(listener),
        open: locale => menu.open(locale)
    });
    return {
        openDirectory: (...args: Parameters<typeof session.openDirectory>) =>
            session.openDirectory(...args).finally(renderReload),
        dispose() {
            menus.delete(vm);
            unregister();
            session.dispose();
            stopWatching?.();
            view.clearTimeout(timer);
            status.remove();
        }
    };
}

export function projectFolderActions(vm: FolderVM, locale = 'en') {
    const entry = menus.get(vm);
    if (!entry) return undefined;
    return {
        open: () => entry.open(locale),
        save: entry.session.canSave ? () => entry.save(locale) : undefined,
        detach: () => entry.session.detach()
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
