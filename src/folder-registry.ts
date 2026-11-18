/** The project folder mounted for a VM, as a view of the folder follows it. */
export type ExplorerMutation = (guard: () => void) => Promise<void>;
export type ProjectFolderLocation = 'device' | 'browser';

export interface FollowedFolder {
    readonly directory: FileSystemDirectoryHandle | null;
    /** The folder the user chose for `directory`: itself, or the repository whose `project` folder it is. */
    readonly root?: FileSystemDirectoryHandle | null;
    /** Storage choices available when creating a project folder. */
    readonly locations?: readonly ProjectFolderLocation[];
    subscribe(listener: () => void): () => void;
    subscribeEdits(listener: () => void): () => void;
    unsavedPaths(): ReadonlySet<string> | null;
    /** Asks for a folder and opens it, as the File menu's Open Folder… does. */
    open(locale: string): void;
    mutate(directory: FileSystemDirectoryHandle, operation: ExplorerMutation): Promise<void>;
}
const folders = new WeakMap<object, FollowedFolder>();
// Views rendered before the folder is mounted, or after it is disposed, wait for the VM's folder here.
const registrations = new Set<() => void>();
const announce = () => {for (const listener of [...registrations]) listener();};

export function registerFolder(vm: object, folder: FollowedFolder) {
    folders.set(vm, folder);
    announce();
    return () => {
        if (folders.get(vm) === folder) folders.delete(vm);
        announce();
    };
}

/**
 * Calls `listener` with the project folder mounted for `vm`, the directory open in it and the folder the user chose for
 * it (`root`, the directory itself or the repository that holds it in `project/`), now and whenever a folder is
 * mounted, opened, closed or saved. `directory` and `root` are `null` while no folder is open. Returns the function
 * that stops it.
 */
export function followProjectFolder(vm: object, listener: (folder: FollowedFolder | undefined,
    directory: FileSystemDirectoryHandle | null, root: FileSystemDirectoryHandle | null) => void) {
    let unsubscribe = () => {};
    let followed: FollowedFolder | undefined;
    const update = () => {
        const folder = folders.get(vm);
        if (folder !== followed) {
            unsubscribe();
            followed = folder;
            unsubscribe = folder ? folder.subscribe(() => listener(folder, folder.directory, folder.root ?? null)) : () => {};
        }
        listener(folder, folder?.directory ?? null, folder?.root ?? null);
    };
    registrations.add(update);
    update();
    return () => {
        registrations.delete(update);
        unsubscribe();
    };
}
