import assert from 'node:assert/strict';
import {test} from 'node:test';
import {followProjectFolder, mountProjectFolder} from '../dist/index.js';

const bytes = value => new TextEncoder().encode(JSON.stringify(value));
const notFound = () => new DOMException('Missing entry', 'NotFoundError');
const project = {targets: [{isStage: true, name: 'Stage', costumes: [], sounds: []}]};
const seed = new Map([
    ['project.source.json', bytes(project)],
    ['sb3-source.json', bytes({formatVersion: 1, project: 'project.source.json',
        embeddedExtensions: 'embedded-extensions.json', assetsDirectory: 'assets', archiveEntries: ['project.json']})],
    ['embedded-extensions.json', bytes({formatVersion: 1, extensions: []})]
]);
const prepareFiles = async () => seed;

// A directory in memory, with `resolve` and recursive removal as the origin private file system has them.
function memoryDirectory(name) {
    const children = new Map();
    const handle = (child, kind, options, make) => {
        if (!children.has(child)) {
            if (!options?.create) throw notFound();
            children.set(child, make());
        }
        const entry = children.get(child);
        if (entry.kind !== kind) throw new DOMException('Wrong kind', 'TypeMismatchError');
        return entry;
    };
    return {
        children, name, kind: 'directory', values: () => children.values(), async isSameEntry(other) {return this === other;},
        async getDirectoryHandle(child, options) {return handle(child, 'directory', options, () => memoryDirectory(child));},
        async getFileHandle(child, options) {
            return handle(child, 'file', options, () => {
                let data = new Uint8Array();
                let modified = 0;
                return {
                    name: child, kind: 'file', async isSameEntry(other) {return this === other;},
                    async getFile() {return new File([data], child, {lastModified: modified});},
                    async createWritable() {
                        let next;
                        return {async write(value) {next = value;}, async abort() {}, async close() {data = next; modified++;}};
                    }
                };
            });
        },
        async removeEntry(child, options) {
            if (!children.has(child)) throw notFound();
            if (children.get(child).children?.size && !options?.recursive) throw new DOMException('Not empty', 'InvalidModificationError');
            children.delete(child);
        },
        async resolve(target) {
            for (const [key, entry] of children) {
                if (entry === target) return [key];
                const path = entry.kind === 'directory' ? await entry.resolve(target) : null;
                if (path) return [key, ...path];
            }
            return null;
        }
    };
}

const texts = node => [node.textContent, ...node.children.flatMap(texts)].filter(Boolean);
const okButton = dialog => dialog.children.flatMap(function find(node) {
    return node.tagName === 'BUTTON' ? [node] : node.children.flatMap(find);
})[0];

function fakeEditor({picker, browser = false, browserStorage} = {}) {
    const stage = {};
    const opfs = memoryDirectory('');
    const confirms = [];
    const elements = [];
    const dialogs = [];
    let answer = true;
    let state = project;
    const vm = {
        runtime: {storage: {addHelper() {}}, getTargetForStage: () => stage, on() {}, off() {}},
        on() {}, off() {}, quit() {}, toJSON: () => JSON.stringify(state),
        async loadProject(text) {state = JSON.parse(text);}
    };
    const view = {
        clearTimeout() {}, setTimeout() {}, crypto: globalThis.crypto,
        confirm(message) {confirms.push(message); return answer;},
        ...(picker ? {showDirectoryPicker: picker} : {}),
        ...(browser ? {navigator: {storage: {getDirectory: async () => opfs}}} : {})
    };
    // Just enough of the DOM for the status line and the modal dialog.
    const document = {
        defaultView: view, body: {append() {}}, activeElement: null,
        createElement(tag) {
            const node = {
                tagName: tag.toUpperCase(), style: {}, dataset: {}, children: [], listeners: {}, isConnected: true, hidden: true,
                textContent: '', open: false,
                setAttribute() {},
                append(...children) {node.children.push(...children);},
                remove() {node.isConnected = false;},
                addEventListener(type, listener) {(node.listeners[type] ??= []).push(listener);},
                focus() {document.activeElement = node;},
                showModal() {node.open = true; dialogs.push(node);},
                close() {node.open = false; for (const listener of node.listeners.close ?? []) listener();},
                click() {for (const listener of node.listeners.click ?? []) listener();}
            };
            elements.push(node);
            return node;
        }
    };
    const host = {isProjectDirty: () => false, beforeLoad() {}, onOpened() {}, onSaved() {}};
    const folder = mountProjectFolder({vm, document, host, browserStorage});
    const stored = async () => {
        const root = await opfs.getDirectoryHandle('turbowarp-plus', {create: true});
        return (await root.getDirectoryHandle('projects', {create: true})).children;
    };
    return {
        vm, folder, confirms, stored, dialogs, list: () => folder.browserProjects.list(),
        status: () => elements.find(element => element.dataset.projectFolderStatus === ''),
        answer(value) {answer = value;}
    };
}

