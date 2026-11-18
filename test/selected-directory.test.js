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

function mountFolder(t, picker = () => assert.fail('Unexpected picker call')) {
    const stage = {};
    const loaded = [];
    const opened = [];
    const vm = {
        runtime: {storage: {addHelper() {}}, getTargetForStage: () => stage, on() {}, off() {}},
        on() {}, off() {}, quit() {},
        async loadProject(text) {loaded.push(JSON.parse(text));},
        toJSON: () => JSON.stringify(project)
    };
    const document = {
        defaultView: {showDirectoryPicker: picker, clearTimeout, setTimeout},
        createElement: () => ({style: {}, dataset: {}, setAttribute() {}, remove() {}}),
        body: {append() {}}
    };
    const host = {isProjectDirty: () => false, beforeLoad() {}, onOpened: title => opened.push(title), onSaved() {}};
    const session = mountProjectFolder({vm, document, host});
    t.after(() => session.dispose());
    return {vm, session, loaded, opened};
}

test('opens the project/ folder of a chosen repository and reports the repository as root', async t => {
    const {session, loaded, opened} = mountFolder(t);
    const repository = folder('my-repo', new Map([['.git', new Map()], ['README.md', 'hi'], ['project', files]]));
    assert.equal(await session.openDirectory(repository, () => true), 'opened');
    assert.deepEqual(loaded, [project]);
    assert.deepEqual(opened, ['my-repo'], 'the title is the folder the user chose');
    assert.equal(session.directory.name, 'project');
    assert.equal(session.root, repository);
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

test('keeps the root error when project/ is no project, is itself a repository, or the root is a broken project', async t => {
    const {session, loaded} = mountFolder(t);
    const rejects = async (directory, label) => {
        await assert.rejects(session.openDirectory(directory, () => true), error => {
            assert.match(error.message, new RegExp(`^${directory.name}: missing$`), label);
            return true;
        });
    };
    await rejects(folder('empty', new Map()), 'no project anywhere');
    await rejects(folder('nested', new Map([['project', new Map([...files, ['.git', new Map()]])]])), 'project/ has .git');
    await rejects(folder('nested-file', new Map([['project', new Map([...files, ['.git', 'gitdir: ../x']])]])), 'project/ has a .git file');
    await rejects(folder('other', new Map([['project', new Map([['notes.txt', 'x']])]])), 'project/ is not a project');
    // The root has a project of its own, though broken, so project/ is not looked at.
    const broken = new Map([...files, ['project', files]]);
    broken.delete('embedded-extensions.json');
    await assert.rejects(session.openDirectory(folder('broken', broken), () => true), /broken: missing/u);
    assert.deepEqual(loaded, []);
    assert.equal(session.directory, null);
    assert.equal(session.root, null);
});

test('the folder picked on the device is the root when its project is in project/', async t => {
    const repository = folder('picked-repo', new Map([['project', files]]));
    const {vm, session} = mountFolder(t, async () => repository);
    const {promise, resolve} = Promise.withResolvers();
    const stop = followProjectFolder(vm, (_folder, directory, root) => {if (directory) resolve({directory, root});});
    t.after(stop);
    projectFolderActions(vm).open();
    const {directory, root} = await promise;
    assert.equal(directory.name, 'project');
    assert.equal(root, repository);
    assert.equal(session.root, repository);
});
