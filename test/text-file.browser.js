import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {chromium, expect} from '@playwright/test';
import {build} from 'vite';

const content = JSON.stringify({targets: Array.from({length: 500}, (_, i) => ({name: `Sprite ${i}`, x: i}))}, null, 2);

async function open(t, locale = 'ja', {external, opfs = false, realCompanion} = {}) {
    const output = await mkdtemp(path.join(tmpdir(), 'twpf-text-'));
    t.after(() => rm(output, {recursive: true, force: true}));
    await build({configFile: false, logLevel: 'silent',
        root: fileURLToPath(new URL('..', import.meta.url)),
        build: {outDir: output, minify: false, target: 'es2017',
            lib: {entry: fileURLToPath(new URL('./text-file-page.js', import.meta.url)),
                formats: ['es'], fileName: () => 'harness.js'}}});
    const harness = await readFile(path.join(output, 'harness.js'));
    const html = `<!doctype html><style>
        html,body{margin:0;height:100%;font:14px sans-serif}#root{height:100%;color:#333;--ui-primary:#fff}
        </style><div id="root"></div><script type="module" src="/harness.js"></script>`;
    let url = 'http://localhost:41017/';
    if (realCompanion) {
        const {startYamlEditorHost} = await import(pathToFileURL(process.env.TWPF_COMPANION_HOST));
        const dataDirectory = await mkdtemp(path.join(tmpdir(), 'twpf-companion-data-'));
        await writeFile(path.join(output, 'index.html'), html);
        const host = await startYamlEditorHost({siteDirectory: output, dataDirectory, publicPath: '/', editorPath: '/index.html',
            launchEditor: async (file, profile) => realCompanion.launches.push({file, profile})});
        t.after(async () => {
            await host.close();
            await rm(dataDirectory, {recursive: true, force: true});
            if (host.profileSeparated) await rm(host.profileDirectory, {recursive: true, force: true});
        });
        url = host.url;
    }
    const browser = await chromium.launch({headless: true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport: {width: 900, height: 600}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
    t.after(() => assert.deepEqual(errors, []));
    if (!realCompanion) await page.route('http://localhost:41017/**', route => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        const json = value => route.fulfill({json: value});
        if (pathname === '/__twpe_yaml/config') return json(external ?
            {available: true, token: 'test-session-token', editor: 'VSCode', maxSourceBytes: 4 * 1024 * 1024, formats: ['yaml', 'json', 'text']} :
            {available: false});
        if (pathname.startsWith('/__twpe_yaml/sessions')) {
            assert.equal(request.headers()['x-twpe-yaml-token'], 'test-session-token');
            if (pathname.endsWith('/sessions')) {
                external.opened = request.postDataJSON();
                external.source = external.opened.source;
                return json({id: 'a'.repeat(32)});
            }
            if (request.method() === 'DELETE') {external.closed = (external.closed ?? 0) + 1; return json({closed: true});}
            return json({source: external.source});
        }
        return pathname.endsWith('harness.js') ? route.fulfill({body: harness, contentType: 'text/javascript'}) :
            route.fulfill({body: html, contentType: 'text/html'});
    });
    await page.goto(url);
    await page.waitForFunction(() => typeof mountFile === 'function');
    await page.evaluate(args => mountFile(args), {content, locale, opfs});
    await expect(page.getByRole('slider')).toHaveAttribute('aria-valuemax', String(content.split('\n').length));
    return page;
}

async function typeContent(page, text) {
    const editor = page.locator('.twpf-file-edit .cm-content');
    await editor.focus();
    await editor.press('ControlOrMeta+a');
    await page.keyboard.insertText(text);
}

test('text fills the panel with floating actions and an interactive minimap', async t => {
    const page = await open(t);
    await expect(page.locator('.twpf-file-path')).toHaveCount(0);
    await expect(page.getByRole('button', {name: 'ファイルを保存', exact: true})).toBeDisabled();
    await expect(page.getByRole('button', {name: 'VSCodeで編集', exact: true})).toBeDisabled();
    const modes = page.getByRole('radiogroup', {name: '表示モード'});
    const normal = modes.getByRole('radio', {name: '通常表示', exact: true});
    const diff = modes.getByRole('radio', {name: '差分表示', exact: true});
    await expect(normal).toHaveAttribute('aria-checked', 'true');
    await expect(normal).toHaveAttribute('title', 'この画面でファイルの内容を編集');
    await expect(diff.locator('svg')).toBeVisible();
    await normal.focus();
    await normal.press('ArrowRight');
    await expect(diff).toHaveAttribute('aria-checked', 'true');
    await expect(diff).toBeFocused();
    await diff.press('ArrowLeft');
    await expect(normal).toHaveAttribute('aria-checked', 'true');
    await expect(diff).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByRole('button', {name: 'ファイルを保存', exact: true}).locator('svg')).toBeVisible();
    const geometry = await page.evaluate(() => {
        const box = selector => {
            const {x, y, width, height} = document.querySelector(selector).getBoundingClientRect();
            return {x, y, width, height};
        };
        return {panel: box('.twpf-text-file'), editor: box('.cm-editor'), toolbar: box('.twpf-file-toolbar'),
            map: box('.twpf-text-minimap')};
    });
    assert.deepEqual(geometry.editor, geometry.panel);
    assert.ok(geometry.toolbar.x + geometry.toolbar.width > 870 && geometry.toolbar.y < 15);
    assert.ok(geometry.map.x > 750 && geometry.map.y > 400);
    assert.ok(await page.locator('canvas').evaluate(canvas =>
        canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.some(byte => byte !== 0)));
    const minimap = page.getByRole('slider', {name: 'ファイルのミニマップ'});
    await minimap.focus();
    await page.keyboard.press('End');
    await expect.poll(() => page.locator('.cm-scroller').evaluate(node => node.scrollTop)).toBeGreaterThan(10000);
    await expect.poll(() => page.locator('.twpf-text-minimap-viewport').evaluate(node => parseFloat(node.style.top))).toBeGreaterThan(90);
    await minimap.press('Home');
    await expect.poll(() => page.locator('.cm-scroller').evaluate(node => node.scrollTop)).toBe(0);
    const map = await minimap.boundingBox();
    await minimap.click({position: {x: map.width / 2, y: map.height * .75}});
    await expect.poll(() => page.locator('.cm-scroller').evaluate(node => node.scrollTop)).toBeGreaterThan(10000);
    await page.mouse.move(map.x + 10, map.y + map.height * .75);
    await page.mouse.down();
    await page.mouse.move(map.x + 10, map.y + 2, {steps: 5});
    await page.mouse.up();
    await expect.poll(() => minimap.getAttribute('aria-valuenow')).toMatch(/^[1-9][0-9]?$/u);
    await minimap.press('Home');
    await expect.poll(() => page.locator('.cm-scroller').evaluate(node => node.scrollTop)).toBe(0);
    if (process.env.TWPF_TEXT_SCREENSHOT) {
        await page.screenshot({path: process.env.TWPF_TEXT_SCREENSHOT});
        await modes.screenshot({path: `${process.env.TWPF_TEXT_SCREENSHOT}.toggle.png`});
    }

    await page.setViewportSize({width: 320, height: 240});
    await expect(minimap).toBeVisible();
    await expect(page.getByRole('button', {name: 'ファイルを保存', exact: true})).toBeInViewport();
    await page.evaluate(() => document.getElementById('root').style.setProperty('--ui-primary', '#20242b'));
    await page.evaluate(() => Object.assign(document.getElementById('root').style,
        {color: '#eee', colorScheme: 'dark', background: '#20242b'}));
    await expect(minimap).toHaveCSS('background-color', 'rgb(32, 36, 43)');
    const boxes = await page.evaluate(() => {
        const {bottom: toolbarBottom} = document.querySelector('.twpf-file-toolbar').getBoundingClientRect();
        const {top: minimapTop, right, bottom} = document.querySelector('.twpf-text-minimap').getBoundingClientRect();
        return {toolbarBottom, minimapTop, right, bottom};
    });
    assert.ok(boxes.toolbarBottom < boxes.minimapTop && boxes.right < 320 && boxes.bottom < 240);
    if (process.env.TWPF_TEXT_SCREENSHOT) await page.screenshot({path: `${process.env.TWPF_TEXT_SCREENSHOT}.narrow.png`});
});

