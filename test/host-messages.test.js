import assert from 'node:assert/strict';
import {test} from 'node:test';
import {folderNotEmptyMessage, omittedFilesQuestion, openRepositoryProjectQuestion, openSavedFolderQuestion}
    from '../dist/index.js';
import {explorerSearchLabel} from '../dist/explorer.js';

test('the omitted files question lists at most six paths and marks the rest', () => {
    const paths = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    assert.equal(omittedFilesQuestion('en', paths),
        'Unreferenced files will be omitted from the new project folder. Save the folder?\n\na\nb\nc\nd\ne\nf\n…');
    assert.equal(omittedFilesQuestion('ja', ['x']),
        '作品から参照されていないファイルは新しいフォルダに入りません。保存しますか？\n\nx');
});

test('the host questions and labels follow the locale', () => {
    assert.match(openSavedFolderQuestion('ja-JP'), /保存済みの作品フォルダを開きますか/);
    assert.match(openSavedFolderQuestion(undefined), /Open the saved project folder\?/);
    assert.match(openRepositoryProjectQuestion('ja'), /リポジトリの作品を開きますか/);
    assert.match(openRepositoryProjectQuestion('en'), /Open the repository's project\?/);
    assert.equal(folderNotEmptyMessage('ja'), '空のフォルダを選んでください。');
    assert.equal(explorerSearchLabel('ja'), '作品のファイルを検索');
    assert.equal(explorerSearchLabel(), 'Search project files');
    // "jav" is not Japanese.
    assert.equal(explorerSearchLabel('jav'), 'Search project files');
});
