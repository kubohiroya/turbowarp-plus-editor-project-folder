import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mountProjectFolder} from '../dist/index.js';

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
