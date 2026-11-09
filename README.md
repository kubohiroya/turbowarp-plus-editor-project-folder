# TurboWarp Plus Editor Project Folder

[日本語](README.ja.md)

This package opens and saves existing sb3-toolchain v1 project folders in TurboWarp Plus Editor. It loads the project JSON and local image and audio assets directly from a directory handle. Saving updates `project.source.json` in the selected folder and checks the source for external changes before writing.

## Integration

- `mountProjectFolder({vm, document, host})` attaches the folder session to a workspace. Call `dispose()` when the workspace is replaced.
- `renderProjectFolderMenu(createElement, props)` supplies the existing open and save commands to the host's file menu.
- The mounted session's `openDirectory(handle, confirmReplace)` accepts a directory handle already selected by the host. It uses the same project validation and unsaved-edit confirmation as the file menu. Save still targets the opened folder.

The host supplies the VM, menu components, and project state callbacks. The browser must support the File System Access picker for the built-in open command. This prototype supports standard block edits in existing projects. See [Editor issue #305](https://github.com/kubohiroya/turbowarp-plus-editor/issues/305) and [issue #308](https://github.com/kubohiroya/turbowarp-plus-editor/issues/308).

## External changes

When the host passes `host.blockReload`, the package checks the open folder every two seconds while the page is visible, when the window regains focus, and on `FileSystemObserver` notifications where the browser supports them. A notice appears when the folder changed outside the Editor.

| Editor state | Behavior |
| --- | --- |
| No unsaved edits, project stopped | Changes to values and positions of existing blocks are applied in place once the file has stayed the same across two checks. |
| Project running | The change is held. Value and position changes apply when the project stops. |
| Unsaved edits | The edits are kept. **Discard Edits and Reload…** asks before replacing them with the folder contents. |
| Other changes to the project JSON, assets, the manifest or extensions | **Reload Whole Project** reads the folder again with the same checks as opening it. This is never automatic. |
| Incomplete write, such as truncated JSON | The notice waits and the folder is checked again shortly. |

Pass `autoReload: false` to `mountProjectFolder` to keep every reload behind the button. Checks compare file size and modification time before reading contents, so an overwrite that keeps both unchanged is not detected. Saving still compares the bytes on disk and refuses to overwrite a folder that changed.

## Development

Use Node.js 26, then run `npm ci` and `npm test`. Vite builds the JavaScript library, and TypeScript emits the declarations. `npm pack` creates a tarball for host integration checks.

The Editor's headless integration test uses an actual disk directory and substitutes the picker interaction. To verify the native picker separately, open a disposable sb3-toolchain v1 project with **File → Open Project Folder…**, accept read/write access, edit a standard block, and select **File → Save to Project Folder**. Check that `project.source.json` changed in the chosen directory and reopen the same folder to confirm the edit.

The initial source was extracted from [TurboWarp Plus Editor at d14d065](https://github.com/kubohiroya/turbowarp-plus-editor/tree/d14d0659f77f37328c855ecfeeae0927d81ae81a/packages/editor-project-folder) under MPL-2.0.
