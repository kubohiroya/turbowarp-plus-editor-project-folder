import {FolderError} from './source.js';
import {createFolderSession} from './session.js';
import {createProjectFolder, isProjectFolderEmpty} from './create-folder.js';
import {registerFolder} from './folder-registry.js';
import type {ProjectFolderLocation} from './folder-registry.js';
import {openBrowserProjects} from './browser-projects.js';
import type {BrowserProjects} from './browser-projects.js';
import {chooseBrowserProject} from './browser-project-dialog.js';
import {notProjectFolderMessage, showNotProjectFolderDialog} from './not-project-dialog.js';
import type {Chosen, FolderHost, FolderVM, OpenResult, PickerWindow} from './session.js';

export type {Comparison, ComparisonRequest, ComparisonSection, FolderHost, FolderScreenState, FolderVM, OpenResult} from './session.js';
export type {ReloadTarget} from './block-reload.js';
export {followProjectFolder} from './folder-registry.js';
export type {FollowedFolder, ProjectFolderLocation} from './folder-registry.js';
export type {DeserializeBlocks} from './script-reload.js';
export {createProjectFolder, projectFolderOverwriteWarning} from './create-folder.js';
export {openBrowserProjects} from './browser-projects.js';
export type {BrowserProject, BrowserProjects, BrowserStorageState} from './browser-projects.js';
export {chooseBrowserProject, exportBrowserProject, zipFileName} from './browser-project-dialog.js';
export type {BrowserProjectChoice} from './browser-project-dialog.js';
export {notProjectFolderMessage, showNotProjectFolderDialog} from './not-project-dialog.js';
export {zipDirectory} from './zip.js';

