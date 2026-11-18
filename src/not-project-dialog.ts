const messages = {
    en: {title: 'Cannot Open Folder', notProject: 'This folder is not a project folder.',
        notEmptyTitle: 'Cannot Use This Folder', notEmpty: 'Choose an empty folder.', ok: 'OK'},
    ja: {title: 'フォルダを開けません', notProject: 'このフォルダはプロジェクトフォルダではありません。',
        notEmptyTitle: 'このフォルダは使えません', notEmpty: '空のフォルダを選んでください。', ok: 'OK'}
};

let dialogs = 0;

/** The message the dialog shows, for a host that tells the user in its own way. */
export const notProjectFolderMessage = (locale = 'en') => (locale.startsWith('ja') ? messages.ja : messages.en).notProject;

/**
 * Tells the user, in a modal dialog, that the folder they tried to open is not a project folder. Resolves when the
 * dialog closes, after the focus went back to where it was.
 */
export function showNotProjectFolderDialog({document, locale = 'en'}: {document: Document; locale?: string}): Promise<void> {
    const message = locale.startsWith('ja') ? messages.ja : messages.en;
    return showFolderErrorDialog(document, 'not-project', message.title, message.notProject, message.ok);
}

/** The message of the dialog for a folder that is not empty. */
export const folderNotEmptyMessage = (locale = 'en') => (locale.startsWith('ja') ? messages.ja : messages.en).notEmpty;

/**
 * Tells the user, in the same modal dialog, that the folder they chose for a new project is not empty. Resolves when
 * the dialog closes.
 */
export function showFolderNotEmptyDialog({document, locale = 'en'}: {document: Document; locale?: string}): Promise<void> {
    const message = locale.startsWith('ja') ? messages.ja : messages.en;
    return showFolderErrorDialog(document, 'not-empty', message.notEmptyTitle, message.notEmpty, message.ok);
}

async function showFolderErrorDialog(document: Document, kind: string, title: string, body: string, okLabel: string) {
    const returnFocus = document.activeElement as HTMLElement | null;
    const id = `tw-plus-project-folder-error-${++dialogs}`;
    const dialog = document.createElement('dialog');
    dialog.dataset.projectFolderError = kind;
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-labelledby', `${id}-title`);
    dialog.setAttribute('aria-describedby', `${id}-message`);
    Object.assign(dialog.style, {
        width: 'min(26rem, calc(100vw - 2rem))', padding: '1rem 1.25rem', background: 'Canvas', color: 'CanvasText',
        border: '1px solid GrayText', borderRadius: '0.5rem', fontFamily: 'inherit', fontSize: '0.875rem', boxSizing: 'border-box'
    });
    const heading = document.createElement('h2');
    heading.id = `${id}-title`;
    heading.textContent = title;
    Object.assign(heading.style, {margin: '0 0 0.5rem', fontSize: '1rem'});
    const text = document.createElement('p');
    text.id = `${id}-message`;
    text.textContent = body;
    Object.assign(text.style, {margin: '0 0 1rem'});
    const footer = document.createElement('div');
    Object.assign(footer.style, {display: 'flex', justifyContent: 'flex-end'});
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.textContent = okLabel;
    footer.append(ok);
    dialog.append(heading, text, footer);
    await new Promise<void>(resolve => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            if (dialog.open) dialog.close();
            dialog.remove();
            if (returnFocus?.isConnected && typeof returnFocus.focus === 'function') returnFocus.focus();
            resolve();
        };
        ok.addEventListener('click', finish);
        dialog.addEventListener('cancel', event => {
            event.preventDefault();
            finish();
        });
        dialog.addEventListener('close', finish);
        document.body.append(dialog);
        dialog.showModal();
        ok.focus();
    });
}
