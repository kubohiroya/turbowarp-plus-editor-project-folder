/**
 * The questions a host asks with its own `confirm()` while it opens or creates project folders.
 * The host decides how to ask; the wording belongs to the project folder feature.
 */

const ja = (locale: string | undefined) => /^ja(?:-|$)/i.test(locale || '');

/** How many omitted paths the question lists before it shortens the list. */
const LISTED_PATHS = 6;

/**
 * Asks whether to save a new project folder that leaves out files the project does not refer to.
 * @param paths The files left out, in the order the unpacker reported them.
 */
export function omittedFilesQuestion(locale: string | undefined, paths: readonly string[]) {
    const list = paths.slice(0, LISTED_PATHS).join('\n') + (paths.length > LISTED_PATHS ? '\n…' : '');
    return (ja(locale) ?
        '作品から参照されていないファイルは新しいフォルダに入りません。保存しますか？' :
        'Unreferenced files will be omitted from the new project folder. Save the folder?') + '\n\n' + list;
}

/** Asks whether to replace a project with unsaved changes by the project folder just saved. */
export const openSavedFolderQuestion = (locale: string | undefined) => ja(locale) ?
    '現在の作品に未保存の変更があります。保存済みの作品フォルダを開きますか？' :
    'The current project has unsaved changes. Open the saved project folder?';

/** Asks whether to replace a project with unsaved changes by the project of a repository. */
export const openRepositoryProjectQuestion = (locale: string | undefined) => ja(locale) ?
    '現在の作品に未保存の変更があります。リポジトリの作品を開きますか？' :
    'The current project has unsaved changes. Open the repository\'s project?';
