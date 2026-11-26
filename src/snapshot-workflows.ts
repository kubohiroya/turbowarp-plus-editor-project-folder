// SPDX-License-Identifier: MPL-2.0
import {omittedFilesQuestion} from './host-messages.js';
import type {mountProjectFolder} from './index.js';

export interface FolderSnapshotWorkflowOptions {
    folder: NonNullable<ReturnType<typeof mountProjectFolder>>;
    view: Window & {showDirectoryPicker?(options: {id: string; mode: 'readwrite'}): Promise<FileSystemDirectoryHandle>};
    locale: string;
    unpackProject?(data: Uint8Array): {files: ReadonlyMap<string, Uint8Array>; warnings: readonly {path: string}[]};
    flushEdits(): Promise<void>;
}
export function createFolderSnapshotWorkflows(options: FolderSnapshotWorkflowOptions) {
    const {folder, view, locale} = options;
    const unpackProject = typeof options.unpackProject === 'function' ?
        async (serialize: () => Promise<Uint8Array>, current: () => boolean) => {
            const {files, warnings} = options.unpackProject!(await serialize());
            if (!current()) throw new DOMException('Cancelled', 'AbortError');
            if (warnings.length && !view.confirm(omittedFilesQuestion(locale, warnings.map(warning => warning.path)))) {
                throw new DOMException('Cancelled', 'AbortError');
            }
            return files;
        } : undefined;
    const createFolder = unpackProject ?
        async (serialize: () => Promise<Uint8Array>, current: () => boolean, title?: string,
            destination?: 'browser' | FileSystemDirectoryHandle) => {
            try {
                return await folder.createFromSnapshot({current, collectEdits: options.flushEdits, title, destination,
                    prepareFiles: () => unpackProject(serialize, current)}) === 'opened';
            } catch (error) {
                if ((error as DOMException).name === 'AbortError') return false;
                throw error;
            }
        } : undefined;
    const folderLocation = folder.browserProjects && !view.showDirectoryPicker ? 'browser' as const : 'device' as const;
    const locations = {browser: folder.locations.includes('browser'), device: folder.locations.includes('device')};
    const pickEmptyFolder = locations.device ? (language: string) => folder.pickEmptyFolder({locale: language}) : undefined;
    // Save a Copy writes the folder without opening it, so the open project keeps its own file or folder (#679).
    const copyFolder = unpackProject ? async (serialize: () => Promise<Uint8Array>, current: () => boolean, title?: string) => {
        try {
            const destination = folderLocation === 'browser' ? 'browser' as const :
                await view.showDirectoryPicker!({id: 'turbowarp-plus-project-folder', mode: 'readwrite'});
            return Boolean(await folder.copyToFolder({destination, title, current, collectEdits: options.flushEdits,
                prepareFiles: () => unpackProject(serialize, current)}));
        } catch (error) {
            if ((error as DOMException).name === 'AbortError') return false;
            throw error;
        }
    } : undefined;
    return {unpackProject, createFolder, copyFolder, folderLocation, locations, pickEmptyFolder};
}
