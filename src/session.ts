import {assetKey, assetTypeFor, assertFolderUnchanged, extensionsFile, fileVersion, FolderError, manifestFile, parseProject,
    planExtensionSave, projectAssets, projectChanges, projectFile, readFolder, readFolderUpdate, sameBytes, unsupported} from './source.js';
import type {Asset, AssetKind, FolderSource, FolderUpdate, JsonObject, Project, Storage} from './source.js';
import {applyBlockReload, planBlockReload} from './block-reload.js';
import type {ReloadTarget} from './block-reload.js';
import {applyScriptReload, planScriptReload} from './script-reload.js';
import type {DeserializeBlocks, ScriptReloadTarget} from './script-reload.js';
import {createProjectFolder} from './create-folder.js';

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
    loadProject(project: string, options?: {replaceLegacyExtensions: boolean}): Promise<unknown>;
    toJSON(target?: string, options?: {allowOptimization: boolean}): string;
    assets?: readonly (Asset | null | undefined)[];
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
    saveWithLock?<T>(save: () => Promise<T>): Promise<T>;
    blockReload?: {
        isRunning(): boolean;
        subscribe(listener: () => void): () => void;
        onApplied(targets: readonly ReloadTarget[]): void;
        /**
         * The VM's sb3 `deserializeBlocks`. With it, changes that add, remove or reconnect blocks replace the
         * changed scripts in place; without it they need the whole project reloaded.
         */
        deserializeBlocks?: DeserializeBlocks;
        /**
         * Shows the comparisons in `request` and resolves with the chosen action's id, or `null` when closed.
         * With it, unsaved edits are compared with the folder before the user chooses to replace them.
         */
        compareChanges?(request: ComparisonRequest): Promise<string | null>;
    };
}

/** A titled comparison of two project.source.json texts; `null` stands for a version that cannot be shown. */
export type ComparisonSection = {title: string; before: string | null; after: string | null};
export type ComparisonRequest = {
    title: string; description: string; notes: string[]; sections: ComparisonSection[];
    actions: {id: string; label: string}[]; closeLabel: string;
};
/** The last version loaded or saved, the Editor's edits as Save would write them, and the folder now. */
export type Comparison = {base: string; editor: string | null; disk: string | null};

// `stable` turns true once two scans see the same file version, so consecutive writes settle before auto-apply.
type Edits = {kind: 'values'; changes: ReturnType<typeof planBlockReload>} |
    {kind: 'scripts'; changes: ReturnType<typeof planScriptReload>};
type PendingUpdate = {update: FolderUpdate; edits: Edits | null; stable: boolean};
type Pending = PendingUpdate | 'structure' | 'waiting';
type Session = {source: FolderSource; baseline: Project; ids: string[] | undefined; stage: object; pending: Pending | null};
/**
 * `ready`: the change can be applied in place: values and positions, or with `deserializeBlocks`, whole scripts. `full`: the change needs the whole project reloaded.
 * `waiting`: an external write looks incomplete and is checked again. `dirty`, `running` and `busy` hold the change.
 */
export type ReloadState = 'ready' | 'full' | 'waiting' | 'dirty' | 'running' | 'busy' | null;
/** What the reload command does for the pending change, regardless of whether it may run now. */
export type ReloadKind = 'partial' | 'full' | null;
export type OpenResult = 'opened' | 'cancelled';
type SaveResult = {status: 'saved' | 'unchanged'; sourceRemoved: string[]};
type SaveDirectory = {directory: FileSystemDirectoryHandle; files: Map<string, Uint8Array>; prefix: string};

type VMAsset = {assetId: string; dataFormat: string; data?: Uint8Array};
const encodeJson = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);

function saveManifest(source: FolderSource, added: Iterable<string>, removed: readonly string[]) {
    const value = JSON.parse(new TextDecoder().decode(source.files.get(manifestFile))) as JsonObject;
    const entries = (value.archiveEntries as string[]).filter(name => !removed.includes(name));
    return encodeJson({...value, archiveEntries: [...entries, ...added]});
}