const messages = {
    en: {
        open: 'Open Folder…', save: 'Save to Project Folder', openBrowser: 'Open Folder Saved in This Browser…',
        deviceUnavailable: 'This browser cannot open folders on your device. Use Chrome or Edge, or open a folder saved in this browser.',
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
        full: 'These changes need the whole project to be reloaded.',
        notEmpty: 'Choose an empty folder.'
    },
    ja: {
        open: 'フォルダを開く…', save: 'プロジェクトフォルダに保存', openBrowser: 'ブラウザーに保存したフォルダを開く…',
        deviceUnavailable: 'このブラウザーでは端末のフォルダを開けません。Chrome か Edge を使うか、ブラウザーに保存したフォルダを開いてください。',
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
        full: 'この変更は作品全体の再読み込みが必要です。',
        notEmpty: '空のフォルダを選んでください。'
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
type MenuEntry = {session: ReturnType<typeof createFolderSession>; open(locale: string): void; save(locale: string): void;
    /** Opens a folder kept in this browser, wherever the browser's folders are available. */
    openBrowser?(locale: string): void;
    /** Whether the browser can pick folders on the device; without it, Open uses the browser's folders. */
    deviceFolders: boolean};
const menus = new WeakMap<FolderVM, MenuEntry>();

type ObserverWindow = PickerWindow & {FileSystemObserver?: new (callback: () => void) => {
    observe(handle: FileSystemDirectoryHandle, options: {recursive: boolean}): Promise<void>;
    disconnect(): void;
}};

/**
 * Where project folders can live, besides folders the user picks on the device.
 * - `fallback` (default): in the browser's private file system when the browser cannot pick folders, as in Safari
 *   and Firefox. Open and Save then use those folders.
 * - `always`: also offer the browser's folders where the browser can pick folders.
 * - `off`: only folders on the device.
 */
export type BrowserStorageMode = 'fallback' | 'always' | 'off';

/** Options of `openDirectory`. */
export interface OpenDirectoryOptions {
    /**
     * Whether a folder that is not a project folder is told to the user in the error dialog (default true). A host
     * that tells the user in its own way passes false and acts on the `not-project` result.
     */
    notProjectDialog?: boolean;
    /** The locale of the dialog; defaults to the `locale` given to `mountProjectFolder`. */
    locale?: string;
}

/**
 * Where `createFromSnapshot` and `copyToFolder` write: `browser` for a new folder in the browser's own storage, or a
 * folder on the device that the host already picked, for example with `pickEmptyFolder`.
 */
export type ProjectFolderDestination = 'browser' | FileSystemDirectoryHandle;

const folderPickerId = 'turbowarp-plus-project-folder';
const abort = () => new DOMException('The user closed the dialog', 'AbortError');

/**
 * `autoReload` (default true) applies value and position changes without a click when the Editor has no unsaved
 * edits and the project is stopped. Other changes always wait for the reload command.
 */
export function mountProjectFolder({vm, document, host, locale = 'en', autoReload = true, browserStorage = 'fallback'}: {
    vm: FolderVM; document: Document; host: FolderHost; locale?: string; autoReload?: boolean; browserStorage?: BrowserStorageMode;
}) {
    const view = document.defaultView as ObserverWindow;
    const devicePicker = view?.showDirectoryPicker;
    const browserProjects: BrowserProjects | null = view && browserStorage !== 'off' &&
        (browserStorage === 'always' || !devicePicker) ? openBrowserProjects(view) : null;
    if ((!devicePicker && !browserProjects) || !vm.runtime?.storage) return null;
    // Folders in the browser stand in for the picker where there is none.
    const chooseBrowser = async (purpose: 'open' | 'create', title?: string) => {
        const choice = await chooseBrowserProject({document, projects: browserProjects!, locale, purpose, title});
        if (!choice) throw abort();
        return choice;
    };
    // The stored folder is opened as a whole, so it is its own root, as a folder on the device is.
    const chooseBrowserFolder = async (): Promise<Chosen> => {
        const {directory} = await chooseBrowser('open');
        browserRoots.add(directory);
        return {directory};
    };
    const pickDirectory = devicePicker ?
        async (options: {id: string; mode: 'readwrite'}): Promise<Chosen> => ({directory: await devicePicker.call(view, options)}) :
        chooseBrowserFolder;
    const locations: ProjectFolderLocation[] = [];
    if (devicePicker) locations.push('device');
    if (browserProjects) locations.push('browser');
    const pickNewDirectory = async (options: {id: string; mode: 'readwrite'}, title?: string,
        location: ProjectFolderLocation = devicePicker ? 'device' : 'browser') => {
        if (!locations.includes(location)) throw new FolderError('unsupported');
        return location === 'device' ? devicePicker!.call(view, options) : (await chooseBrowser('create', title)).directory;
    };
    /** Runs `run` with the browser folder of `directory` locked against other tabs, and marks it as updated. */
    const withBrowserProject = async <T>(directory: FileSystemDirectoryHandle | null, run: () => Promise<T>) => {
        const project = directory && browserProjects ? await browserProjects.find(directory).catch(() => null) : null;
        if (!project) return run();
        return browserProjects!.exclusive(project.id, async () => {
            const result = await run();
            await browserProjects!.touch(project.id).catch(() => {});
            return result;
        });
    };
    // The stored folders of the browser that were opened or created here, so `location` can answer without waiting.
    const browserRoots = new WeakSet<FileSystemDirectoryHandle>();
    const classify = async (handle: FileSystemDirectoryHandle) => {
        if (browserProjects && await browserProjects.find(handle).catch(() => null)) browserRoots.add(handle);
    };
    /**
     * Runs `run` on a new folder in the browser's storage named `title`, and removes the folder again unless `keep`
     * says the result is worth keeping, also when `run` throws.
     */
    const withNewBrowserFolder = async <T>(title: string | undefined, run: (root: FileSystemDirectoryHandle) => Promise<T>,
        keep: (result: T) => boolean) => {
        if (!browserProjects) throw new FolderError('unsupported');
        const project = await browserProjects.create(title || 'Project', {projectPath: ''});
        browserRoots.add(project.root);
        let kept = false;
        try {
            const result = await run(project.root);
            kept = keep(result);
            return result;
        } finally {
            if (!kept) await browserProjects.remove(project.id).catch(() => {});
        }
    };
    const overwriteMessage = () => locale.startsWith('ja') ?
        '指定されたフォルダは空ではありません。フォルダに保存されている内容が上書きされる場合があります。よろしいですか？' :
        'The selected folder is not empty. Contents in the folder may be overwritten. Continue?';
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
    // The open project stays; the dialog tells why nothing opened, or the status line where no dialog can be shown.
    const notProject = (locale: string) => showNotProjectFolderDialog({document, locale})
        .catch(() => report(notProjectFolderMessage(locale)));
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
    const opened = (locale: string, result: OpenResult) => {
        if (result === 'opened') report(messageFor(locale).opened);
        else if (result === 'not-project') void notProject(locale);
    };
    const menu: MenuEntry = {
        deviceFolders: typeof devicePicker === 'function',
        session,
        open(locale) {
            const message = messageFor(locale);
            session.open(options => pickDirectory(options), () => view.confirm(message.replace))
                .then(result => opened(locale, result), error => fail(locale, error)).finally(renderReload);
            renderReload();
        },
        openBrowser: browserProjects ? locale => {
            const message = messageFor(locale);
            session.open(chooseBrowserFolder, () => view.confirm(message.replace))
                .then(result => opened(locale, result), error => fail(locale, error)).finally(renderReload);
            renderReload();
        } : undefined,
        save(locale) {
            if (!session.busy) {
                const message = messageFor(locale);
                const directory = session.directory;
                const save = () => withBrowserProject(directory, () => {
                    if (session.directory !== directory) throw new FolderError('conflict');
                    return session.save();
                });
                void (host.saveWithLock?.(save) ?? save()).then(({status, sourceRemoved}) => {
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
        get root() {return session.root;},
        locations,
        subscribe: listener => session.subscribe(listener),
        subscribeEdits: listener => session.subscribeEdits(listener),
        unsavedPaths: () => session.unsavedPaths(),
        open: locale => menu.open(locale),
        mutate: (directory, operation) => session.mutate(directory, operation).finally(renderReload)
    });
    return {
        /**
         * Opens the project at the root of `directory`, as the user's Open would, and resolves with the result. A folder
         * that is not a project folder changes nothing, shows the error dialog unless `options.notProjectDialog` is
         * false, and resolves with `not-project`. `root` is the folder the user chose, for a host that located the
         * project in it; it defaults to `directory`.
         */
        openDirectory: (directory: FileSystemDirectoryHandle, confirmReplace: () => boolean,
            root?: FileSystemDirectoryHandle | null, options: OpenDirectoryOptions = {}): Promise<OpenResult> =>
            classify(root ?? directory).then(() => session.openDirectory(directory, confirmReplace, root ?? undefined)).then(result => {
                if (result === 'not-project' && options.notProjectDialog !== false) void notProject(options.locale ?? locale);
                return result;
            }).finally(renderReload),
        unsavedPaths: () => session.unsavedPaths(),
        readUnsavedFile: (path: string) => session.readUnsavedFile(path),
        subscribeEdits: (listener: () => void) => session.subscribeEdits(listener),
        save: () => withBrowserProject(session.directory, () => session.save()).finally(renderReload),
        /** The folders kept in this browser, when they are offered, for a host that lists or exports them. */
        browserProjects,
        /**
         * Creates a project folder from a snapshot and opens it. `destination` writes to a new folder in the browser's
         * storage (`browser`, named by `title`; it is removed again unless the project opens from it) or to a folder the
         * host picked on the device (see `pickEmptyFolder`). Without it, `directory` is the folder the host picked, and
         * otherwise `location` (or the device picker where there is one) asks the user: `title` then names a folder
         * made in the browser, where the user names a new folder instead of picking one. A folder that is not empty is
         * overwritten only when the user confirms it.
         */
        createFromSnapshot({prepareFiles, collectEdits, directory, current = () => true, title, location, destination}: {
            prepareFiles: () => Promise<ReadonlyMap<string, Uint8Array>>;
            collectEdits?: () => Promise<void>;
            directory?: FileSystemDirectoryHandle;
            current?: () => boolean;
            title?: string;
            /** Explicit destination; omitted uses the device picker when available. */
            location?: ProjectFolderLocation;
            destination?: ProjectFolderDestination;
        }): Promise<OpenResult> {
            const create = (picked?: FileSystemDirectoryHandle) => session.createFromSnapshot(async () => {
                try {
                    const selected = picked ?? await pickNewDirectory({id: folderPickerId, mode: 'readwrite'}, title, location);
                    if (!current()) return null;
                    await classify(selected);
                    const overwrite = !await isProjectFolderEmpty(selected);
                    if (!current() || (overwrite && !view.confirm(overwriteMessage()))) return null;
                    await collectEdits?.();
                    return current() ? {directory: selected, overwrite} : null;
                } catch (error) {
                    if (error instanceof DOMException && error.name === 'AbortError') return null;
                    throw error;
                }
            }, prepareFiles, current).finally(renderReload);
            if (destination === 'browser') return withNewBrowserFolder(title, create, result => result === 'opened');
            return create(destination ?? directory);
        },
        /**
         * Writes a project folder from a snapshot to `destination` and leaves the open project as it is: nothing is
         * opened or attached, `directory` and `root` stay, and `followProjectFolder` listeners are not called (Save a
         * Copy). `browser` makes a new folder in the browser's storage named by `title`, removed again when nothing is
         * written; a folder on the device that is not empty is overwritten only when the user confirms it. Resolves
         * with the folder written, or `null` when the user declined or `current()` turned false.
         */
        async copyToFolder({destination, prepareFiles, collectEdits, current = () => true, title}: {
            destination: ProjectFolderDestination;
            prepareFiles: () => Promise<ReadonlyMap<string, Uint8Array>>;
            collectEdits?: () => Promise<void>;
            current?: () => boolean;
            title?: string;
        }): Promise<FileSystemDirectoryHandle | null> {
            const write = async (target: FileSystemDirectoryHandle, isNew: boolean) => {
                try {
                    const overwrite = !isNew && !await isProjectFolderEmpty(target);
                    if (!current() || (overwrite && !view.confirm(overwriteMessage()))) return null;
                    await collectEdits?.();
                    if (!current()) return null;
                    const files = await prepareFiles();
                    if (!current()) return null;
                    await createProjectFolder({directory: target, files, storage: vm.runtime.storage, overwrite, current});
                    return target;
                } catch (error) {
                    if (error instanceof DOMException && error.name === 'AbortError') return null;
                    throw error;
                }
            };
            if (destination === 'browser') return withNewBrowserFolder(title, root => write(root, true), result => result !== null);
            return write(destination, false);
        },
        /**
         * Asks the user for an empty folder on the device, for a new project. Call it while handling the user's click,
         * as the browser lets the folder picker open only then. Resolves with `null` when the user cancelled, or chose
         * a folder that is not empty, which the status line then tells (“Choose an empty folder.”). Rejects with
         * `unsupported` where the browser cannot pick folders on the device.
         */
        async pickEmptyFolder({locale: language = locale, id = folderPickerId}: {locale?: string; id?: string} = {}) {
            if (!devicePicker) throw new FolderError('unsupported');
            let picked: FileSystemDirectoryHandle;
            try {
                picked = await devicePicker.call(view, {id, mode: 'readwrite'});
            } catch (error) {
                if (error instanceof DOMException && error.name === 'AbortError') return null;
                throw error;
            }
            if (await isProjectFolderEmpty(picked)) return picked;
            report(messageFor(language).notEmpty);
            return null;
        },
        /**
         * Gives the open folder the title `title` in the list of folders kept in this browser. Resolves with `false`,
         * changing nothing, when no folder is open or the open folder is not kept in this browser: a folder on the
         * device keeps its name, as the browser cannot rename it.
         */
        async renameCurrentBrowserFolder(title: string) {
            const root = session.root;
            const entry = root && browserProjects ? await browserProjects.find(root).catch(() => null) : null;
            if (!entry || session.root !== root) return false;
            await browserProjects!.rename(entry.id, title);
            return true;
        },
        /** Where the open folder is: `browser` for a folder kept in this browser, `device`, or `null` with none open. */
        get location(): ProjectFolderLocation | null {
            const root = session.root;
            return root ? (browserRoots.has(root) ? 'browser' : 'device') : null;
        },
        /** Where new project folders can be made: `device` with the folder picker, and `browser` with the browser's folders. */
        locations: locations as readonly ProjectFolderLocation[],
        /**
         * The folder the loaded project came from, or `null` once another project loaded or the folder was
         * detached. A host can tell projects apart by it, for example to keep the layout of each one.
         */
        get directory() {return session.directory;},
        /**
         * The folder the user chose for the loaded project, or `null` like `directory`. It is `directory` itself, the
         * project folder, unless the host gave another folder to `openDirectory`.
         */
        get root() {return session.root;},
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
        openBrowser: entry.openBrowser ? () => entry.openBrowser!(locale) : undefined,
        /** Whether Open can pick a folder on the device. Safari and Firefox cannot, so hosts show Open as unavailable. */
        deviceFolders: entry.deviceFolders,
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
    const item = (action: 'open' | 'openBrowser' | 'save') => {
        // Without the device's folder picker, Open is shown but unavailable; the browser's folders have their own item.
        if (action === 'open' && !entry.deviceFolders) {
            return createElement(MenuItem, {command: `project-folder-${action}`},
                createElement('span', {role: 'button', tabIndex: -1, 'aria-disabled': true, title: labels.deviceUnavailable,
                    style: {opacity: 0.5, cursor: 'default'}}, labels[action]));
        }
        const run = () => {onRequestClose(); entry[action]!(locale);};
        return createElement(MenuItem, {command: `project-folder-${action}`, onClick: run},
            createElement('span', {role: 'button', tabIndex: 0, onKeyDown(event: KeyboardEvent) {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                event.stopPropagation();
                run();
            }}, labels[action]));
    };
    return createElement(MenuSection, null, item('open'), entry.openBrowser ? item('openBrowser') : null,
        entry.session.canSave ? item('save') : null);
}
export {parseExplorerState, readExplorerState, subscribeExplorerState, writeExplorerState} from './explorer-state.js';
export type {ExplorerTreeState} from './explorer-state.js';
