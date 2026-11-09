import {assetKey, assertFolderUnchanged, FolderError, parseProject, projectChanges, projectFile, readFolder, readFolderUpdate} from './source.js';
import type {Asset, FolderSource, FolderUpdate, Project, Storage} from './source.js';
import {applyBlockReload, planBlockReload} from './block-reload.js';
import type {ReloadTarget} from './block-reload.js';

export interface FolderVM {
    runtime: {
        storage: Storage;
        targets?: readonly ReloadTarget[];
        getTargetForStage(): object | null;
        on(event: 'PROJECT_LOADED', listener: () => void): void;
        off(event: 'PROJECT_LOADED', listener: () => void): void;
    };
    on(event: 'PROJECT_CHANGED', listener: () => void): void;
    off(event: 'PROJECT_CHANGED', listener: () => void): void;
    quit(): void;
    loadProject(project: string): Promise<unknown>;
    toJSON(target?: string, options?: {allowOptimization: boolean}): string;
    renderer?: {draw(): void};
}

type FileSystemPicker = (options: {id: string; mode: 'readwrite'}) => Promise<FileSystemDirectoryHandle>;
export type PickerWindow = Window & {showDirectoryPicker?: FileSystemPicker};

const storageReaders = new WeakMap<Storage, {assets: Map<string, Asset> | null}>();
const readerFor = (storage: Storage) => {
    const existing = storageReaders.get(storage);
    if (existing) return existing;
    const reader: {assets: Map<string, Asset> | null} = {assets: null};
    storage.addHelper({load(type, id, format) {
        const asset = reader.assets?.get(assetKey(type, id, format));
        return asset ? Promise.resolve(asset) : null;
    }}, 101);
    storageReaders.set(storage, reader);
    return reader;
};

export interface FolderHost {
    isProjectDirty(): boolean;
    beforeLoad(): void;
    onOpened(title: string): void;
    onSaved(): void;
    blockReload?: {
        isRunning(): boolean;
        subscribe(listener: () => void): () => void;
        onApplied(targets: readonly ReloadTarget[]): void;
    };
}

// `stable` turns true once two scans see the same file version, so consecutive writes settle before auto-apply.
type PendingUpdate = {update: FolderUpdate; edits: ReturnType<typeof planBlockReload> | null; stable: boolean};
type Pending = PendingUpdate | 'structure' | 'waiting';
type Session = {source: FolderSource; baseline: Project; stage: object; pending: Pending | null};
/**
 * `ready`: values and positions can be applied in place. `full`: the change needs the whole project reloaded.
 * `waiting`: an external write looks incomplete and is checked again. `dirty`, `running` and `busy` hold the change.
 */
export type ReloadState = 'ready' | 'full' | 'waiting' | 'dirty' | 'running' | 'busy' | null;
/** What the reload command does for the pending change, regardless of whether it may run now. */
export type ReloadKind = 'partial' | 'full' | null;
export type OpenResult = 'opened' | 'cancelled';
export type SaveResult = 'saved' | 'unchanged';