export function createFolderSession(vm: FolderVM, host: FolderHost) {
    let current: Session | null = null;
    // Told when a folder opens or closes, and after a save, so a view of the folder can read it again.
    const listeners = new Set<() => void>();
    const notify = () => {for (const listener of [...listeners]) listener();};
    const setCurrent = (session: Session | null) => {
        if (current === session) return;
        current = session;
        notify();
    };
    let busy = false;
    let disposed = false;
    let revision = 0;
    let scanning: Promise<void> | null = null;
    const snapshot = () => parseProject(vm.toJSON(undefined, {allowOptimization: false}));
    type RuntimeTarget = {id?: string; isStage: boolean; isOriginal: boolean; getName(): string; sprite?: {
        costumes?: readonly {asset?: VMAsset}[]; sounds?: readonly {asset?: VMAsset}[];
    }};
    const runtimeTargets = () => (vm.runtime.targets ?? []) as readonly RuntimeTarget[];
    // Runtime ids in the order of the project's targets, so a renamed sprite is still the same sprite.
    const identify = (project: Project): string[] | undefined => {
        const ids = new Map<string, string>();
        for (const target of runtimeTargets()) {
            if (target.isOriginal && target.id) ids.set(target.isStage ? 'stage' : `sprite:${target.getName()}`, target.id);
        }
        const result = project.targets.map(target => ids.get(target.isStage ? 'stage' : `sprite:${target.name}`));
        return result.every((id): id is string => id !== undefined) ? result : undefined;
    };
    const identity = (session: Session, edited: Project) => {
        const after = identify(edited);
        return session.ids && after ? {before: session.ids, after} : undefined;
    };
    // Writes a whole file and, for a file the folder already had, checks the folder before the write takes effect.
    // A new file is empty until then, so it is checked by the writes that follow it instead.
    const writeChecked = async (session: Session, handle: FileSystemFileHandle, data: Uint8Array, existing: boolean) => {
        const options = (existing ? {mode: 'exclusive'} : {}) as FileSystemCreateWritableOptions;
        const writable = await handle.createWritable(options);
        try {
            await writable.write(data as Uint8Array<ArrayBuffer>);
            if (existing) await assertFolderUnchanged(session.source);
            active(session);
            await writable.close();
        } catch (error) {
            await writable.abort().catch(() => {});
            throw error;
        }
    };
    // The bytes of an asset the Editor holds, such as a costume added since the folder was opened.
    const assetData = (name: string, kind: AssetKind) => {
        if (kind === 'fonts') {
            return vm.assets?.find(asset => asset && `${asset.assetId}.${asset.dataFormat}` === name)?.data;
        }
        for (const target of runtimeTargets()) {
            for (const entry of [...target.sprite?.costumes ?? [], ...target.sprite?.sounds ?? []]) {
                const asset = entry.asset;
                if (asset && `${asset.assetId}.${asset.dataFormat}` === name && asset.data) return asset.data;
            }
        }
        return null;
    };
    const editListeners = new Set<() => void>();
    const notifyEdits = () => {for (const listener of [...editListeners]) listener();};
    const changed = () => {revision++; notifyEdits();};
    const planSave = (session: Session, edited: Project) => {
        const {source} = session;
        const result = projectChanges(source.project, session.baseline, edited, identity(session, edited));
        const extensionSave = planExtensionSave(source, result ?? source.project);
        const needed = projectAssets(extensionSave.project);
        const added = [...needed].filter(([name]) => !source.bytes.has(name));
        const removed = [...source.bytes.keys()].filter(name => !needed.has(name));
        return {result, extensionSave, added, removed};
    };
    const loaded = () => setCurrent(null);
    vm.runtime.on('PROJECT_LOADED', loaded);
    vm.on('PROJECT_CHANGED', changed);
    const active = (session: Session) => {
        if (disposed || current !== session || vm.runtime.getTargetForStage() !== session.stage) {
            throw new FolderError('conflict');
        }
    };
    const dispose = () => {
        disposed = true;
        setCurrent(null);
        listeners.clear();
        editListeners.clear();
        vm.runtime.off('PROJECT_LOADED', loaded);
        vm.off('PROJECT_CHANGED', changed);
    };
    const openFrom = async (
        getDirectory: () => Promise<FileSystemDirectoryHandle | null>,
        confirmReplace: () => boolean,
        prepare: (directory: FileSystemDirectoryHandle) => Promise<FolderSource | null> =
            directory => readFolder(directory, vm.runtime.storage),
        stillCurrent = () => true
    ): Promise<OpenResult> => {
        if (disposed || busy) return 'cancelled';
        busy = true;
        const priorStage = vm.runtime.getTargetForStage();
        try {
            const directory = await getDirectory();
            if (!directory || disposed) return 'cancelled';
            const storage = vm.runtime.storage;
            const source = await prepare(directory);
            if (!source || disposed || !stillCurrent() || vm.runtime.getTargetForStage() !== priorStage) return 'cancelled';
            if (host.isProjectDirty() && !confirmReplace()) return 'cancelled';
            host.beforeLoad();
            setCurrent(null);
            const reader = readerFor(storage);
            const assets = source.storageAssets;
            reader.assets = assets;
            let stage: object | null;
            try {
                vm.quit();
                await vm.loadProject(source.loadText, {replaceLegacyExtensions: true});
                stage = vm.runtime.getTargetForStage();
            } finally {
                if (reader.assets === assets) reader.assets = null;
            }
            if (disposed || !stage || vm.runtime.getTargetForStage() !== stage) return 'cancelled';
            host.onOpened(directory.name);
            const baseline = snapshot();
            setCurrent({source, stage, baseline, ids: identify(baseline), pending: null});
            vm.renderer?.draw();
            return 'opened';
        } finally {
            busy = false;
        }
    };
    // Value and position edits keep every VM block. Other script changes replace only the changed scripts.
    const planEdits = (before: Project, after: Project): Edits | null => {
        try {
            return {kind: 'values', changes: planBlockReload(before, after)};
        } catch (error) {
            if (!(error instanceof FolderError)) throw error;
        }
        if (!host.blockReload?.deserializeBlocks) return null;
        try {
            return {kind: 'scripts', changes: planScriptReload(before, after)};
        } catch (error) {
            if (!(error instanceof FolderError)) throw error;
            return null;
        }
    };
    const readUpdate = async (session: Session): Promise<Session['pending']> => {
        const previous = typeof session.pending === 'object' ? session.pending : null;
        const update = await readFolderUpdate(session.source, previous?.update ?? null);
        if (!update || typeof update === 'string') return update;
        if (previous?.update === update) return {...previous, stable: true};
        return {update, edits: planEdits(session.source.project, update.project), stable: false};
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
        detach() {setCurrent(null);},
        /** Calls `listener` when a folder opens or closes, and after a save. Returns the function that stops it. */
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => {listeners.delete(listener);};
        },
        subscribeEdits(listener: () => void) {
            editListeners.add(listener);
            return () => {editListeners.delete(listener);};
        },
        /** Files affected by the pending save. A save in progress still owns its baseline. */
        unsavedPaths(): ReadonlySet<string> | null {
            if (busy) return null;
            const paths = new Set<string>();
            if (!current) return paths;
            try {
                const {result, extensionSave, added, removed} = planSave(current, snapshot());
                if (result) paths.add(projectFile);
                if (extensionSave.manifestChanged) paths.add(extensionsFile);
                if (added.length || removed.length) paths.add(manifestFile);
                for (const name of [...added.map(([name]) => name), ...removed]) paths.add(`assets/${name}`);
                for (const name of [...extensionSave.writes.keys(), ...extensionSave.removed]) paths.add(`extensions/${name}`);
            } catch (error) {
                if (!(error instanceof FolderError)) throw error;
                if (host.isProjectDirty()) paths.add(projectFile);
            }
            return paths;
        },
        /** The bytes the next save would write, null for a deletion, or undefined when no preview is available. */
        readUnsavedFile(path: string): Uint8Array | null | undefined {
            if (!current || busy) return;
            try {
                const {result, extensionSave, added, removed} = planSave(current, snapshot());
                if (path === projectFile && result) return encodeJson(extensionSave.project);
                if (path === extensionsFile && extensionSave.manifestChanged) return encodeJson(extensionSave.embedded);
                if (path === manifestFile && (added.length || removed.length))
                    return saveManifest(current.source, added.map(([name]) => name), removed);
                if (path.startsWith('assets/')) {
                    const name = path.slice('assets/'.length);
                    if (removed.includes(name)) return null;
                    const kind = added.find(([asset]) => asset === name)?.[1];
                    if (kind) return assetData(name, kind) ?? undefined;
                }
                if (path.startsWith('extensions/')) {
                    const name = path.slice('extensions/'.length);
                    return extensionSave.removed.includes(name) ? null : extensionSave.writes.get(name);
                }
            } catch (error) {
                if (!(error instanceof FolderError)) throw error;
            }
        },
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
        async mutate(directory: FileSystemDirectoryHandle, operation: (guard: () => void) => Promise<void>) {
            const session = current;
            if (!session || busy || session.source.directory !== directory) throw new FolderError('conflict');
            const guard = () => active(session);
            guard();
            busy = true;
            try {
                await operation(guard);
            } finally {
                busy = false;
                if (current === session) notify();
            }
        },
        /**
         * Reads what to compare before unsaved edits are replaced. `editor` is `null` when the edits cannot be
         * written to the folder, and `disk` when the folder's project file cannot be read.
         */
        async comparison(): Promise<Comparison | null> {
            const session = current;
            if (!session) return null;
            const decoder = new TextDecoder();
            const base = decoder.decode(session.source.files.get(projectFile));
            let editor: string | null;
            try {
                const edited = snapshot();
                const result = projectChanges(session.source.project, session.baseline, edited, identity(session, edited));
                editor = result ? `${JSON.stringify(planExtensionSave(session.source, result).project, null, 2)}\n` : base;
            } catch (error) {
                if (!(error instanceof FolderError)) throw error;
                editor = null;
            }
            let disk: string | null;
            try {
                const file = await (await session.source.directory.getFileHandle(projectFile)).getFile();
                disk = decoder.decode(new Uint8Array(await file.arrayBuffer()));
            } catch {
                disk = null;
            }
            return current === session ? {base, editor, disk} : null;
        },
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
                    const {edits} = pending;
                    targets = edits.kind === 'values' ? applyBlockReload(vm.runtime.targets ?? [], edits.changes) :
                        applyScriptReload((vm.runtime.targets ?? []) as readonly ScriptReloadTarget[], edits.changes,
                            host.blockReload.deserializeBlocks!);
                } catch (error) {
                    // After a refused or failed in-place change, offer the whole reload instead of retrying it.
                    session.pending = {...pending, edits: null};
                    throw error;
                }
                session.baseline = snapshot();
                session.ids = identify(session.baseline);
                session.source.project = pending.update.project;
                session.source.files.set(projectFile, pending.update.bytes);
                session.source.versions.set(projectFile, pending.update.version);
                session.pending = null;
                host.blockReload.onApplied(targets);
                notify();
                return true;
            } finally {
                busy = false;
                notifyEdits();
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
        createFromSnapshot(selectDestination: () => Promise<{directory: FileSystemDirectoryHandle; overwrite: boolean} | null>,
            prepareFiles: () => Promise<ReadonlyMap<string, Uint8Array>>, isCurrent: () => boolean): Promise<OpenResult> {
            const stage = vm.runtime.getTargetForStage();
            let savedRevision: number | undefined;
            const currentProject = () => !disposed && vm.runtime.getTargetForStage() === stage &&
                (savedRevision === undefined || revision === savedRevision) && isCurrent();
            let overwrite = false;
            return openFrom(async () => {
                const destination = await selectDestination();
                overwrite = destination?.overwrite ?? false;
                return destination?.directory ?? null;
            }, currentProject, async directory => {
                if (!currentProject()) return null;
                savedRevision = revision;
                const files = await prepareFiles();
                if (!currentProject()) return null;
                return createProjectFolder({directory, files, storage: vm.runtime.storage, overwrite, current: currentProject});
            }, currentProject);
        },
        async save(): Promise<SaveResult> {
            if (!current || busy) throw new FolderError('conflict');
            const session = current;
            active(session);
            busy = true;
            try {
                const saveRevision = revision;
                const edited = snapshot();
                const ids = identify(edited);
                const {result, extensionSave, added: newAssets, removed} = planSave(session, edited);
                await assertFolderUnchanged(session.source);
                active(session);
                const {source} = session;
                const added = new Map<string, Uint8Array>();
                for (const [name, kind] of newAssets) {
                    const data = assetData(name, kind);
                    if (!data) return unsupported(`The data of ${name} is not in the Editor`);
                    const [id, format] = name.split('.');
                    const asset = vm.runtime.storage.createAsset(assetTypeFor(vm.runtime.storage, kind, format), format, data.slice(), null, true);
                    if (asset.assetId !== id) return unsupported(`Asset hash mismatch: ${name}`);
                    added.set(name, data);
                }
                if (!result && !removed.length && !extensionSave.removed.length) {
                    if (revision === saveRevision) host.onSaved();
                    notify();
                    return {status: 'unchanged', sourceRemoved: []};
                }
                const manifest = added.size || removed.length ? saveManifest(source, added.keys(), removed) : null;
                const root = {directory: source.directory, files: source.files, prefix: ''};
                const assets = {directory: await source.directory.getDirectoryHandle('assets', {create: true}), files: source.bytes, prefix: 'assets/'};
                const extensions = {directory: await source.directory.getDirectoryHandle('extensions', {create: true}),
                    files: source.extensionBytes, prefix: 'extensions/'};
                const undo: (() => Promise<void>)[] = [];
                const write = async ({directory, files, prefix}: SaveDirectory, name: string, data: Uint8Array) => {
                    const previous = files.get(name);
                    if (!previous) {
                        const existing = await directory.getFileHandle(name).catch(error => {
                            if (error instanceof DOMException && error.name === 'NotFoundError') return null;
                            throw error;
                        });
                        if (existing) throw new FolderError('conflict');
                    }
                    const handle = await directory.getFileHandle(name, previous ? undefined : {create: true});
                    const key = prefix + name;
                    const previousVersion = source.versions.get(key);
                    let committed = false;
                    undo.push(async () => {
                        let version = previousVersion;
                        try {
                            if (!committed && previous) return;
                            const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
                            if (!sameBytes(bytes, committed ? data : new Uint8Array())) return;
                            if (previous) {
                                const writable = await handle.createWritable();
                                try {
                                    await writable.write(previous as Uint8Array<ArrayBuffer>);
                                    await writable.close();
                                } catch (error) {
                                    await writable.abort().catch(() => {});
                                    throw error;
                                }
                                version = fileVersion(await handle.getFile());
                            } else {
                                await directory.removeEntry(name);
                            }
                        } finally {
                            // If restoration failed, keep the old expectations so the next save reports a conflict.
                            if (previous) files.set(name, previous);
                            else files.delete(name);
                            if (version === undefined) source.versions.delete(key);
                            else source.versions.set(key, version);
                        }
                    });
                    await writeChecked(session, handle, data, previous !== undefined);
                    committed = true;
                    files.set(name, data);
                    source.versions.set(key, fileVersion(await handle.getFile()));
                };
                // Write the files that will be referenced before publishing the new manifests and project.
                try {
                    for (const [name, data] of added) await write(assets, name, data);
                    for (const [name, data] of extensionSave.writes) await write(extensions, name, data);
                    if (manifest) await write(root, manifestFile, manifest);
                    if (extensionSave.manifestChanged) {
                        await write(root, extensionsFile, encodeJson(extensionSave.embedded));
                    }
                    if (result) await write(root, projectFile, encodeJson(extensionSave.project));
                } catch (error) {
                    for (const restore of undo.reverse()) await restore().catch(() => {});
                    throw error;
                }
                source.project = extensionSave.project;
                source.embedded = extensionSave.embedded;
                for (const [{directory, files, prefix}, names] of [[assets, removed], [extensions, extensionSave.removed]] as const) {
                    for (const name of names) {
                        try {
                            const file = await (await directory.getFileHandle(name)).getFile();
                            if (!sameBytes(new Uint8Array(await file.arrayBuffer()), files.get(name)!)) continue;
                            await directory.removeEntry(name);
                        } catch (error) {
                            // The next save retries cleanup.
                            if (!(error instanceof DOMException && error.name === 'NotFoundError')) continue;
                        }
                        files.delete(name);
                        source.versions.delete(prefix + name);
                    }
                }
                session.baseline = edited;
                session.ids = ids;
                session.pending = null;
                if (current === session && revision === saveRevision) host.onSaved();
                notify();
                return {status: 'saved', sourceRemoved: extensionSave.sourceRemoved};
            } finally {
                busy = false;
                notifyEdits();
            }
        },
        dispose
    };
}
