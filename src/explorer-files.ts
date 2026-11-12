type DirectoryEntries = FileSystemDirectoryHandle & {values(): AsyncIterable<FileSystemHandle>};

export class ExplorerFileError extends Error {
    constructor(readonly code: 'invalidName' | 'exists' | 'sourceChanged' | 'originalKept' | 'cleanupFailed') {
        super(code);
    }
}

export function parentPath(path: string) {
    return path.slice(0, Math.max(0, path.lastIndexOf('/')));
}

function validateName(name: string) {
    if (!name.trim() || name === '.' || name === '..' || name.toLowerCase() === '.git' || /[\\/\u0000]/u.test(name)) {
        throw new ExplorerFileError('invalidName');
    }
}

export async function resolveExplorerDirectory(root: FileSystemDirectoryHandle, path: string) {
    let directory = root;
    const parts = path ? path.split('/') : [];
    for (const part of parts) {
        validateName(part);
        directory = await directory.getDirectoryHandle(part);
    }
    if ((await root.resolve(directory))?.join('/') !== path) throw new ExplorerFileError('sourceChanged');
    return directory;
}

async function assertUnused(directory: FileSystemDirectoryHandle, name: string) {
    try {
        await directory.getFileHandle(name);
    } catch (error) {
        if (error instanceof DOMException && error.name === 'NotFoundError') return;
        if (!(error instanceof DOMException) || error.name !== 'TypeMismatchError') throw error;
    }
    throw new ExplorerFileError('exists');
}

const sameVersion = (a: File, b: File) => a.size === b.size && a.lastModified === b.lastModified;

async function writeNewFile(directory: FileSystemDirectoryHandle, name: string, file: File, guard: () => void) {
    await assertUnused(directory, name);
    guard();
    const handle = await directory.getFileHandle(name, {create: true});
    const empty = await handle.getFile();
    if (empty.size) throw new ExplorerFileError('exists');
    const options = {mode: 'exclusive'} as FileSystemCreateWritableOptions;
    let stream: FileSystemWritableFileStream | undefined;
    try {
        stream = await handle.createWritable(options);
        await stream.write(file);
        if (!sameVersion(empty, await handle.getFile())) throw new ExplorerFileError('exists');
        guard();
        await stream.close();
    } catch (error) {
        await stream?.abort().catch(() => {});
        try {
            if (sameVersion(empty, await handle.getFile())) await directory.removeEntry(name);
        } catch {
            throw new ExplorerFileError('cleanupFailed');
        }
        throw error;
    }
}

export async function copyExplorerFile(directory: FileSystemDirectoryHandle, file: File, guard: () => void) {
    validateName(file.name);
    await writeNewFile(directory, file.name, file, guard);
}

type CopiedEntry = {verify(): Promise<void>; removeSource(): Promise<void>};

async function copyEntry(sourceParent: FileSystemDirectoryHandle, source: FileSystemHandle, parent: FileSystemDirectoryHandle,
    name: string, guard: () => void): Promise<CopiedEntry> {
    validateName(source.name);
    if (source.kind === 'file') {
        const handle = source as FileSystemFileHandle;
        const file = await handle.getFile();
        await writeNewFile(parent, name, file, guard);
        const verify = async () => {
            if (!sameVersion(file, await handle.getFile())) throw new ExplorerFileError('sourceChanged');
        };
        return {verify, async removeSource() {
            await verify();
            guard();
            await sourceParent.removeEntry(source.name);
        }};
    }
    await assertUnused(parent, name);
    guard();
    const destination = await parent.getDirectoryHandle(name, {create: true});
    const directory = source as DirectoryEntries;
    const children = new Map<string, {handle: FileSystemHandle; copy: CopiedEntry}>();
    try {
        for await (const handle of directory.values()) {
            children.set(handle.name, {handle, copy: await copyEntry(directory, handle, destination, handle.name, guard)});
        }
    } catch (error) {
        await removeIncompleteCopy(parent, name);
        throw error;
    }
    const verify = async () => {
        let count = 0;
        for await (const handle of directory.values()) {
            const child = children.get(handle.name);
            if (!child || !await handle.isSameEntry(child.handle)) throw new ExplorerFileError('sourceChanged');
            await child.copy.verify();
            count++;
        }
        if (count !== children.size) throw new ExplorerFileError('sourceChanged');
    };
    return {verify, async removeSource() {
        // Directory iteration may omit inaccessible entries. Only remove entries that were copied.
        for (const {copy} of children.values()) await copy.removeSource();
        guard();
        await sourceParent.removeEntry(source.name);
    }};
}

async function removeIncompleteCopy(parent: FileSystemDirectoryHandle, name: string) {
    try {
        await parent.removeEntry(name, {recursive: true});
    } catch {
        throw new ExplorerFileError('cleanupFailed');
    }
}

export async function renameExplorerEntry(parent: FileSystemDirectoryHandle, entry: {name: string; kind: FileSystemHandleKind},
    name: string, guard: () => void) {
    if (name === entry.name) return;
    validateName(name);
    const source = entry.kind === 'file' ? await parent.getFileHandle(entry.name) : await parent.getDirectoryHandle(entry.name);
    const copy = await copyEntry(parent, source, parent, name, guard);
    try {
        await copy.verify();
        guard();
    } catch (error) {
        await removeIncompleteCopy(parent, name);
        throw error;
    }
    try {
        await copy.removeSource();
    } catch {
        // Recursive removal can fail part way. The complete copy is the recovery copy.
        throw new ExplorerFileError('originalKept');
    }
}

export async function deleteExplorerEntry(parent: FileSystemDirectoryHandle, entry: {name: string; kind: FileSystemHandleKind},
    guard: () => void) {
    validateName(entry.name);
    if (entry.kind === 'directory') {
        const check = async (directory: DirectoryEntries): Promise<void> => {
            for await (const child of directory.values()) {
                guard();
                validateName(child.name);
                if (child.kind === 'directory') await check(child as DirectoryEntries);
            }
        };
        await check(await parent.getDirectoryHandle(entry.name) as DirectoryEntries);
    } else {
        await parent.getFileHandle(entry.name);
    }
    guard();
    await parent.removeEntry(entry.name, {recursive: entry.kind === 'directory'});
}