export function createFolderSession(vm: FolderVM, host: FolderHost) {
    let current: Session | null = null;
    let busy = false;
    let disposed = false;
    let revision = 0;
    let scanning: Promise<void> | null = null;
    const snapshot = () => parseProject(vm.toJSON(undefined, {allowOptimization: false}));
    const changed = () => {revision++;};
    const loaded = () => {current = null;};
    vm.runtime.on('PROJECT_LOADED', loaded);
    vm.on('PROJECT_CHANGED', changed);
    const active = (session: Session) => {
        if (disposed || current !== session || vm.runtime.getTargetForStage() !== session.stage) {
            throw new FolderError('conflict');
        }
    };
    const dispose = () => {
        disposed = true;
        current = null;
        vm.runtime.off('PROJECT_LOADED', loaded);
        vm.off('PROJECT_CHANGED', changed);
    };
    const openFrom = async (
        getDirectory: () => Promise<FileSystemDirectoryHandle | null>,
        confirmReplace: () => boolean
    ): Promise<OpenResult> => {
        if (disposed || busy) return 'cancelled';
        busy = true;
        const priorStage = vm.runtime.getTargetForStage();
        try {
            const directory = await getDirectory();
            if (!directory || disposed) return 'cancelled';
            const storage = vm.runtime.storage;
            const source = await readFolder(directory, storage);
            if (disposed || vm.runtime.getTargetForStage() !== priorStage) return 'cancelled';
            if (host.isProjectDirty() && !confirmReplace()) return 'cancelled';
            host.beforeLoad();
            current = null;
            const reader = readerFor(storage);
            const assets = source.storageAssets;
            reader.assets = assets;
            let stage: object | null;
            try {
                vm.quit();
                await vm.loadProject(source.projectText);
                stage = vm.runtime.getTargetForStage();
            } finally {
                if (reader.assets === assets) reader.assets = null;
            }
            if (disposed || !stage || vm.runtime.getTargetForStage() !== stage) return 'cancelled';
            host.onOpened(directory.name);
            current = {source, stage, baseline: snapshot(), pending: null};
            vm.renderer?.draw();
            return 'opened';
        } finally {
            busy = false;
        }
    };
    const readUpdate = async (session: Session): Promise<Session['pending']> => {
        const previous = typeof session.pending === 'object' ? session.pending : null;
        const update = await readFolderUpdate(session.source, previous?.update ?? null);
        if (!update || typeof update === 'string') return update;
        if (previous?.update === update) return {...previous, stable: true};
        try {
            return {update, edits: planBlockReload(session.source.project, update.project), stable: false};
        } catch (error) {
            if (!(error instanceof FolderError)) throw error;
            return {update, edits: null, stable: false};
        }
    };
    const reloadKind = (): ReloadKind => {
        const pending = current?.pending;
        if (!pending || pending === 'waiting') return null;
        return pending === 'structure' || pending.edits === null ? 'full' : 'partial';
    };
    const reloadState = (): ReloadState => {
        const pending = current?.pending;
        if (!pending) return null;
        if (busy) return 'busy';
        if (pending === 'waiting') return 'waiting';
        if (host.isProjectDirty()) return 'dirty';
        if (host.blockReload?.isRunning()) return 'running';
        return reloadKind() === 'full' ? 'full' : 'ready';
    };
    const canApply = () => !host.isProjectDirty() && !host.blockReload?.isRunning();
    return {
        detach() {current = null;},
        get canSave() {return current !== null;},
        get busy() {return busy;},
        get reloadState() {return reloadState();},
        get reloadKind() {return reloadKind();},
        /** A partial change that has stayed the same across two scans and may be applied without asking. */
        get canAutoReload() {
            const pending = current?.pending;
            return reloadState() === 'ready' && typeof pending === 'object' && pending !== null && pending.stable;
        },
        /** True while a change is new or looks incomplete, so a host can look again sooner than its interval. */
        get settling() {
            const pending = current?.pending;
            return pending === 'waiting' || (typeof pending === 'object' && pending !== null && !pending.stable);
        },
        /** Identifies the pending project file version, so a host can attempt an automatic apply only once. */
        get pendingVersion() {
            const pending = current?.pending;
            return typeof pending === 'object' && pending !== null ? pending.update.version : null;
        },
        get directory() {return current?.source.directory ?? null;},
        refresh(): Promise<void> {
            if (disposed || busy || !current || !host.blockReload) return Promise.resolve();
            if (scanning) return scanning;
            const session = current;
            const baseline = session.baseline;
            scanning = readUpdate(session).then(pending => {
                if (current === session && session.baseline === baseline && !busy) session.pending = pending;
            }).finally(() => {scanning = null;});
            return scanning;
        },
        async reload(): Promise<boolean> {
            if (!current || reloadState() !== 'ready' || !host.blockReload) return false;
            const session = current;
            active(session);
            busy = true;
            try {
                const editRevision = revision;
                const pending = await readUpdate(session);
                if (current !== session || disposed || vm.runtime.getTargetForStage() !== session.stage) return false;
                session.pending = pending;
                if (!pending || typeof pending === 'string' || pending.edits === null || editRevision !== revision || !canApply()) {
                    return false;
                }
                let targets: readonly ReloadTarget[];
                try {
                    targets = applyBlockReload(vm.runtime.targets ?? [], pending.edits);
                } catch (error) {
                    if (error instanceof FolderError) session.pending = {...pending, edits: null};
                    throw error;
                }
                session.baseline = snapshot();
                session.source.project = pending.update.project;
                session.source.files.set(projectFile, pending.update.bytes);
                session.source.versions.set(projectFile, pending.update.version);
                session.pending = null;
                host.blockReload.onApplied(targets);
                return true;
            } finally {
                busy = false;
            }
        },
        /**
         * Reads the open folder again and replaces the project, for changes a partial reload cannot apply. Unsaved
         * edits are discarded only when `confirmReplace` agrees. The VM is left untouched while a project runs.
         */
        reloadAll(confirmReplace: () => boolean): Promise<OpenResult> {
            const session = current;
            if (!session || !session.pending || session.pending === 'waiting' || host.blockReload?.isRunning()) {
                return Promise.resolve('cancelled');
            }
            return openFrom(() => Promise.resolve(current === session ? session.source.directory : null), confirmReplace);
        },
        open(pick: FileSystemPicker, confirmReplace: () => boolean): Promise<OpenResult> {
            return openFrom(async () => {
                try {
                    return await pick({id: 'turbowarp-plus-project-folder', mode: 'readwrite'});
                } catch (error) {
                    if (error instanceof DOMException && error.name === 'AbortError') return null;
                    throw error;
                }
            }, confirmReplace);
        },
        openDirectory(directory: FileSystemDirectoryHandle, confirmReplace: () => boolean): Promise<OpenResult> {
            return openFrom(() => Promise.resolve(directory), confirmReplace);
        },
        async save(): Promise<SaveResult> {
            if (!current || busy) throw new FolderError('conflict');
            const session = current;
            active(session);
            busy = true;
            try {
                const saveRevision = revision;
                const edited = snapshot();
                const result = projectChanges(session.source.project, session.baseline, edited);
                await assertFolderUnchanged(session.source);
                active(session);
                if (!result) {
                    if (revision === saveRevision) host.onSaved();
                    return 'unchanged';
                }
                const text = `${JSON.stringify(result, null, 2)}\n`;
                const file = await session.source.directory.getFileHandle(projectFile);
                const options = {mode: 'exclusive'} as FileSystemCreateWritableOptions;
                const writable = await file.createWritable(options);
                try {
                    await writable.write(text);
                    await assertFolderUnchanged(session.source);
                    active(session);
                    await writable.close();
                } catch (error) {
                    await writable.abort().catch(() => {});
                    throw error;
                }
                session.source.project = result;
                session.source.files.set(projectFile, new TextEncoder().encode(text));
                session.source.versions.delete(projectFile);
                session.baseline = edited;
                session.pending = null;
                if (current === session && revision === saveRevision) host.onSaved();
                return 'saved';
            } finally {
                busy = false;
            }
        },
        dispose
    };
}
