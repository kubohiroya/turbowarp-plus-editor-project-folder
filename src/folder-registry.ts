/** The project folder mounted for a VM, as a view of the folder follows it. */
export interface FollowedFolder {
    readonly directory: FileSystemDirectoryHandle | null;
    subscribe(listener: () => void): () => void;
    /** Asks for a folder and opens it, as the File menu's Open Project Folder… does. */
    open(locale: string): void;
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
 * Calls `listener` with the project folder mounted for `vm` and the directory open in it, now and whenever a folder is
 * mounted, opened, closed or saved. Returns the function that stops it.
 */
export function followProjectFolder(vm: object,
    listener: (folder: FollowedFolder | undefined, directory: FileSystemDirectoryHandle | null) => void) {
    let unsubscribe = () => {};
    let followed: FollowedFolder | undefined;
    const update = () => {
        const folder = folders.get(vm);
        if (folder !== followed) {
            unsubscribe();
            followed = folder;
            unsubscribe = folder ? folder.subscribe(() => listener(folder, folder.directory)) : () => {};
        }
        listener(folder, folder?.directory ?? null);
    };
    registrations.add(update);
    update();
    return () => {
        registrations.delete(update);
        unsubscribe();
    };
}
