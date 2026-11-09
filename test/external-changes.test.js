import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mountProjectFolder} from '../dist/index.js';

const stringify = value => `${JSON.stringify(value, null, 2)}\n`;
const flagBlock = position => ({opcode: 'event_whenflagclicked', next: null, parent: null, inputs: {}, fields: {},
    shadow: false, topLevel: true, ...position});
const projectAt = (position, extra = {}) => ({targets: [{isStage: true, name: 'Stage', blocks: {flag: flagBlock(position), ...extra}}]});

function folder(initial) {
    let clock = 1_000;
    const files = new Map();
    const write = (name, text) => files.set(name, {text, lastModified: clock++});
    write('project.source.json', stringify(initial));
    write('embedded-extensions.json', stringify({formatVersion: 1, extensions: []}));
    write('sb3-source.json', stringify({formatVersion: 1, project: 'project.source.json',
        embeddedExtensions: 'embedded-extensions.json', assetsDirectory: 'assets', archiveEntries: ['project.json']}));
    const directory = {
        name: 'Folder',
        async getFileHandle(name) {
            return {name, async getFile() {
                const file = files.get(name);
                if (!file) throw new DOMException('missing', 'NotFoundError');
                return new File([file.text], name, {lastModified: file.lastModified});
            }};
        },
        async getDirectoryHandle() {return {values: () => []};}
    };
    return {directory, write, writeProject: project => write('project.source.json', stringify(project))};
}

function element(tag) {
    const listeners = new Map();
    return {
        tag, style: {}, dataset: {}, hidden: false, disabled: false, textContent: '', isConnected: true, children: [],
        setAttribute() {}, remove() {}, append(...children) {this.children.push(...children);},
        addEventListener(type, listener) {listeners.set(type, listener);},
        click() {listeners.get('click')?.();}
    };
}

async function settle() {
    for (let index = 0; index < 30; index++) await new Promise(resolve => setImmediate(resolve));
}

function setup({initial = projectAt({x: 0, y: 0}), autoReload, compareChanges} = {}) {
    const disk = folder(initial);
    const state = {dirty: false, running: false, applied: 0, loads: [], confirms: [], confirmAnswer: true};
    const listeners = new Set();
    let blocks = {};
    const rebuild = project => {
        blocks = Object.fromEntries(Object.entries(project.targets[0].blocks).map(([id, block]) => [id, {...block, id}]));
    };
    const stage = {};
    const target = {
        isStage: true, isOriginal: true, getName: () => 'Stage',
        blocks: {
            getBlock: id => blocks[id],
            changeBlock() {},
            moveBlock({id, newCoordinate}) {Object.assign(blocks[id], newCoordinate);}
        }
    };
    const vm = {
        runtime: {
            storage: {addHelper() {}}, targets: [target], getTargetForStage: () => stage, on() {}, off() {}
        },
        on() {}, off() {}, quit() {},
        async loadProject(text) {
            state.loads.push(JSON.parse(text));
            rebuild(JSON.parse(text));
        },
        toJSON: () => JSON.stringify({targets: [{isStage: true, name: 'Stage', blocks: Object.fromEntries(
            Object.entries(blocks).map(([id, {id: _, ...block}]) => [id, block]))}]})
    };
    const timers = [];
    const viewListeners = new Map();
    const created = [];
    const document = {
        visibilityState: 'visible',
        defaultView: {
            showDirectoryPicker: () => assert.fail('Unexpected picker call'),
            setTimeout(callback) {timers.push(callback); return timers.length;},
            clearTimeout() {},
            setInterval: () => 0,
            clearInterval() {},
            addEventListener(type, listener) {viewListeners.set(type, listener);},
            removeEventListener() {},
            confirm(message) {state.confirms.push(message); return state.confirmAnswer;}
        },
        createElement(tag) {
            const created_ = element(tag);
            created.push(created_);
            return created_;
        },
        addEventListener() {},
        removeEventListener() {},
        body: {append() {}}
    };
    const host = {
        isProjectDirty: () => state.dirty,
        beforeLoad() {}, onOpened() {}, onSaved() {},
        blockReload: {
            isRunning: () => state.running,
            subscribe(listener) {listeners.add(listener); return () => listeners.delete(listener);},
            onApplied() {state.applied++;},
            ...(compareChanges ? {compareChanges} : {})
        }
    };
    const mounted = mountProjectFolder({vm, document, host, autoReload});
    const notice = created.find(entry => entry.tag === 'aside');
    const [text, button] = notice.children;
    return {
        disk, state, vm, mounted, notice, text, button,
        position: () => ({x: blocks.flag.x, y: blocks.flag.y}),
        async open() {assert.equal(await mounted.openDirectory(disk.directory, () => true), 'opened');},
        // A focus event scans once. Pending follow-up scans run as the change settles.
        async scan() {
            viewListeners.get('focus')();
            await settle();
        },
        async runTimers() {
            while (timers.length) {
                timers.shift()();
                await settle();
            }
        },
        async notify() {
            for (const listener of listeners) listener();
            await settle();
        }
    };
}

