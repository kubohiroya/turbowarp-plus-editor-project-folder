import {assetKey, assertFolderUnchanged, FolderError, parseProject, projectChanges, projectFile, readFolder} from './source.js';
import type {Asset, FolderSource, Project, Storage} from './source.js';

export interface FolderVM {
    runtime: {
        storage: Storage;
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
}

type Session = {source: FolderSource; baseline: Project; stage: object};
export type OpenResult = 'opened' | 'cancelled';
export type SaveResult = 'saved' | 'unchanged';

export function createFolderSession(vm: FolderVM, host: FolderHost) {
    let current: Session | null = null;
    let busy = false;
    let disposed = false;
    let revision = 0;
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
            current = {source, stage, baseline: snapshot()};
            vm.renderer?.draw();
            return 'opened';
        } finally {
            busy = false;
        }
    };
    return {
        get canSave() {return current !== null;},
        get busy() {return busy;},
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
                session.baseline = edited;
                if (current === session && revision === saveRevision) host.onSaved();
                return 'saved';
            } finally {
                busy = false;
            }
        },
        dispose
    };
}
