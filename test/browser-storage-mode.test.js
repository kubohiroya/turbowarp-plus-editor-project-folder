import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mountProjectFolder, projectFolderActions, renderProjectFolderMenu} from '../dist/index.js';

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
    assert.equal(always.actions.deviceFolders, true);
});

test('without the folder picker, the browser folders stand in for it, and nothing mounts when they are off or missing', t => {
    const fallback = mount(t, storage);
    assert.ok(fallback.folder.browserProjects);
    // The browser's folders have their own command, and hosts show Open (device folders) as unavailable.
    assert.equal(typeof fallback.actions.openBrowser, 'function');
    assert.equal(fallback.actions.deviceFolders, false);
    assert.equal(mount(t, storage, 'off').folder, null);
    assert.equal(mount(t, {navigator: {}}).folder, null);
});

test('without the folder picker, the folder menu shows Open as unavailable and offers the browser\'s folders', t => {
    const machine = vm();
    const folder = mountProjectFolder({vm: machine, document: document(storage), host});
    t.after(() => folder.dispose());
    const element = (type, props, ...children) => ({type, props: props ?? {}, children});
    const section = renderProjectFolderMenu(element, {vm: machine, locale: 'ja', MenuItem: 'item', MenuSection: 'section',
        onRequestClose() {}});
    const [open, openBrowser] = section.children;
    assert.equal(open.props.command, 'project-folder-open');
    assert.equal(open.props.onClick, undefined);
    assert.equal(open.children[0].props['aria-disabled'], true);
    assert.match(open.children[0].props.title, /Chrome か Edge/);
    assert.equal(openBrowser.props.command, 'project-folder-openBrowser');
    assert.equal(typeof openBrowser.props.onClick, 'function');
});
