import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium, expect, webkit} from '@playwright/test';
import {serveEditorRuntime} from '@kubohiroya/turbowarp-plus-editor-test-runtime';

const target = (isStage, name) => ({isStage, name, variables: {}, lists: {}, broadcasts: {}, blocks: {}, comments: {},
    currentCostume: 0, costumes: [], sounds: [], volume: 100, layerOrder: isStage ? 0 : 1,
    ...(isStage ? {} : {visible: true, x: 0, y: 0, size: 100, direction: 90, draggable: false, rotationStyle: 'all around'})});
const project = {targets: [target(true, 'Stage'), target(false, 'Cat')], monitors: [], extensions: [], meta: {semver: '3.0.0'}};

// WebKit keeps the private file system only in a persistent profile; Chromium has none of the picker once it is removed.
const engines = [
    ['Chromium with both storage choices', async profile => (await chromium.launch({headless: true})).newContext({acceptDownloads: true}),
        false, 'always'],
    ['Chromium without the folder picker', async profile => (await chromium.launch()).newContext({acceptDownloads: true}),
        true],
    ['WebKit', profile => webkit.launchPersistentContext(profile, {acceptDownloads: true}), false]
];

for (const [name, launch, withoutPicker, browserStorage] of engines) {
    test(`${name}: reopen registered project IDs in a new tab without resolving or creating folders`, async t => {
        const temp = await mkdtemp(path.join(tmpdir(), 'twpf-project-id-'));
        t.after(() => rm(temp, {recursive: true, force: true}));
        const server = await serveEditorRuntime({script: fileURLToPath(new URL('./browser-projects-page.js', import.meta.url))});
        const context = await launch(path.join(temp, 'profile'));
        t.after(async () => {await context.close(); await context.browser()?.close(); await server.close();});
        const first = context.pages()[0] ?? await context.newPage();
        const errors = [];
        first.on('pageerror', error => errors.push(error.message));
        t.after(() => assert.deepEqual(errors, []));
        await first.goto(server.url);
        const options = {project, withoutPicker, browserStorage};
        assert.equal(await first.evaluate(options => setup(options), options), true);
        const unknown = await first.evaluate(async () => {
            const initial = await navigator.storage.getDirectory();
            const ids = ['../invalid', 'unknown-id'];
            return {results: await Promise.all(ids.map(id => subject.folder.openBrowserProject(id, () => {
                throw new Error('An unknown project must not try to replace the open project');
            }))), names: await Array.fromAsync(initial.keys()), opened: subject.folder.directory};
        });
        assert.deepEqual(unknown, {results: ['not-project', 'not-project'], names: [], opened: null});

        await first.evaluate(() => {void subject.create('Original', 'browser');});
        const createDialog = first.locator('dialog[data-browser-projects="create"]');
        await createDialog.getByRole('button', {name: '作成'}).click();
        await expect.poll(() => first.evaluate(() => subject.created)).toBe('opened');
        const [stored] = await first.evaluate(() => subject.projects.list());
        assert.equal(stored.projectPath, '');
        assert.equal(await first.evaluate(() => subject.folder.browserProjectId), stored.id);
        const tab = await context.newPage();
        tab.on('pageerror', error => errors.push(error.message));
        await tab.goto(server.url);
        assert.equal(await tab.evaluate(options => setup({...options, resetStorage: false}), options), true);

        const opened = await tab.evaluate(async id => {
            // Reject all handle resolution in the receiving tab, including any implicit save/rename classification.
            const root = await navigator.storage.getDirectory();
            const prototype = Object.getPrototypeOf(root);
            const restore = Object.getOwnPropertyDescriptor(prototype, 'resolve');
            let resolves = 0, locks = 0;
            Object.defineProperty(prototype, 'resolve', {configurable: true, value() {
                resolves++;
                throw new Error('A local ID must not call handle.resolve()');
            }});
            const projects = subject.folder.browserProjects;
            const exclusive = projects.exclusive;
            projects.exclusive = (id, action) => {locks++; return exclusive(id, action);};
            try {
                const status = await subject.folder.openBrowserProject(id, () => true);
                const sameObject = subject.folder.root === subject.folder.directory;
                const location = subject.folder.location;
                const stillOpen = await subject.folder.openBrowserProject('unknown-id', () => {
                    throw new Error('An unknown project must leave the current project open');
                });
                subject.runtime.vm.runtime.targets.find(target => !target.isStage).setXY(70, 80);
                const saved = await subject.folder.save();
                const renamed = await subject.folder.renameCurrentBrowserFolder('Renamed');
                return {status, sameObject, location, stillOpen, id: subject.folder.browserProjectId, saves: saved.status, renamed, resolves, locks};
            } finally {
                projects.exclusive = exclusive;
                if (restore) Object.defineProperty(prototype, 'resolve', restore);
                else delete prototype.resolve;
            }
        }, stored.id);
        assert.deepEqual(opened, {status: 'opened', sameObject: true, location: 'browser',
            stillOpen: 'not-project', id: stored.id, saves: 'saved', renamed: true, resolves: 0, locks: 1});
        const after = await first.evaluate(() => subject.projects.list());
        assert.deepEqual(after.map(project => [project.id, project.title]), [[stored.id, 'Renamed']]);
        const cat = (await first.evaluate(id => subject.storedProject(id), stored.id)).targets.find(target => target.name === 'Cat');
        assert.deepEqual([cat.x, cat.y], [70, 80]);
    });
}

