import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mountProjectFolder, projectFolderActions} from '../dist/index.js';

const vm = () => ({
    runtime: {storage: {addHelper() {}}, getTargetForStage: () => ({}), on() {}, off() {}},
    on() {}, off() {}, quit() {}, async loadProject() {}, toJSON: () => '{}'
});
const host = {isProjectDirty: () => false, beforeLoad() {}, onOpened() {}, onSaved() {}};
const document = view => ({defaultView: {clearTimeout, crypto: globalThis.crypto, ...view},
    createElement: () => ({style: {}, dataset: {}, setAttribute() {}, remove() {}}), body: {append() {}}});
const picker = () => assert.fail('Unexpected picker call');
const storage = {navigator: {storage: {getDirectory: () => assert.fail('Unexpected storage access')}}};

function mount(t, view, browserStorage) {
    const machine = vm();
    const folder = mountProjectFolder({vm: machine, document: document(view), host, browserStorage});
    if (folder) t.after(() => folder.dispose());
    return {folder, actions: folder && projectFolderActions(machine)};
}

test('with the folder picker, the browser folders stay hidden unless the host asks for them', t => {
    const fallback = mount(t, {showDirectoryPicker: picker, ...storage});
    assert.equal(fallback.folder.browserProjects, null);
    assert.equal(fallback.actions.openBrowser, undefined);
    const always = mount(t, {showDirectoryPicker: picker, ...storage}, 'always');
    assert.ok(always.folder.browserProjects);
    assert.equal(typeof always.actions.openBrowser, 'function');
});

test('without the folder picker, the browser folders stand in for it, and nothing mounts when they are off or missing', t => {
    const fallback = mount(t, storage);
    assert.ok(fallback.folder.browserProjects);
    // Open already uses the browser's folders, so there is no second command.
    assert.equal(fallback.actions.openBrowser, undefined);
    assert.equal(mount(t, storage, 'off').folder, null);
    assert.equal(mount(t, {navigator: {}}).folder, null);
});
