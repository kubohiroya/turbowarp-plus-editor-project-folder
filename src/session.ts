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

type PendingUpdate = {update: FolderUpdate; edits: ReturnType<typeof planBlockReload> | null};
type Session = {source: FolderSource; baseline: Project; stage: object; pending: PendingUpdate | 'blocked' | null};
export type ReloadState = 'ready' | 'dirty' | 'running' | 'busy' | 'blocked' | null;
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
        const previous = session.pending;
        const update = await readFolderUpdate(session.source, previous && previous !== 'blocked' ? previous.update : null);
        if (!update || update === 'blocked') return update;
        if (previous && previous !== 'blocked' && previous.update === update) return previous;
        try {
            return {update, edits: planBlockReload(session.source.project, update.project)};
        } catch (error) {
            if (!(error instanceof FolderError)) throw error;
            return {update, edits: null};
        }
    };
    const reloadState = (): ReloadState => {
        const pending = current?.pending;
        if (!pending) return null;
        if (busy) return 'busy';
        if (host.isProjectDirty()) return 'dirty';
        if (host.blockReload?.isRunning()) return 'running';
        return pending === 'blocked' || pending.edits === null ? 'blocked' : 'ready';
    };
    const canApply = () => !host.isProjectDirty() && !host.blockReload?.isRunning();
    return {
        get canSave() {return current !== null;},
        get busy() {return busy;},
        get reloadState() {return reloadState();},
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
                if (!pending || pending === 'blocked' || pending.edits === null || editRevision !== revision || !canApply()) {
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