test('a new project made in the browser opens its new folder, which takes the title and can be renamed', async t => {
    const {folder, list} = fakeEditor({browser: true});
    t.after(() => folder.dispose());
    assert.deepEqual(folder.locations, ['browser']);
    assert.equal(folder.location, null);
    assert.equal(await folder.renameCurrentBrowserFolder('Nothing open'), false);
    assert.equal(await folder.createFromSnapshot({destination: 'browser', title: 'My Game', prepareFiles}), 'opened');
    const [entry] = await list();
    assert.equal(entry.title, 'My Game');
    assert.equal(folder.root, await folder.browserProjects.root(entry.id));
    assert.equal(folder.location, 'browser');
    assert.equal(await folder.renameCurrentBrowserFolder('Renamed Game'), true);
    assert.deepEqual((await list()).map(item => item.title), ['Renamed Game']);
});

test('a new folder in the browser is removed again when nothing opens from it', async t => {
    const {folder, stored, list} = fakeEditor({browser: true});
    t.after(() => folder.dispose());
    assert.equal(await folder.createFromSnapshot({destination: 'browser', title: 'Cancelled', prepareFiles,
        current: () => false}), 'cancelled');
    await assert.rejects(folder.createFromSnapshot({destination: 'browser', title: 'Failed',
        prepareFiles: async () => {throw new Error('serialize failed');}}), /serialize failed/);
    assert.deepEqual(await list(), []);
    assert.equal((await stored()).size, 0);
    assert.equal(folder.directory, null);
});

test('a new project in a folder the host picked opens there, on the device, without asking again', async t => {
    const {folder} = fakeEditor({picker: () => assert.fail('The host already picked the folder'), browser: true,
        browserStorage: 'always'});
    t.after(() => folder.dispose());
    assert.deepEqual(folder.locations, ['device', 'browser']);
    const picked = memoryDirectory('picked');
    assert.equal(await folder.createFromSnapshot({destination: picked, title: 'Ignored', prepareFiles}), 'opened');
    assert.equal(folder.directory, picked);
    assert.ok(picked.children.has('project.source.json'));
    assert.equal(folder.location, 'device');
    assert.equal(await folder.renameCurrentBrowserFolder('Not in the browser'), false);
});

test('the browser destination fails without the browser\'s folders, before the project is prepared', async t => {
    const {folder} = fakeEditor({picker: () => assert.fail('Unexpected picker call')});
    t.after(() => folder.dispose());
    const unexpected = () => assert.fail('An unavailable destination must not serialize the project');
    await assert.rejects(folder.createFromSnapshot({destination: 'browser', prepareFiles: unexpected}), {code: 'unsupported'});
    await assert.rejects(folder.copyToFolder({destination: 'browser', prepareFiles: unexpected}), {code: 'unsupported'});
});

test('a copy is written without opening it, and the open folder stays', async t => {
    const {vm, folder, list, stored} = fakeEditor({browser: true});
    t.after(() => folder.dispose());
    assert.equal(await folder.createFromSnapshot({destination: 'browser', title: 'Original', prepareFiles}), 'opened');
    const {directory, root} = folder;
    const seen = [];
    const stop = followProjectFolder(vm, (_, opened) => seen.push(opened));
    t.after(stop);
    let collected = 0;
    const copy = await folder.copyToFolder({destination: 'browser', title: 'Copy', prepareFiles,
        collectEdits: async () => {collected++;}});
    assert.ok(copy.children.has('project.source.json'));
    assert.equal(collected, 1);
    assert.equal(folder.directory, directory);
    assert.equal(folder.root, root);
    assert.equal(folder.location, 'browser');
    assert.deepEqual(seen, [directory], 'only the call made when following started');
    assert.deepEqual((await list()).map(item => item.title).sort(), ['Copy', 'Original']);

    // A copy that is not written leaves no folder behind.
    assert.equal(await folder.copyToFolder({destination: 'browser', title: 'Stale', prepareFiles, current: () => false}), null);
    await assert.rejects(folder.copyToFolder({destination: 'browser', title: 'Broken',
        prepareFiles: async () => {throw new Error('serialize failed');}}), /serialize failed/);
    assert.equal((await stored()).size, 2);
});