test('editing, saving and comparing retain the content and update the minimap', async t => {
    const page = await open(t, 'en');
    const edited = '{"edited": true}\n';
    await expect(page.locator('.twpf-file-edit .cm-content')).toHaveAttribute('contenteditable', 'true');
    await typeContent(page, edited);
    await expect(page.getByRole('button', {name: 'Save file', exact: true})).toBeEnabled();
    await typeContent(page, content);
    await expect(page.getByRole('button', {name: 'Save file', exact: true})).toBeDisabled();
    await typeContent(page, edited);
    await expect(page.getByRole('slider', {name: 'File minimap'})).toHaveAttribute('aria-valuemax', '2');
    await expect(page.getByRole('status').first()).toHaveText('Unsaved changes');
    await expect(page.locator('.twpf-file-status')).toHaveCSS('position', 'absolute');
    assert.equal((await page.locator('.cm-editor').boundingBox()).height, 600);
    await page.clock.install();
    await page.getByRole('button', {name: 'Save file', exact: true}).click();
    await expect(page.locator('.twpf-file-snackbar')).toHaveText('Saved.');
    await expect(page.locator('.twpf-file-snackbar')).toBeVisible();
    await expect(page.locator('.twpf-file-status')).toBeHidden();
    assert.equal(await page.evaluate(() => readSaved()), edited);
    await expect(page.getByRole('button', {name: 'Save file', exact: true})).toBeDisabled();
    await page.clock.fastForward(4000);
    await expect(page.locator('.twpf-file-snackbar')).toBeHidden();
    await page.getByRole('radio', {name: 'Diff view', exact: true}).click();
    await expect(page.getByRole('slider')).toBeHidden();
    await expect(page.getByRole('button', {name: 'Full file', exact: true})).toBeEnabled();
    await page.getByRole('button', {name: 'Full file', exact: true}).click();
    await expect(page.locator('.cm-mergeView')).toBeVisible();
    await expect(page.locator('.cm-mergeViewEditor').last()).toContainText('"edited": true');
    const toolbar = await page.locator('.twpf-file-toolbar').boundingBox();
    const ranges = await page.locator('.twpf-diff-toolbar').boundingBox();
    assert.ok(toolbar.y + toolbar.height <= ranges.y);
    await page.getByRole('radio', {name: 'Normal view', exact: true}).click();
    await expect(page.getByRole('slider')).toBeVisible();
    await expect(page.locator('.twpf-file-edit .cm-content')).toHaveText(edited.trim());
    await page.evaluate(() => fileSession.dispose());
    await expect(page.locator('.twpf-text-minimap')).toHaveCount(0);
});

