// Runs in the minimal editor runtime. Project folders live in the browser's private file system, as in Safari and
// Firefox, which have no folder picker.
import {mountProjectFolder, openBrowserProjects, projectFolderActions} from '../dist/index.js';
import {renderProjectFolderExplorer} from '../dist/explorer.js';
import * as React from 'react';
import * as ReactDOM from 'react-dom';

const encode = value => new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);

globalThis.setup = async ({project, withoutPicker, browserStorage = 'fallback', locale = 'ja'}) => {
    // Chromium has the picker; take it away so the browser's folders stand in for it as they do in Safari.
    if (withoutPicker) Object.defineProperty(window, 'showDirectoryPicker', {value: undefined, configurable: true});
    const root = await navigator.storage.getDirectory();
    for await (const name of root.keys()) await root.removeEntry(name, {recursive: true});
    globalThis.pickerCalls = 0;
    if (!withoutPicker && typeof window.showDirectoryPicker === 'function') {
        window.showDirectoryPicker = async () => {
            globalThis.pickerCalls++;
            if (!globalThis.acceptDevicePicker) throw new DOMException('Cancelled', 'AbortError');
            return root.getDirectoryHandle('device-fixture', {create: true});
        };
    }
    const workspace = document.getElementById('workspace');
    workspace.style.insetInlineStart = '320px';
    const runtime = await EditorRuntime.start(workspace, {locale});
    const folder = mountProjectFolder({vm: runtime.vm, document, locale, browserStorage, host: {
        isProjectDirty: runtime.isProjectDirty,
        beforeLoad() {},
        onOpened: runtime.markSaved,
        onSaved: runtime.markSaved
    }});
    const files = new Map([
        ['project.source.json', encode(project)],
        ['embedded-extensions.json', encode({formatVersion: 1, extensions: []})],
        ['sb3-source.json', encode({formatVersion: 1, project: 'project.source.json',
            embeddedExtensions: 'embedded-extensions.json', assetsDirectory: 'assets', archiveEntries: ['project.json']})]
    ]);
    const projects = openBrowserProjects(window);
    globalThis.subject = {
        runtime, folder, projects,
        actions: () => projectFolderActions(runtime.vm, locale),
        create: (title, location) => subject.created = folder.createFromSnapshot({prepareFiles: async () => files, title, location}),
        // A repository kept in the browser, with the project in project/ as Project Starter makes it.
        async createRepository(title) {
            const created = await projects.create(title, {projectPath: 'project'});
            await created.root.getDirectoryHandle('.git', {create: true});
            for (const [name, bytes] of files) {
                const writable = await (await created.directory.getFileHandle(name, {create: true})).createWritable();
                await writable.write(bytes);
                await writable.close();
            }
            return created.id;
        },
        /** Whether the open folder is the project folder of `id` and its root the stored folder. */
        async openedFrom(id) {
            const [root, directory] = await Promise.all([projects.root(id), projects.directory(id)]);
            if (!folder.directory || !folder.root) return null;
            return {directory: await directory.isSameEntry(folder.directory), root: await root.isSameEntry(folder.root),
                name: folder.directory.name};
        },
        async storedProject(id) {
            const directory = await projects.directory(id);
            return JSON.parse(await (await (await directory.getFileHandle('project.source.json')).getFile()).text());
        }
    };
    const panel = document.createElement('aside');
    panel.dataset.storageChoices = '';
    Object.assign(panel.style, {position: 'absolute', inset: '0 auto 0 0', width: '320px', overflow: 'auto',
        zIndex: '100', background: 'white', color: '#333', font: '14px sans-serif'});
    document.body.append(panel);
    ReactDOM.render(renderProjectFolderExplorer(React.createElement, {vm: runtime.vm, locale,
        createFolder: location => subject.create('ねこの冒険', location)}), panel);
    return Boolean(folder) && Boolean(folder.browserProjects);
};
