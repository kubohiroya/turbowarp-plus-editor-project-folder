import assert from 'node:assert/strict';
import {test} from 'node:test';
import {followProjectFolder, mountProjectFolder, projectFolderActions} from '../dist/index.js';

const project = {targets: [{isStage: true, name: 'Stage', blocks: {}}]};
const files = new Map([
    ['project.source.json', project],
    ['embedded-extensions.json', {formatVersion: 1, extensions: []}],
    ['sb3-source.json', {
        formatVersion: 1,
        project: 'project.source.json',
        embeddedExtensions: 'embedded-extensions.json',
        assetsDirectory: 'assets',
        archiveEntries: ['project.json']
    }]
]);
const directory = {
    name: 'Selected project',
    async getFileHandle(name) {
        assert.ok(files.has(name), name);
        return {async getFile() {return new Blob([JSON.stringify(files.get(name))]);}};
    },
    async getDirectoryHandle(name) {
        assert.ok(name === 'assets' || name === 'extensions', name);
        return {values: () => []};
    }
};

test('opens an already selected project with the host confirmation and without calling the picker', async t => {
    const stage = {};
    const loaded = [];
    const opened = [];
    const vm = {
        runtime: {
            storage: {addHelper() {}},
            getTargetForStage: () => stage,
            on() {},
            off() {}
        },
        on() {},
        off() {},
        quit() {},
        async loadProject(text) {loaded.push(JSON.parse(text));},
        toJSON: () => JSON.stringify(project)
    };
    const document = {
        defaultView: {showDirectoryPicker: () => assert.fail('Unexpected picker call'), clearTimeout},
        createElement: () => ({style: {}, dataset: {}, setAttribute() {}, remove() {}}),
        body: {append() {}}
    };
    const host = {
        isProjectDirty: () => true,
        beforeLoad() {},
        onOpened: title => opened.push(title),
        onSaved() {}
    };
    const session = mountProjectFolder({vm, document, host});
    assert.ok(session);
    t.after(() => session.dispose());

    assert.equal(await session.openDirectory(directory, () => false), 'cancelled');
    assert.deepEqual(loaded, []);
    assert.equal(session.directory, null);
    assert.equal(await session.openDirectory(directory, () => true), 'opened');
    assert.deepEqual(loaded, [project]);
    assert.deepEqual(opened, ['Selected project']);
    assert.equal(session.directory, directory, 'the host can tell which folder the loaded project came from');
});

// A folder of `entries`: a Map value is a folder, anything else a file with that JSON. Missing names fail as a browser does.
function folder(name, entries) {
    const missing = () => new DOMException(`${name}: missing`, 'NotFoundError');
    const mismatch = () => new DOMException(`${name}: wrong kind`, 'TypeMismatchError');
    return {
        name, kind: 'directory',
        async getFileHandle(entry) {
            if (!entries.has(entry)) throw missing();
            const value = entries.get(entry);
            if (value instanceof Map) throw mismatch();
            return {async getFile() {return new Blob([JSON.stringify(value)]);}};
        },
        async getDirectoryHandle(entry) {
            if (entry === 'assets' || entry === 'extensions') {
                if (!entries.has(entry)) return {values: () => []};
            }
            if (!entries.has(entry)) throw missing();
            const value = entries.get(entry);
            if (!(value instanceof Map)) throw mismatch();
            return folder(entry, value);
        }
    };
}

// Just enough of the DOM for the status line and the error dialog. `dialogs` collects every dialog shown.
function fakeDocument(view) {
    const dialogs = [];
    const element = tag => {
        const node = {
            tagName: tag.toUpperCase(), style: {}, dataset: {}, attributes: {}, children: [], listeners: {}, isConnected: true,
            textContent: '', open: false, focused: 0,
            setAttribute(name, value) {node.attributes[name] = value;},
            append(...children) {node.children.push(...children);},
            remove() {node.isConnected = false;},
            addEventListener(type, listener) {(node.listeners[type] ??= []).push(listener);},
            focus() {node.focused++; document.activeElement = node;},
            showModal() {node.open = true; dialogs.push(node);},
            close() {node.open = false; for (const listener of node.listeners.close ?? []) listener();},
            click() {for (const listener of node.listeners.click ?? []) listener();}
        };
        return node;
    };
    const document = {defaultView: view, createElement: element, body: element('body'), activeElement: null, dialogs};
    document.activeElement = element('button');
    return document;
}
const texts = node => [node.textContent, ...node.children.flatMap(texts)].filter(Boolean);
const okButton = dialog => dialog.children.flatMap(function find(node) {
    return node.tagName === 'BUTTON' ? [node] : node.children.flatMap(find);
})[0];

function mountFolder(t, {picker = () => assert.fail('Unexpected picker call'), locale, dirty = false} = {}) {
    const stage = {};
    const loaded = [];
    const opened = [];
    const confirmations = [];
    const vm = {
        runtime: {storage: {addHelper() {}}, getTargetForStage: () => stage, on() {}, off() {}},
        on() {}, off() {}, quit() {},
        async loadProject(text) {loaded.push(JSON.parse(text));},
        toJSON: () => JSON.stringify(project)
    };
    const document = fakeDocument({showDirectoryPicker: picker, clearTimeout, setTimeout,
        confirm: text => {confirmations.push(text); return true;}});
    const host = {isProjectDirty: () => dirty, beforeLoad() {}, onOpened: title => opened.push(title), onSaved() {}};
    const session = mountProjectFolder({vm, document, host, locale});
    t.after(() => session.dispose());
    return {vm, session, loaded, opened, document, confirmations};
}