for (const [name, launch, withoutPicker, browserStorage] of engines) {
    test(`${name}: create, save, reopen, export and delete a project folder kept in the browser`, async t => {
        const temp = await mkdtemp(path.join(tmpdir(), 'twpf-browser-projects-'));
        const server = await serveEditorRuntime({script: fileURLToPath(new URL('./browser-projects-page.js', import.meta.url))});
        const context = await launch(path.join(temp, 'profile'));
        t.after(async () => {await context.close(); await context.browser()?.close(); await server.close();
            await rm(temp, {recursive: true, force: true});});
        const page = context.pages()[0] ?? await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        t.after(() => assert.deepEqual(errors, []));
        await page.goto(server.url);
        assert.equal(await page.evaluate(options => setup(options), {project, withoutPicker, browserStorage}), true);

        const panel = page.locator('[data-storage-choices]');
        const device = panel.locator('[data-project-folder-location="device"]');
        const browser = panel.locator('[data-project-folder-location="browser"]');
        await expect(browser).toContainText('名前を入力すると');
        await expect(browser).toContainText('サイトデータの削除');
        await expect(browser).toContainText('直接見ることはできません');
        await expect(browser).toContainText('SB3・ZIP');
        if (browserStorage === 'always') {
            await expect(device).toContainText('VS Code');
            await expect(device).toContainText('空のフォルダ');
            // Cancelling the device picker leaves both choices available.
            await device.getByRole('button').click();
            assert.equal(await page.evaluate(() => subject.created), 'cancelled');
            assert.equal(await page.evaluate(() => pickerCalls), 1);
            await expect(browser.getByRole('button')).toBeEnabled();
        } else {
            await expect(device).toHaveCount(0);
        }
        if (process.env.STORAGE_CHOICE_SCREENSHOT_DIR) {
            await mkdir(process.env.STORAGE_CHOICE_SCREENSHOT_DIR, {recursive: true});
            await panel.screenshot({path: path.join(process.env.STORAGE_CHOICE_SCREENSHOT_DIR,
                browserStorage === 'always' ? 'chromium-storage-choices.png' : `browser-storage-${withoutPicker ? 'chromium' : 'webkit'}.png`)});
        }

        // Saving a new project folder asks for a name instead of a folder on the device.
        await browser.getByRole('button').click();
        const createDialog = page.locator('dialog[data-browser-projects="create"]');
        await expect(createDialog.getByRole('heading')).toHaveText('新しい作品フォルダをブラウザー内に作る');
        await expect(createDialog.getByLabel('名前')).toHaveValue('ねこの冒険');
        await createDialog.getByRole('button', {name: '閉じる'}).click();
        assert.equal(await page.evaluate(() => subject.created), 'cancelled');
        await expect(browser.getByRole('button')).toBeEnabled();
        assert.deepEqual(await page.evaluate(() => subject.projects.list()), []);
        await browser.getByRole('button').click();
        await createDialog.getByRole('button', {name: '作成'}).click();
        assert.equal(await page.evaluate(() => subject.created), 'opened');
        await expect(createDialog).toHaveCount(0);

        const [stored] = await page.evaluate(() => subject.projects.list());
        assert.equal(stored.title, 'ねこの冒険');
        assert.equal(stored.projectPath, '');
        await expect(panel.locator('[data-project-folder-location]')).toHaveCount(0);
        assert.equal(await page.evaluate(() => pickerCalls), browserStorage === 'always' ? 1 : 0);

        // Saving writes into the browser's folder and marks it as updated.
        const saved = await page.evaluate(async () => {
            subject.runtime.vm.runtime.targets.find(target => !target.isStage).setXY(50, 60);
            return subject.folder.save();
        });
        assert.equal(saved.status, 'saved');
        const cat = (await page.evaluate(id => subject.storedProject(id), stored.id)).targets.find(target => target.name === 'Cat');
        assert.deepEqual([cat.x, cat.y], [50, 60]);
        const [updated] = await page.evaluate(() => subject.projects.list());
        assert.ok(updated.updatedAt >= stored.updatedAt);

        // The File menu's Open lists the browser's folders.
        await page.evaluate(() => {const actions = subject.actions(); (actions.openBrowser ?? actions.open)();});
        const openDialog = page.locator('dialog[data-browser-projects="open"]');
        const row = openDialog.locator(`[data-browser-project="${stored.id}"]`);
        await expect(row).toContainText('ねこの冒険');
        await row.getByRole('button', {name: '開く'}).click();
        await expect(page.locator('[data-project-folder-status]')).toHaveText('プロジェクトフォルダを開きました。');

        // A ZIP keeps a copy outside the browser.
        await page.evaluate(() => {const actions = subject.actions(); (actions.openBrowser ?? actions.open)();});
        const download = page.waitForEvent('download');
        await row.getByRole('button', {name: 'ZIP で書き出す'}).click();
        const file = await download;
        assert.equal(file.suggestedFilename(), 'ねこの冒険.zip');
        const zip = path.join(temp, 'export.zip');
        await file.saveAs(zip);
        const names = JSON.parse(execFileSync('python3', ['-I', '-c',
            'import json, sys, zipfile\nz = zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint(json.dumps(sorted(z.namelist())))',
            zip], {encoding: 'utf8'}));
        // Saving made the empty asset and extension folders, which the ZIP keeps.
        assert.deepEqual(names, ['assets/', 'embedded-extensions.json', 'extensions/', 'project.source.json', 'sb3-source.json']);

        // Deleting asks first and then empties the list.
        page.once('dialog', dialog => dialog.accept());
        await row.getByRole('button', {name: '削除…'}).click();
        await expect(openDialog.locator('[data-browser-projects-list]')).toHaveText('このブラウザーには、まだ作品フォルダがありません。');
        assert.deepEqual(await page.evaluate(() => subject.projects.list()), []);
        await openDialog.getByRole('button', {name: '閉じる'}).click();
        await expect(openDialog).toHaveCount(0);

        // A stored folder opens at its root, which is its own root.
        await page.evaluate(() => {subject.create('二つ目', 'browser');});
        await createDialog.getByRole('button', {name: '作成'}).click();
        assert.equal(await page.evaluate(() => subject.created), 'opened');
        const [second] = await page.evaluate(() => subject.projects.list());
        await page.evaluate(() => subject.actions().openBrowser());
        await openDialog.locator(`[data-browser-project="${second.id}"]`).getByRole('button', {name: '開く'}).click();
        await expect.poll(() => page.evaluate(id => subject.openedFrom(id), second.id))
            .toEqual({directory: true, root: true, name: second.id});

        // A folder kept with the old layout, its project in project/: opening it moves the project to the root, next to
        // .git, records that, and opens it there.
        const repository = await page.evaluate(() => subject.createOldLayout('リポジトリ'));
        await page.evaluate(() => subject.actions().openBrowser());
        await openDialog.locator(`[data-browser-project="${repository}"]`).getByRole('button', {name: '開く'}).click();
        await expect.poll(() => page.evaluate(id => subject.openedFrom(id), repository))
            .toEqual({directory: true, root: true, name: repository});
        assert.deepEqual(await page.evaluate(id => subject.rootNames(id), repository),
            ['.git', 'embedded-extensions.json', 'project.source.json', 'sb3-source.json']);
        assert.equal((await page.evaluate(() => subject.projects.list())).find(entry => entry.id === repository).projectPath, '');

        // When a name in project/ is already taken at the root, nothing moves: the folder is no project folder, the
        // error dialog tells so and the open project stays.
        const clashing = await page.evaluate(() => subject.createOldLayout('重なるリポジトリ', true));
        await page.evaluate(() => subject.actions().openBrowser());
        await openDialog.locator(`[data-browser-project="${clashing}"]`).getByRole('button', {name: '開く'}).click();
        const error = page.getByRole('alertdialog', {name: 'フォルダを開けません'});
        await expect(error).toContainText('このフォルダはプロジェクトフォルダではありません。');
        await expect(error.getByRole('button', {name: 'OK'})).toBeFocused();
        await error.getByRole('button', {name: 'OK'}).click();
        await expect(error).toHaveCount(0);
        assert.deepEqual(await page.evaluate(id => subject.openedFrom(id), repository), {directory: true, root: true, name: repository});
        assert.deepEqual(await page.evaluate(id => subject.rootNames(id), clashing), ['.git', 'embedded-extensions.json', 'project']);
    });
}

