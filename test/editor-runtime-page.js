// Runs in the minimal editor runtime: the real VM and Blockly, with the folder in the browser's private file system.
import {mountProjectFolder} from '../dist/index.js';

const text = value => typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;

globalThis.openFolder = async project => {
    const runtime = await EditorRuntime.start(document.getElementById('workspace'), {locale: 'en'});
    const root = await navigator.storage.getDirectory();
    for await (const name of root.keys()) await root.removeEntry(name, {recursive: true});
    const directory = await root.getDirectoryHandle('Folder', {create: true});
    await directory.getDirectoryHandle('assets', {create: true});
    await directory.getDirectoryHandle('extensions', {create: true});
    const write = async (name, value) => {
        const writable = await (await directory.getFileHandle(name, {create: true})).createWritable();
        await writable.write(text(value));
        await writable.close();
    };
    await write('project.source.json', project);
    await write('embedded-extensions.json', {formatVersion: 1, extensions: []});
    await write('sb3-source.json', {formatVersion: 1, project: 'project.source.json',
        embeddedExtensions: 'embedded-extensions.json', assetsDirectory: 'assets', archiveEntries: ['project.json']});
    let loads = 0;
    runtime.vm.runtime.on('PROJECT_LOADED', () => loads++);
    const folder = mountProjectFolder({vm: runtime.vm, document, locale: 'en', host: {
        blockReload: {
            isRunning: runtime.isRunning,
            subscribe: runtime.subscribe,
            onApplied(targets) {runtime.refreshBlockViews(targets); runtime.markSaved();},
            deserializeBlocks: runtime.deserializeBlocks
        },
        isProjectDirty: runtime.isProjectDirty,
        beforeLoad() {},
        onOpened: runtime.markSaved,
        onSaved: runtime.markSaved
    }});
    globalThis.folder = {runtime, write, loads: () => loads,
        workspaceBlocks: () => runtime.workspace.getAllBlocks().map(block => block.type).sort(),
        vmBlocks: () => Object.values(runtime.vm.editingTarget.blocks._blocks).map(block => block.opcode).sort(),
        notice: () => document.querySelector('[data-project-folder-external]')};
    return folder.openDirectory(directory, () => true);
};
