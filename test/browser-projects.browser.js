import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
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
    ['Chromium without the folder picker', async profile => (await chromium.launch()).newContext({acceptDownloads: true}),
        true],
    ['WebKit', profile => webkit.launchPersistentContext(profile, {acceptDownloads: true}), false]
];

for (const [name, launch, withoutPicker] of engines) {
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
        assert.equal(await page.evaluate(options => setup(options), {project, withoutPicker}), true);

        // Saving a new project folder asks for a name instead of a folder on the device.
        await page.evaluate(() => subject.create('ねこの冒険'));
        const createDialog = page.locator('dialog[data-browser-projects="create"]');
        await expect(createDialog.getByRole('heading')).toHaveText('新しい作品フォルダをブラウザー内に作る');
        await expect(createDialog.getByLabel('名前')).toHaveValue('ねこの冒険');
        await createDialog.getByRole('button', {name: '作成'}).click();
        assert.equal(await page.evaluate(() => subject.created), 'opened');
        await expect(createDialog).toHaveCount(0);

        const [stored] = await page.evaluate(() => subject.projects.list());
        assert.equal(stored.title, 'ねこの冒険');
        assert.equal(stored.projectPath, '');

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
        await page.evaluate(() => subject.actions().open());
        const openDialog = page.locator('dialog[data-browser-projects="open"]');
        const row = openDialog.locator(`[data-browser-project="${stored.id}"]`);
        await expect(row).toContainText('ねこの冒険');
        await row.getByRole('button', {name: '開く'}).click();
        await expect(page.locator('[data-project-folder-status]')).toHaveText('プロジェクトフォルダを開きました。');

        // A ZIP keeps a copy outside the browser.
        await page.evaluate(() => subject.actions().open());
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

        // A repository kept in the browser opens its project/ folder, and the stored folder is the root.
        const repository = await page.evaluate(() => subject.createRepository('リポジトリ'));
        await page.evaluate(() => subject.actions().open());
        await openDialog.locator(`[data-browser-project="${repository}"]`).getByRole('button', {name: '開く'}).click();
        await expect.poll(() => page.evaluate(id => subject.openedFrom(id), repository))
            .toEqual({directory: true, root: true, name: 'project'});
    });
}