async function expectExternalLock(page) {
    await expect(page.locator('.twpf-text-file')).toHaveAttribute('inert', '');
    assert.equal(await page.locator('.twpf-text-file button').evaluateAll(buttons => buttons.every(button => button.disabled)), true);
    await expect(page.locator('.twpf-file-edit .cm-content')).toHaveAttribute('contenteditable', 'false');
    const before = await page.evaluate(() => readSaved());
    await page.evaluate(() => fileSession.save());
    assert.equal(await page.evaluate(() => readSaved()), before);
}

test('external editing locks normal and diff views and imports into the unsaved tab', async t => {
    const external = {};
    const page = await open(t, 'ja', {external});
    await typeContent(page, '{"local": true}');
    await page.getByRole('radio', {name: '差分表示', exact: true}).click();
    await page.getByRole('button', {name: 'VSCodeで編集', exact: true}).click();
    const dialog = page.getByRole('dialog', {name: 'VSCodeで編集中', exact: true});
    await expect(dialog.getByRole('button', {name: '終了して取り込む', exact: true})).toBeEnabled();
    assert.deepEqual(external.opened, {source: '{"local": true}', sourceName: 'project.source.json', format: 'json'});
    await expectExternalLock(page);
    external.source = '{"external": true}';
    await dialog.getByRole('button', {name: '終了して取り込む', exact: true}).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('radio', {name: '通常表示', exact: true})).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('.twpf-file-edit .cm-content')).toHaveText(external.source);
    assert.equal(await page.evaluate(() => readSaved()), content);
    await expect(page.getByRole('button', {name: 'ファイルを保存', exact: true})).toBeEnabled();
    await page.getByRole('button', {name: 'ファイルを保存', exact: true}).click();
    await expect(page.locator('.twpf-file-snackbar')).toHaveText('保存しました');
    assert.equal(await page.evaluate(() => readSaved()), external.source);
    await expect(page.getByRole('button', {name: 'ファイルを保存', exact: true})).toBeDisabled();
    await expect.poll(() => external.closed).toBe(1);
});