test('a copy to a folder on the device that is not empty is written only when the user confirms it', async t => {
    const {folder, confirms, answer} = fakeEditor({picker: () => assert.fail('Unexpected picker call')});
    t.after(() => folder.dispose());
    const empty = memoryDirectory('empty');
    assert.equal(await folder.copyToFolder({destination: empty, prepareFiles}), empty);
    assert.deepEqual(confirms, []);
    assert.equal(folder.directory, null);

    const used = memoryDirectory('used');
    await used.getFileHandle('keep.txt', {create: true});
    answer(false);
    assert.equal(await folder.copyToFolder({destination: used, prepareFiles: () => assert.fail('Declined')}), null);
    assert.deepEqual([...used.children.keys()], ['keep.txt']);
    answer(true);
    assert.equal(await folder.copyToFolder({destination: used, prepareFiles}), used);
    assert.ok(used.children.has('project.source.json'));
    assert.ok(used.children.has('keep.txt'));
    assert.equal(confirms.length, 2);
    assert.match(confirms[0], /not empty/);
});

test('pickEmptyFolder returns an empty folder, and tells the user when the folder is not empty', async t => {
    const picked = [];
    const results = [];
    const editor = fakeEditor({picker: async options => {
        picked.push(options);
        const next = results.shift();
        if (next instanceof Error) throw next;
        return next;
    }});
    t.after(() => editor.folder.dispose());
    const empty = memoryDirectory('empty');
    results.push(empty);
    assert.equal(await editor.folder.pickEmptyFolder(), empty);
    assert.deepEqual(picked, [{id: 'turbowarp-plus-project-folder', mode: 'readwrite'}]);

    results.push(new DOMException('The user closed the dialog', 'AbortError'));
    assert.equal(await editor.folder.pickEmptyFolder({id: 'new-project'}), null);
    assert.equal(picked[1].id, 'new-project');
    assert.deepEqual(editor.dialogs, [], 'cancelling says nothing');

    // A folder that is not empty is refused in a modal dialog; the call resolves once the dialog closes.
    const used = memoryDirectory('used');
    await used.getFileHandle('notes.txt', {create: true});
    for (const [locale, title, message] of [['ja', 'このフォルダは使えません', '空のフォルダを選んでください。'],
        ['en', 'Cannot Use This Folder', 'Choose an empty folder.']]) {
        results.push(used);
        let settled = false;
        const picking = editor.folder.pickEmptyFolder({locale}).finally(() => {settled = true;});
        while (editor.dialogs.length < (locale === 'ja' ? 1 : 2)) await new Promise(resolve => setImmediate(resolve));
        const dialog = editor.dialogs.at(-1);
        assert.equal(dialog.dataset.projectFolderError, 'not-empty');
        assert.equal(dialog.open, true);
        assert.ok(texts(dialog).includes(title));
        assert.ok(texts(dialog).includes(message));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(settled, false, 'the dialog is modal: the call waits for it');
        okButton(dialog).click();
        assert.equal(await picking, null);
        assert.equal(dialog.isConnected, false);
    }
    assert.equal(editor.status().hidden, true, 'the status line stays quiet');

    results.push(new Error('denied'));
    await assert.rejects(editor.folder.pickEmptyFolder(), /denied/);

    const browserOnly = fakeEditor({browser: true});
    t.after(() => browserOnly.folder.dispose());
    await assert.rejects(browserOnly.folder.pickEmptyFolder(), {code: 'unsupported'});
});

test('a copy is refused before any question or write when it would go to the open folder or its root', async t => {
    const {folder, confirms} = fakeEditor({picker: () => assert.fail('Unexpected picker call')});
    t.after(() => folder.dispose());
    const opened = memoryDirectory('opened');
    assert.equal(await folder.createFromSnapshot({destination: opened, prepareFiles}), 'opened');
    const before = [...opened.children.keys()];
    const unexpected = () => assert.fail('A refused copy must not prepare the project');
    await assert.rejects(folder.copyToFolder({destination: opened, prepareFiles: unexpected}), {code: 'conflict'});
    // Another handle to the same folder is the same entry.
    const alias = memoryDirectory('alias');
    opened.isSameEntry = async other => other === opened || other === alias;
    await assert.rejects(folder.copyToFolder({destination: alias, prepareFiles: unexpected}), {code: 'conflict'});
    assert.deepEqual(confirms, []);
    assert.deepEqual([...opened.children.keys()], before);
    assert.equal(folder.directory, opened);
});

test('a copy is refused when it would go to the root the host opened the project in', async t => {
    const {folder} = fakeEditor({picker: () => assert.fail('Unexpected picker call')});
    t.after(() => folder.dispose());
    const root = memoryDirectory('repository');
    const project = await root.getDirectoryHandle('project', {create: true});
    for (const [name, data] of seed) {
        const writable = await (await project.getFileHandle(name, {create: true})).createWritable();
        await writable.write(data);
        await writable.close();
    }
    assert.equal(await folder.openDirectory(project, () => true, root), 'opened');
    assert.equal(folder.root, root);
    await assert.rejects(folder.copyToFolder({destination: root, prepareFiles: () => assert.fail('Refused')}), {code: 'conflict'});
    assert.equal(await folder.copyToFolder({destination: memoryDirectory('elsewhere'), prepareFiles}) !== null, true);
});
