const messages = {
    en: {title: 'Cannot Open Folder', notProject: 'This folder is not a project folder.', ok: 'OK'},
    ja: {title: 'フォルダを開けません', notProject: 'このフォルダはプロジェクトフォルダではありません。', ok: 'OK'}
};

let dialogs = 0;

/** The message the dialog shows, for a host that tells the user in its own way. */
export const notProjectFolderMessage = (locale = 'en') => (locale.startsWith('ja') ? messages.ja : messages.en).notProject;

/**
 * Tells the user, in a modal dialog, that the folder they tried to open is not a project folder. Resolves when the
 * dialog closes, after the focus went back to where it was.
 */
export async function showNotProjectFolderDialog({document, locale = 'en'}: {document: Document; locale?: string}): Promise<void> {
    const message = locale.startsWith('ja') ? messages.ja : messages.en;
    const returnFocus = document.activeElement as HTMLElement | null;
    const id = `tw-plus-project-folder-error-${++dialogs}`;
    const dialog = document.createElement('dialog');
    dialog.dataset.projectFolderError = 'not-project';
    dialog.setAttribute('role', 'alertdialog');
    dialog.setAttribute('aria-labelledby', `${id}-title`);
    dialog.setAttribute('aria-describedby', `${id}-message`);
    Object.assign(dialog.style, {
        width: 'min(26rem, calc(100vw - 2rem))', padding: '1rem 1.25rem', background: 'Canvas', color: 'CanvasText',
        border: '1px solid GrayText', borderRadius: '0.5rem', fontFamily: 'inherit', fontSize: '0.875rem', boxSizing: 'border-box'
    });
    const heading = document.createElement('h2');
    heading.id = `${id}-title`;
    heading.textContent = message.title;
    Object.assign(heading.style, {margin: '0 0 0.5rem', fontSize: '1rem'});
    const text = document.createElement('p');
    text.id = `${id}-message`;
    text.textContent = message.notProject;
    Object.assign(text.style, {margin: '0 0 1rem'});
    const footer = document.createElement('div');
    Object.assign(footer.style, {display: 'flex', justifyContent: 'flex-end'});
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.textContent = message.ok;
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