test('invalid external text keeps the tab locked until the user finishes without importing', async t => {
    const external = {};
    const page = await open(t, 'ja', {external});
    await page.getByRole('button', {name: 'VSCodeで編集', exact: true}).click();
    const dialog = page.getByRole('dialog', {name: 'VSCodeで編集中', exact: true});
    await expect(dialog.getByRole('button', {name: '終了して取り込む', exact: true})).toBeEnabled();
    external.source = '\0invalid';
    await dialog.getByRole('button', {name: '終了して取り込む', exact: true}).click();
    await expect(dialog).toContainText('外部編集を利用できませんでした');
    await expectExternalLock(page);
    await dialog.getByRole('button', {name: '取り込まずに終了', exact: true}).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('.twpf-text-file')).not.toHaveAttribute('inert');
    await expect(page.locator('.twpf-file-edit .cm-content')).toHaveAttribute('contenteditable', 'true');
    await expect(page.getByRole('button', {name: 'ファイルを保存', exact: true})).toBeDisabled();
    assert.equal(await page.evaluate(() => readSaved()), content);
    await expect.poll(() => external.closed).toBe(1);
});

test('OPFS files round-trip through the real companion with an injected launcher', {
    skip: !process.env.TWPF_COMPANION_HOST
}, async t => {
    const realCompanion = {launches: []};
    const page = await open(t, 'ja', {opfs: true, realCompanion});
    for (const {path: filename, initial, changed} of [
        {path: 'project.source.json', initial: content, changed: '{"opfs": true}\n'},
        {path: 'README.md', initial: '# Original\n', changed: '# Edited in VSCode\n'}
    ]) {
        if (filename !== 'project.source.json') await page.evaluate(args => mountFile(args), {path: filename, content: initial, opfs: true});
        await expect(page.getByRole('button', {name: 'ファイルを保存', exact: true})).toBeDisabled();
        await page.getByRole('button', {name: 'VSCodeで編集', exact: true}).click();
        const finish = page.getByRole('button', {name: '終了して取り込む', exact: true});
        await expect(finish).toBeEnabled();
        await expectExternalLock(page);
        const {file, profile} = realCompanion.launches.at(-1);
        assert.equal(path.basename(file), filename);
        assert.equal(profile.format, filename.endsWith('.json') ? 'json' : 'text');
        assert.equal(await readFile(file, 'utf8'), initial);
        if (process.env.TWPF_TEXT_SCREENSHOT) await page.screenshot({path: `${process.env.TWPF_TEXT_SCREENSHOT}.external.png`});
        await writeFile(file, changed);
        await finish.click();
        await expect(page.getByRole('dialog', {name: 'VSCodeで編集中', exact: true})).toBeHidden();
        await expect(page.getByRole('button', {name: 'ファイルを保存', exact: true})).toBeEnabled();
        assert.equal(await page.evaluate(() => readSaved()), initial);
        await page.getByRole('button', {name: 'ファイルを保存', exact: true}).click();
        await expect(page.locator('.twpf-file-snackbar')).toHaveText('保存しました');
        assert.equal(await page.evaluate(() => readSaved()), changed);
        await expect(page.getByRole('button', {name: 'ファイルを保存', exact: true})).toBeDisabled();
        assert.equal(await readFile(file, 'utf8'), changed);
    }
});

