import * as React from 'react';
import {createPortal} from 'react-dom';

export const actionMessages = (locale = 'en') => locale.toLowerCase().startsWith('ja') ? {
    actions: 'ファイルとフォルダの操作', rename: '名前を変更…', renameTitle: '名前を変更', delete: '削除…', deleteTitle: '削除',
    newName: '新しい名前', cancel: 'キャンセル',
    remove: (name: string, folder: boolean) => folder ? `「${name}」とその中身を削除しますか？` : `「${name}」を削除しますか？`,
    stage: 'Git にステージ', unstage: 'Git のステージを解除',
    working: '処理中…', copyFailed: 'コピーできませんでした', filesOnly: 'ファイルをドロップしてください。',
    invalidName: 'この名前は使用できません。', exists: '同じ名前のファイルまたはフォルダがあります。',
    denied: 'このフォルダへの書き込みが許可されていません。', conflict: 'プロジェクトフォルダが変更されたか、別の操作が実行中です。',
    sourceChanged: '操作中に対象が変更されました。', originalKept: '元の項目を削除できなかったため、コピーを残しました。',
    cleanupFailed: '失敗したコピーを削除できませんでした。', failed: '操作を完了できませんでした。'
} : {
    actions: 'File and folder actions', rename: 'Rename…', renameTitle: 'Rename', delete: 'Delete…', deleteTitle: 'Delete',
    newName: 'New name', cancel: 'Cancel',
    remove: (name: string, folder: boolean) => folder ? `Delete “${name}” and its contents?` : `Delete “${name}”?`,
    stage: 'Stage in Git', unstage: 'Unstage in Git',
    working: 'Working…', copyFailed: 'Could not copy', filesOnly: 'Drop files here.',
    invalidName: 'This name cannot be used.', exists: 'A file or folder with this name already exists.',
    denied: 'Permission to write to this folder was not granted.', conflict: 'The project folder changed or another operation is running.',
    sourceChanged: 'The item changed during the operation.', originalKept: 'The original could not be removed, so the copy was kept.',
    cleanupFailed: 'The incomplete copy could not be removed.', failed: 'The operation could not be completed.'
};

export type ActionMessages = ReturnType<typeof actionMessages>;
export type MenuAnchor = {row: HTMLButtonElement; x: number; y: number};

export const actionCss = `
.twpf-explorer-actions{position:fixed;z-index:2147483647;max-width:calc(100vw - 8px);padding:4px;
border:1px solid GrayText;border-radius:5px;background:Canvas;color:CanvasText;box-shadow:0 2px 8px #0004}
.twpf-explorer-actions button{display:block;width:100%;border:0;padding:.35em .65em;text-align:start;background:Canvas;color:CanvasText;
font:inherit;cursor:pointer;border-radius:3px}
.twpf-explorer-actions button:is(:hover,:focus-visible){background:Highlight;color:HighlightText}
.twpf-explorer-dialog{max-width:min(28em,calc(100vw - 2em));color:CanvasText;background:Canvas;
border:1px solid GrayText;border-radius:6px;padding:1em;overflow-wrap:anywhere}
.twpf-explorer-dialog::backdrop{background:#0006}
.twpf-explorer-dialog h2{font-size:1.1em;margin:0 0 .75em}
.twpf-explorer-dialog input{display:block;width:100%;box-sizing:border-box;margin-top:.3em}
.twpf-explorer-dialog-footer{display:flex;justify-content:flex-end;gap:.5em;margin-top:1em}
.twpf-explorer-drop{min-height:100%;box-sizing:border-box}
.twpf-explorer [data-drop-active],.twpf-explorer[data-drop-active]{outline:2px solid Highlight;outline-offset:-2px}
.twpf-explorer-feedback{white-space:pre-wrap;overflow-wrap:anywhere;padding:.25em .5em}
`;

export function ExplorerMenu({anchor, label, actions, close}: {
    anchor: MenuAnchor; label: string; actions: readonly {label: string; run(): void}[]; close(restoreFocus: boolean): void;
}) {
    const ref = React.useRef<HTMLDivElement>(null);
    const document = anchor.row.ownerDocument;
    React.useLayoutEffect(() => {
        const menu = ref.current!;
        const {width, height} = menu.getBoundingClientRect();
        menu.style.left = `${Math.max(4, Math.min(anchor.x, document.documentElement.clientWidth - width - 4))}px`;
        menu.style.top = `${Math.max(4, Math.min(anchor.y, document.documentElement.clientHeight - height - 4))}px`;
        menu.querySelector('button')?.focus();
        const outside = (event: Event) => {
            if (!menu.contains(event.target as Node)) close(false);
        };
        document.addEventListener('pointerdown', outside, true);
        document.addEventListener('focusin', outside, true);
        return () => {
            document.removeEventListener('pointerdown', outside, true);
            document.removeEventListener('focusin', outside, true);
        };
    }, [anchor]);
    return createPortal(<div ref={ref} role="menu" aria-label={label} className="twpf-explorer-actions"
        onKeyDown={event => {
            if (event.key === 'Tab') {close(true); return;}
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                close(true);
                return;
            }
            const buttons = Array.from(event.currentTarget.querySelectorAll('button'));
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const next = {ArrowDown: (index + 1) % buttons.length, ArrowUp: (index + buttons.length - 1) % buttons.length,
                Home: 0, End: buttons.length - 1}[event.key];
            if (next === undefined) return;
            event.preventDefault();
            event.stopPropagation();
            buttons[next]?.focus();
        }}>
        {actions.map(action => <button key={action.label} type="button" role="menuitem" tabIndex={-1}
            onClick={action.run}>{action.label}</button>)}
    </div>, document.body);
}

export function ExplorerFileDialog({anchor, name, folder, rename, message, close, submit}: {
    anchor: MenuAnchor; name: string; folder: boolean; rename: boolean; message: ActionMessages;
    close(): void; submit(name: string): void;
}) {
    const ref = React.useRef<HTMLDialogElement>(null);
    const input = React.useRef<HTMLInputElement>(null);
    const cancel = React.useRef<HTMLButtonElement>(null);
    const title = rename ? message.renameTitle : message.deleteTitle;
    React.useLayoutEffect(() => {
        const dialog = ref.current!;
        dialog.showModal();
        if (input.current) {input.current.focus(); input.current.select();}
        else cancel.current?.focus();
        return () => {
            dialog.close();
            if (anchor.row.isConnected) anchor.row.focus({preventScroll: true});
        };
    }, []);
    return createPortal(<dialog ref={ref} aria-label={title} className="twpf-explorer-dialog" onCancel={event => {
        event.preventDefault();
        close();
    }}>
        <form onSubmit={event => {
            event.preventDefault();
            submit(input.current?.value ?? name);
        }}>
            <h2>{title}</h2>
            {rename ? <label>{message.newName}<input ref={input} defaultValue={name} required /></label> :
                <p>{message.remove(name, folder)}</p>}
            <div className="twpf-explorer-dialog-footer">
                <button ref={cancel} type="button" onClick={close}>{message.cancel}</button>
                <button type="submit">{title}</button>
            </div>
        </form>
    </dialog>, anchor.row.ownerDocument.body);
}
