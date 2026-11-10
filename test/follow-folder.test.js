import assert from 'node:assert/strict';
import {test} from 'node:test';
import {followProjectFolder, mountProjectFolder} from '../dist/index.js';

const project = {targets: [{isStage: true, name: 'Stage', blocks: {}}]};
const files = new Map([
    ['project.source.json', project],
    ['embedded-extensions.json', {formatVersion: 1, extensions: []}],
    ['sb3-source.json', {
        formatVersion: 1, project: 'project.source.json', embeddedExtensions: 'embedded-extensions.json',
        assetsDirectory: 'assets', archiveEntries: ['project.json']
    }]
]);
const directory = {
    name: 'Selected project',
    async getFileHandle(name) {return {async getFile() {return new Blob([JSON.stringify(files.get(name))]);}};},
    async getDirectoryHandle() {return {values: () => []};}
};

function fakeEditor() {
    const stage = {};
    const listeners = new Map();
    const vm = {
        runtime: {
            storage: {addHelper() {}},
            getTargetForStage: () => stage,
            on(name, listener) {listeners.set(name, listener);},
            off() {}
        },
        on() {}, off() {}, quit() {},
        async loadProject() {},
        toJSON: () => JSON.stringify(project)
    };
    const document = {
        defaultView: {showDirectoryPicker: async () => directory, clearTimeout, setTimeout},
        createElement: () => ({style: {}, dataset: {}, setAttribute() {}, remove() {}}),
        body: {append() {}}
    };
    const host = {isProjectDirty: () => false, beforeLoad() {}, onOpened() {}, onSaved() {}};
    return {vm, document, host, loadOther: () => listeners.get('PROJECT_LOADED')()};
}

test('follows the folder mounted for a VM as it is mounted, opened, closed and disposed', async () => {
    const {vm, document, host, loadOther} = fakeEditor();
    const seen = [];
    // A view may follow before the folder is mounted.
    const stop = followProjectFolder(vm, (folder, opened) => seen.push(folder ? opened?.name ?? 'none' : 'unmounted'));
    assert.deepEqual(seen, ['unmounted']);
    const folder = mountProjectFolder({vm, document, host});
    assert.deepEqual(seen, ['unmounted', 'none']);
    assert.equal(await folder.openDirectory(directory, () => true), 'opened');
    assert.equal(seen.at(-1), 'Selected project');
    // Loading another project closes the folder.
    loadOther();
    assert.equal(seen.at(-1), 'none');
    folder.dispose();
    assert.equal(seen.at(-1), 'unmounted');
    const count = seen.length;
    stop();
    mountProjectFolder({vm, document, host}).dispose();
    assert.equal(seen.length, count, 'nothing is told after stopping');
});
