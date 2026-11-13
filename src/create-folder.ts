import {extensionsFile, fileVersion, FolderError, manifestFile, projectFile, readFolder, sameBytes, unsupported} from './source.js';
import type {Storage} from './source.js';

const manifests = new Set<string>([projectFile, manifestFile, extensionsFile]);
const sourceDirectories = ['assets', 'extensions'];
const sourcePath = /^(?:assets\/[a-f0-9]{32}\.[A-Za-z0-9]+|extensions\/[A-Za-z0-9._-]+\.(?:js|manifest\.json))$/u;

type IterableDirectory = FileSystemDirectoryHandle & {values(): AsyncIterable<FileSystemHandle>};

function missing(error: unknown) {
    return error instanceof DOMException && error.name === 'NotFoundError';
}

export async function isProjectFolderEmpty(directory: FileSystemDirectoryHandle) {
    for await (const _entry of (directory as IterableDirectory).values()) return false;
    return true;
}

export function projectFolderOverwriteWarning(locale = 'en') {
    return locale.startsWith('ja') ? '指定されたフォルダに保存されている内容は上書きされます' :
        'Contents in the selected folder will be overwritten.';
}

async function directoryEntries(directory: FileSystemDirectoryHandle) {
    const entries = new Map<string, FileSystemHandle>();
    for await (const entry of (directory as IterableDirectory).values()) entries.set(entry.name, entry);
    return entries;
}