test('a repository with its project in project/ is not a project folder: nothing opens and nothing changes', async t => {
    const {vm, session, loaded, document} = mountFolder(t);
    const plain = folder('plain', files);
    assert.equal(await session.openDirectory(plain, () => true), 'opened');
    const notified = [];
    const stop = followProjectFolder(vm, (_folder, directory, root) => notified.push([directory, root]));
    t.after(stop);
    notified.length = 0;
    const repository = folder('my-repo', new Map([['.git', new Map()], ['README.md', 'hi'], ['project', files]]));
    let asked = false;
    assert.equal(await session.openDirectory(repository, () => {asked = true; return true;}, undefined, {notProjectDialog: false}),
        'not-project');
    assert.equal(asked, false, 'unsaved edits are not asked about');
    assert.deepEqual(loaded, [project], 'only the first project was loaded');
    assert.equal(session.directory, plain);
    assert.equal(session.root, plain);
    assert.deepEqual(notified, [], 'followers are not told');
    assert.deepEqual(document.dialogs, [], 'the host opted out of the dialog');
});

test('a folder needs every project file at its root to be a project folder', async t => {
    const {session, loaded} = mountFolder(t);
    const without = name => {
        const entries = new Map(files);
        entries.delete(name);
        return folder(`without ${name}`, entries);
    };
    for (const directory of [folder('empty', new Map()), without('project.source.json'), without('sb3-source.json'),
        without('embedded-extensions.json'), folder('as folders', new Map([...files, ['project.source.json', new Map()]]))]) {
        assert.equal(await session.openDirectory(directory, () => true, undefined, {notProjectDialog: false}), 'not-project',
            directory.name);
    }
    assert.deepEqual(loaded, []);
    assert.equal(session.directory, null);
    assert.equal(session.root, null);
});

test('a broken project folder keeps the error it had', async t => {
    const {session, loaded, document} = mountFolder(t);
    const broken = new Map([...files, ['sb3-source.json', {...files.get('sb3-source.json'), formatVersion: 99}]]);
    await assert.rejects(session.openDirectory(folder('broken', broken), () => true), error => {
        assert.equal(error.code, 'unsupported');
        assert.match(error.message, /sb3-toolchain v1 or v2/u);
        return true;
    });
    const invalid = new Map([...files, ['project.source.json', {targets: 'none'}]]);
    await assert.rejects(session.openDirectory(folder('invalid', invalid), () => true), /Missing targets/u);
    assert.deepEqual(loaded, []);
    assert.equal(session.directory, null);
    assert.deepEqual(document.dialogs, [], 'the not-project dialog is only for folders without a project');
});

test('a project at the root is its own root, and a host may give the root it located the project in', async t => {
    const {session} = mountFolder(t);
    const plain = folder('plain', files);
    assert.equal(await session.openDirectory(plain, () => true), 'opened');
    assert.equal(session.directory, plain);
    assert.equal(session.root, plain);
    const parent = folder('parent', new Map());
    assert.equal(await session.openDirectory(plain, () => true, parent), 'opened');
    assert.equal(session.directory, plain);
    assert.equal(session.root, parent);
});

test('openDirectory shows the error dialog in the mounted locale, or in the one it is given', async t => {
    const {session, document} = mountFolder(t, {locale: 'ja'});
    const other = folder('other', new Map([['notes.txt', 'x']]));
    assert.equal(await session.openDirectory(other, () => true), 'not-project');
    assert.equal(document.dialogs.length, 1);
    const [dialog] = document.dialogs;
    assert.equal(dialog.dataset.projectFolderError, 'not-project');
    assert.equal(dialog.open, true);
    assert.ok(texts(dialog).includes('このフォルダはプロジェクトフォルダではありません。'));
    okButton(dialog).click();
    assert.equal(dialog.open, false);
    assert.equal(dialog.isConnected, false);
    assert.equal(await session.openDirectory(other, () => true, null, {locale: 'en'}), 'not-project');
    assert.ok(texts(document.dialogs[1]).includes('This folder is not a project folder.'));
});

test('Open on the device shows the error dialog for a folder that is not a project folder and keeps the project', async t => {
    const plain = folder('plain', files);
    const repository = folder('picked-repo', new Map([['project', files]]));
    let picked = plain;
    const {vm, session, loaded, document, confirmations} = mountFolder(t, {picker: async () => picked, dirty: true});
    assert.equal(await session.openDirectory(plain, () => true), 'opened');
    const notified = [];
    const stop = followProjectFolder(vm, (_folder, directory) => notified.push(directory));
    t.after(stop);
    notified.length = 0;
    picked = repository;
    const before = document.activeElement;
    projectFolderActions(vm, 'ja').open();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(document.dialogs.length, 1);
    const [dialog] = document.dialogs;
    assert.ok(texts(dialog).includes('このフォルダはプロジェクトフォルダではありません。'));
    assert.equal(document.activeElement, okButton(dialog), 'the OK button takes the focus');
    okButton(dialog).click();
    assert.equal(document.activeElement, before, 'the focus goes back');
    assert.deepEqual(confirmations, [], 'unsaved edits are not asked about');
    assert.deepEqual(loaded, [project]);
    assert.equal(session.directory, plain);
    assert.equal(session.root, plain);
    assert.deepEqual(notified, []);
});
