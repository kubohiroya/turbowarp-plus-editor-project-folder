# TurboWarp Plus Editor Project Folder

[日本語](README.ja.md)

This package opens and saves existing sb3-toolchain v1 project folders in TurboWarp Plus Editor. It loads the project JSON and local image and audio assets directly from a directory handle. Saving updates `project.source.json` in the selected folder and checks the source for external changes before writing.

## Integration

- `mountProjectFolder({vm, document, host})` attaches the folder session to a workspace. Call `dispose()` when the workspace is replaced.
- `renderProjectFolderMenu(createElement, props)` supplies the existing open and save commands to the host's file menu.
- The mounted session's `openDirectory(handle, confirmReplace)` accepts a directory handle already selected by the host. It uses the same project validation and unsaved-edit confirmation as the file menu. Save still targets the opened folder.

The host supplies the VM, menu components, and project state callbacks. The browser must support the File System Access picker for the built-in open command. This prototype supports standard block edits in existing projects. See [Editor issue #305](https://github.com/kubohiroya/turbowarp-plus-editor/issues/305) and [issue #308](https://github.com/kubohiroya/turbowarp-plus-editor/issues/308).

## Development

Use Node.js 26, then run `npm ci` and `npm test`. Vite builds the JavaScript library, and TypeScript emits the declarations. `npm pack` creates a tarball for host integration checks.

The Editor's headless integration test uses an actual disk directory and substitutes the picker interaction. To verify the native picker separately, open a disposable sb3-toolchain v1 project with **File → Open Project Folder…**, accept read/write access, edit a standard block, and select **File → Save to Project Folder**. Check that `project.source.json` changed in the chosen directory and reopen the same folder to confirm the edit.