test('Chromium: the device choice saves to the selected handle and keeps browser storage separate', async t => {
    const server = await serveEditorRuntime({script: fileURLToPath(new URL('./browser-projects-page.js', import.meta.url))});
    const browser = await chromium.launch({headless: true});
    t.after(async () => {await browser.close(); await server.close();});
    const page = await browser.newPage();
    await page.goto(server.url);
    await page.evaluate(options => setup(options), {project, browserStorage: 'always', locale: 'en'});
    const panel = page.locator('[data-storage-choices]');
    await expect(panel).toContainText('Clearing site data');
    await expect(panel.getByRole('button')).toHaveCount(2);
    await page.evaluate(() => {globalThis.acceptDevicePicker = true;});
    await panel.getByRole('button', {name: 'Choose a Folder and Save…'}).click();
    assert.equal(await page.evaluate(() => subject.created), 'opened');
    assert.equal(await page.evaluate(() => pickerCalls), 1);
    assert.equal(await page.evaluate(() => subject.folder.directory.name), 'device-fixture');
    assert.deepEqual(await page.evaluate(() => subject.projects.list()), []);
    await expect(panel.locator('[data-project-folder-location]')).toHaveCount(0);

    // Open with a folder on the device that is not a project folder shows the error dialog and keeps the project.
    await page.evaluate(() => {globalThis.pickerFolder = 'notes'; subject.actions().open();});
    const error = page.getByRole('alertdialog', {name: 'Cannot Open Folder'});
    await expect(error).toContainText('This folder is not a project folder.');
    await error.getByRole('button', {name: 'OK'}).click();
    await expect(error).toHaveCount(0);
    assert.equal(await page.evaluate(() => pickerCalls), 2);
    assert.equal(await page.evaluate(() => subject.folder.directory.name), 'device-fixture');
    assert.equal(await page.evaluate(() => subject.folder.root.name), 'device-fixture');
});