/** Create and validate a project-folder snapshot in a directory chosen by the user. */
export async function createProjectFolder({directory, files, storage, overwrite = false, current = () => true}: {
    directory: FileSystemDirectoryHandle;
    files: ReadonlyMap<string, Uint8Array>;
    storage: Storage;
    overwrite?: boolean;
    current?: () => boolean;
}) {
    for (const filename of manifests) {
        if (!files.has(filename)) return unsupported(`Missing ${filename}`);
    }
    for (const [filename, bytes] of files) {
        if ((!manifests.has(filename) && !sourcePath.test(filename)) || !(bytes instanceof Uint8Array)) {
            return unsupported(`Invalid project folder entry: ${filename}`);
        }
    }
    const assertCurrent = () => {
        if (!current()) throw new FolderError('conflict', 'The project changed before the folder was saved');
    };
    const existing = await directoryEntries(directory);
    if (existing.size && !overwrite) throw new FolderError('conflict', 'The destination folder is no longer empty');
    const directories = new Map<string, {handle: FileSystemDirectoryHandle; entries: Map<string, FileSystemHandle>}>();
    const undo: (() => Promise<void>)[] = [];
    const getFile = (parent: FileSystemDirectoryHandle, name: string) => parent.getFileHandle(name).catch(error => {
        if (missing(error)) return null;
        throw error;
    });
    const getDirectory = (parent: FileSystemDirectoryHandle, name: string) => parent.getDirectoryHandle(name).catch(error => {
        if (missing(error)) return null;
        throw error;
    });
    const write = async (file: FileSystemFileHandle, data: Uint8Array, guard: () => void | Promise<void>) => {
        const writable = await file.createWritable({mode: 'exclusive'} as FileSystemCreateWritableOptions);
        try {
            await writable.write(data as Uint8Array<ArrayBuffer>);
            await guard();
            await writable.close();
        } catch (error) {
            await writable.abort().catch(() => {});
            throw error;
        }
    };
    const remove = async (parent: FileSystemDirectoryHandle, entry: FileSystemHandle,
        restoreParent = async () => parent): Promise<void> => {
        const {name} = entry;
        if (entry.kind === 'directory') {
            const child = await getDirectory(parent, name);
            if (!child || !await child.isSameEntry(entry)) throw new FolderError('conflict');
            const restoreChild = async () => (await restoreParent()).getDirectoryHandle(name);
            for (const nested of (await directoryEntries(child)).values()) await remove(child, nested, restoreChild);
            assertCurrent();
            await parent.removeEntry(name);
            undo.push(async () => {await (await restoreParent()).getDirectoryHandle(name, {create: true});});
        } else {
            const file = await getFile(parent, name);
            if (!file || !await file.isSameEntry(entry)) throw new FolderError('conflict');
            const initial = await file.getFile();
            const bytes = new Uint8Array(await initial.arrayBuffer());
            if (fileVersion(await file.getFile()) !== fileVersion(initial)) throw new FolderError('conflict');
            assertCurrent();
            await parent.removeEntry(name);
            undo.push(async () => {
                const destination = await restoreParent();
                if (await getFile(destination, name)) return;
                const restored = await destination.getFileHandle(name, {create: true});
                await write(restored, bytes, async () => {
                    if ((await restored.getFile()).size) throw new FolderError('conflict');
                });
            });
        }
    };
    try {
        // The source format owns these directories and requires exactly the files in the snapshot.
        for (const name of sourceDirectories) {
            const entry = existing.get(name);
            const needed = [...files.keys()].some(path => path.startsWith(`${name}/`));
            if (entry?.kind === 'file') await remove(directory, entry);
            const previous = await getDirectory(directory, name);
            if (previous && (!entry || entry.kind !== 'directory' || !await previous.isSameEntry(entry))) {
                throw new FolderError('conflict');
            }
            if (!needed && !previous) continue;
            assertCurrent();
            const handle = previous ?? await directory.getDirectoryHandle(name, {create: true});
            if (!previous) undo.push(async () => {
                const found = await getDirectory(directory, name);
                if (found && await found.isSameEntry(handle)) await directory.removeEntry(name);
            });
            const children = await directoryEntries(handle);
            for (const child of children.values()) {
                if (child.kind === 'file' && files.has(`${name}/${child.name}`) && previous) continue;
                if (!previous) throw new FolderError('conflict');
                await remove(handle, child);
                children.delete(child.name);
            }
            directories.set(name, {handle, entries: children});
        }
        // Publish the project JSON last, after the files it refers to.
        const entries = [...files].sort(([a], [b]) => Number(manifests.has(a)) - Number(manifests.has(b)) ||
            Number(a === projectFile) - Number(b === projectFile));
        for (const [filename, bytes] of entries) {
            assertCurrent();
            const [first, basename] = filename.split('/');
            const subdirectory = basename === undefined ? undefined : directories.get(first)!;
            const parent = subdirectory?.handle ?? directory;
            const name = basename ?? first;
            const entry = (subdirectory?.entries ?? existing).get(name);
            if (entry?.kind === 'directory') await remove(parent, entry);
            const previous = await getFile(parent, name);
            if (entry?.kind === 'file' ? !previous || !await previous.isSameEntry(entry) : previous) {
                throw new FolderError('conflict');
            }
            const file = previous ?? await parent.getFileHandle(name, {create: true});
            const initial = await file.getFile();
            if (!previous && initial.size !== 0) throw new FolderError('conflict');
            const backup = previous ? new Uint8Array(await initial.arrayBuffer()) : null;
            let committed = false;
            undo.push(async () => {
                if (backup && !committed) return;
                const found = await getFile(parent, name);
                if (!found || !await found.isSameEntry(file)) return;
                const latest = await found.getFile();
                if (!sameBytes(new Uint8Array(await latest.arrayBuffer()), committed ? bytes : new Uint8Array())) return;
                if (backup) await write(found, backup, async () => {
                    if (fileVersion(await found.getFile()) !== fileVersion(latest)) throw new FolderError('conflict');
                });
                else await parent.removeEntry(name);
            });
            await write(file, bytes, async () => {
                if (fileVersion(await file.getFile()) !== fileVersion(initial)) throw new FolderError('conflict');
                assertCurrent();
            });
            committed = true;
        }
        const source = await readFolder(directory, storage);
        assertCurrent();
        return source;
    } catch (error) {
        for (const revert of undo.reverse()) await revert().catch(() => {});
        throw error;
    }
}
