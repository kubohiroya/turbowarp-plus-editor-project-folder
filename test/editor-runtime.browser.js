import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
import {serveEditorRuntime} from '@kubohiroya/turbowarp-plus-editor-test-runtime';

const block = (opcode, {next = null, parent = null, inputs = {}, fields = {}, x = 0, y = 0} = {}) =>
    ({opcode, next, parent, inputs, fields, shadow: false, topLevel: parent === null, ...(parent === null ? {x, y} : {})});
const target = (isStage, name, blocks) => ({isStage, name, variables: isStage ? {'var-1': ['score', 0]} : {}, lists: {}, broadcasts: {},
    blocks, comments: {}, currentCostume: 0, costumes: [], sounds: [], volume: 100, layerOrder: isStage ? 0 : 1,
    ...(isStage ? {} : {visible: true, x: 0, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around'})});
const project = cat => ({targets: [target(true, 'Stage', {}), target(false, 'Cat', cat)], monitors: [], extensions: [], meta: {semver: '3.0.0'}});
const cat = () => ({
    flag: block('event_whenflagclicked', {next: 'move'}),
    move: block('motion_movesteps', {parent: 'flag', inputs: {STEPS: [1, [4, '10']]}})
});
const withTurn = () => {
    const blocks = cat();
    blocks.move.next = 'turn';
    blocks.turn = block('motion_turnright', {parent: 'move', inputs: {DEGREES: [1, [4, '15']]}});
    return blocks;
};

async function open(t) {
    const server = await serveEditorRuntime({script: fileURLToPath(new URL('./editor-runtime-page.js', import.meta.url))});
    const browser = await chromium.launch();
    t.after(async () => {await browser.close(); await server.close();});
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(server.url);
    assert.equal(await page.evaluate(value => openFolder(value), project(cat())), 'opened');
    t.after(() => assert.deepEqual(errors, []));
    const change = async blocks => {
        await page.evaluate(async value => {await folder.write('project.source.json', value); dispatchEvent(new Event('focus'));}, project(blocks));
    };
    return {page, change};
}

test('an added block from the folder reaches the VM and the workspace without reloading the project', async t => {
    const {page, change} = await open(t);
    assert.deepEqual(await page.evaluate(() => folder.workspaceBlocks()), ['event_whenflagclicked', 'math_number', 'motion_movesteps']);
    const loads = await page.evaluate(() => folder.loads());
    await change(withTurn());
    await page.waitForFunction(() => folder.workspaceBlocks().includes('motion_turnright'), null, {timeout: 15_000});
    assert.deepEqual(await page.evaluate(() => folder.vmBlocks()),
        ['event_whenflagclicked', 'math_number', 'math_number', 'motion_movesteps', 'motion_turnright']);
    assert.equal(await page.evaluate(() => folder.loads()), loads, 'the project was not reloaded');
    assert.equal(await page.evaluate(() => folder.runtime.isProjectDirty()), false);
});

test('an edit in the workspace holds the folder change until the user chooses', async t => {
    const {page, change} = await open(t);
    await page.evaluate(() => {
        const created = folder.runtime.workspace.newBlock('motion_turnleft');
        created.initSvg();
        created.render();
    });
    await page.waitForFunction(() => folder.runtime.isProjectDirty());
    await change(withTurn());
    await page.waitForFunction(() => folder.notice() && !folder.notice().hidden, null, {timeout: 15_000});
    assert.equal(await page.evaluate(() => folder.vmBlocks().includes('motion_turnright')), false, 'the VM keeps the edit');
    assert.equal(await page.evaluate(() => folder.workspaceBlocks().includes('motion_turnleft')), true);
});