test('applies a settled value or position change automatically when the Editor is clean and stopped', async t => {
    const editor = setup();
    t.after(() => editor.mounted.dispose());
    await editor.open();
    editor.disk.writeProject(projectAt({x: 40, y: 20}));
    await editor.scan();
    assert.equal(editor.notice.hidden, false);
    assert.equal(editor.text.textContent, 'External changes detected.');
    assert.deepEqual(editor.position(), {x: 0, y: 0}, 'the first sighting waits for the write to settle');
    await editor.runTimers();
    assert.deepEqual(editor.position(), {x: 40, y: 20});
    assert.equal(editor.state.applied, 1);
    assert.equal(editor.notice.hidden, true);
    assert.equal(editor.state.loads.length, 1, 'the partial reload does not reload the project');
});

test('leaves value changes for the reload command when automatic reload is off', async t => {
    const editor = setup({autoReload: false});
    t.after(() => editor.mounted.dispose());
    await editor.open();
    editor.disk.writeProject(projectAt({x: 40, y: 20}));
    await editor.scan();
    await editor.runTimers();
    await editor.scan();
    assert.deepEqual(editor.position(), {x: 0, y: 0});
    assert.equal(editor.button.textContent, 'Reload from Disk');
    assert.equal(editor.button.disabled, false);
    editor.button.click();
    await settle();
    assert.deepEqual(editor.position(), {x: 40, y: 20});
});

test('holds a change while the project runs and applies it once the project stops', async t => {
    const editor = setup();
    t.after(() => editor.mounted.dispose());
    await editor.open();
    editor.state.running = true;
    editor.disk.writeProject(projectAt({x: 5, y: 6}));
    await editor.scan();
    await editor.runTimers();
    assert.equal(editor.text.textContent, 'External changes detected. The changes load when the project stops.');
    assert.equal(editor.button.disabled, true);
    assert.deepEqual(editor.position(), {x: 0, y: 0});
    editor.state.running = false;
    await editor.notify();
    assert.deepEqual(editor.position(), {x: 5, y: 6});
    assert.equal(editor.notice.hidden, true);
});

test('keeps unsaved edits until the user confirms discarding them', async t => {
    const editor = setup();
    t.after(() => editor.mounted.dispose());
    await editor.open();
    editor.state.dirty = true;
    const external = projectAt({x: 7, y: 8});
    editor.disk.writeProject(external);
    await editor.scan();
    await editor.runTimers();
    assert.equal(editor.text.textContent, 'External changes detected. You have unsaved edits.');
    assert.equal(editor.button.textContent, 'Discard Edits and Reload…');
    assert.deepEqual(editor.position(), {x: 0, y: 0});
    editor.state.confirmAnswer = false;
    editor.button.click();
    await settle();
    assert.equal(editor.state.loads.length, 1);
    assert.equal(editor.state.confirms.length, 1);
    editor.state.confirmAnswer = true;
    editor.button.click();
    await settle();
    assert.deepEqual(editor.state.loads.at(-1), external);
    assert.deepEqual(editor.position(), {x: 7, y: 8});
});

test('offers a whole reload for structural changes and never applies them automatically', async t => {
    const editor = setup();
    t.after(() => editor.mounted.dispose());
    await editor.open();
    const external = projectAt({x: 0, y: 0}, {extra: flagBlock({x: 90, y: 90})});
    editor.disk.writeProject(external);
    await editor.scan();
    await editor.runTimers();
    await editor.scan();
    assert.equal(editor.text.textContent, 'External changes detected. These changes need the whole project to be reloaded.');
    assert.equal(editor.button.textContent, 'Reload Whole Project');
    assert.equal(editor.button.disabled, false);
    assert.equal(editor.state.loads.length, 1);
    editor.button.click();
    await settle();
    assert.deepEqual(editor.state.loads.at(-1), external);
    assert.equal(editor.state.confirms.length, 0, 'a clean Editor reloads without asking');
    assert.equal(editor.notice.hidden, true);
});