test('successful saves show a snackbar and conflicts keep a persistent error', async t => {
    const page = await open(t);
    await page.clock.install();
    await typeContent(page, '{"edited": true}');
    await page.getByRole('button', {name: 'ファイルを保存', exact: true}).click();
    const snackbar = page.locator('.twpf-file-snackbar');
    await expect(snackbar).toHaveText('保存しました');
    await expect(snackbar).toBeVisible();
    await expect(snackbar).toHaveAttribute('role', 'status');
    if (process.env.TWPF_TEXT_SCREENSHOT) await page.screenshot({path: `${process.env.TWPF_TEXT_SCREENSHOT}.saved.png`});
    // A second save replaces the first notice and restarts its dismissal timer.
    await page.clock.fastForward(3000);
    await typeContent(page, '{"edited": false}');
    await page.getByRole('button', {name: 'ファイルを保存', exact: true}).click();
    await expect(page.locator('.twpf-file-status')).toBeHidden();
    await page.clock.fastForward(1000);
    await expect(snackbar).toBeVisible();
    await typeContent(page, '{"local": true}');
    await page.evaluate(() => writeExternal('{"external": true}'));
    await page.getByRole('button', {name: 'ファイルを保存', exact: true}).click();
    await expect(page.locator('.twpf-file-status')).toContainText('このタブの外で変更されました');
    await expect(snackbar).toBeHidden();
    await page.clock.fastForward(5000);
    await expect(page.locator('.twpf-file-status')).toContainText('このタブの外で変更されました');
    await expect(page.locator('.twpf-file-edit .cm-content')).toHaveText('{"local": true}');
    assert.equal(await page.evaluate(() => readSaved()), '{"external": true}');
    await page.evaluate(() => fileSession.dispose());
    await page.clock.fastForward(5000);
    await expect(snackbar).toHaveCount(0);
});

test('the minimap recovers after a hidden tab and handles empty and long single-line files', async t => {
    const page = await open(t);
    const minimap = page.getByRole('slider');
    await page.evaluate(() => document.getElementById('root').style.display = 'none');
    await page.evaluate(() => replaceContent(''));
    await page.evaluate(() => document.getElementById('root').style.display = 'block');
    await expect(minimap).toHaveAttribute('aria-valuemax', '1');
    await expect(minimap).toHaveAttribute('aria-valuenow', '1');
    await expect.poll(() => page.locator('.twpf-text-minimap-viewport').evaluate(node => node.style.height)).toBe('100%');
    await page.evaluate(() => replaceContent(JSON.stringify({data: 'a'.repeat(1024 * 1024)})));
    await expect(minimap).toHaveAttribute('aria-valuemax', '1');
    await minimap.press('End');
    await expect(minimap).toHaveAttribute('aria-valuenow', '1');
    await expect(page.getByRole('button', {name: 'ファイルを保存', exact: true})).toBeEnabled();
    await page.evaluate(() => fileSession.dispose());
    await expect(minimap).toHaveCount(0);
});