test('waits for an incomplete write and applies the completed file', async t => {
    const editor = setup();
    t.after(() => editor.mounted.dispose());
    await editor.open();
    editor.disk.write('project.source.json', '{"targets": [');
    await editor.scan();
    assert.equal(editor.text.textContent, 'External changes detected. Waiting for the external write to finish.');
    assert.equal(editor.button.hidden, true);
    editor.disk.writeProject(projectAt({x: 3, y: 4}));
    await editor.runTimers();
    assert.deepEqual(editor.position(), {x: 3, y: 4});
    assert.equal(editor.notice.hidden, true);
});

test('treats a changed manifest as a structural change', async t => {
    const editor = setup();
    t.after(() => editor.mounted.dispose());
    await editor.open();
    editor.disk.write('embedded-extensions.json', stringify({formatVersion: 1, extensions: [], note: 'changed'}));
    await editor.scan();
    assert.equal(editor.button.textContent, 'Reload Whole Project');
});

test('compares unsaved edits with the folder and keeps them unless the user discards them', async t => {
    const requests = [];
    let answer = 'keep';
    const editor = setup({compareChanges: async request => {requests.push(request); return answer;}});
    t.after(() => editor.mounted.dispose());
    await editor.open();
    editor.vm.runtime.targets[0].blocks.moveBlock({id: 'flag', newCoordinate: {x: 11, y: 12}});
    editor.state.dirty = true;
    const external = projectAt({x: 70, y: 80});
    editor.disk.writeProject(external);
    await editor.scan();
    await editor.runTimers();
    assert.equal(editor.button.textContent, 'Compare and Choose…');
    editor.button.click();
    await settle();
    assert.equal(requests.length, 1);
    const [request] = requests;
    assert.equal(request.title, 'External changes and your unsaved edits');
    assert.deepEqual(request.actions.map(action => action.id), ['keep', 'discard']);
    assert.deepEqual(request.sections.map(section => section.title), ['Your unsaved edits', 'Changes in the folder']);
    const [edits, folder] = request.sections;
    assert.equal(edits.before, folder.before, 'both start from the version last loaded');
    assert.deepEqual(JSON.parse(edits.before).targets[0].blocks.flag, flagBlock({x: 0, y: 0}));
    assert.deepEqual(JSON.parse(edits.after).targets[0].blocks.flag, flagBlock({x: 11, y: 12}), 'edits as Save would write them');
    assert.deepEqual(JSON.parse(folder.after), external);
    assert.deepEqual(request.notes, []);
    assert.equal(editor.state.loads.length, 1, 'keeping the edits loads nothing');
    assert.deepEqual(editor.position(), {x: 11, y: 12});
    assert.equal(editor.state.confirms.length, 0);

    answer = 'discard';
    editor.button.click();
    await settle();
    assert.deepEqual(editor.state.loads.at(-1), external);
    assert.deepEqual(editor.position(), {x: 70, y: 80});
    assert.equal(editor.state.confirms.length, 0, 'the comparison replaces the confirmation');
});

test('notes edits the folder cannot save and still shows the folder changes', async t => {
    const requests = [];
    const editor = setup({compareChanges: async request => {requests.push(request); return null;}});
    t.after(() => editor.mounted.dispose());
    await editor.open();
    const toJSON = editor.vm.toJSON;
    // A project-level edit, such as a renamed project property, is outside what Save can write.
    editor.vm.toJSON = (...args) => JSON.stringify({...JSON.parse(toJSON(...args)), meta: {edited: true}});
    editor.state.dirty = true;
    editor.disk.writeProject(projectAt({x: 5, y: 5}));
    await editor.scan();
    await editor.runTimers();
    editor.button.click();
    await settle();
    assert.deepEqual(requests[0].sections.map(section => section.title), ['Changes in the folder']);
    assert.equal(requests[0].notes.length, 1);
    assert.equal(editor.state.loads.length, 1, 'closing the dialog keeps the edits');
});
