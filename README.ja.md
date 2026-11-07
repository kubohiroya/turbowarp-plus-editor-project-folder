# TurboWarp Plus Editor Project Folder

[English](README.md)

TurboWarp Plus Editor で既存の sb3-toolchain v1 の作品フォルダを開き、保存するパッケージです。ディレクトリハンドルから作品 JSON とローカルの画像・音声を読み込みます。保存時は外部変更を確認してから、選んだフォルダの `project.source.json` を更新します。

## 接続

- `mountProjectFolder({vm, document, host})` でワークスペースに接続します。ワークスペースの切り替え時には `dispose()` を呼びます。
- `renderProjectFolderMenu(createElement, props)` は既存の開く・保存コマンドをホストのファイルメニューに渡します。
- 接続後の `openDirectory(handle, confirmReplace)` には、ホストが選択済みのディレクトリハンドルを渡せます。ファイルメニューと同じ作品検証・未保存編集の確認を経て開き、保存先にはその作品フォルダを使います。

ホストは VM、メニューコンポーネント、作品状態を扱うコールバックを渡します。メニューからフォルダを開くには、ブラウザーが File System Access のフォルダ選択に対応している必要があります。試作段階では既存作品の標準ブロック編集を扱います。 [Editor #305](https://github.com/kubohiroya/turbowarp-plus-editor/issues/305) · [Editor #308](https://github.com/kubohiroya/turbowarp-plus-editor/issues/308)

## 開発

Node.js 26 で `npm ci` と `npm test` を実行します。Vite で JavaScript、TypeScript で型宣言を生成します。ホストとの接続検証には `npm pack` で作る tarball を使います。

Editor のヘッドレス統合テストは実ディスク上のフォルダを使い、選択画面の操作を差し替えます。OS のフォルダ選択画面を確認するときは、使い捨ての sb3-toolchain v1 作品を **ファイル → プロジェクトフォルダを開く…** から選び、読み書きを許可します。標準ブロックを変更し、**ファイル → プロジェクトフォルダに保存** を選びます。選んだフォルダの `project.source.json` が更新されたことを確かめ、同じフォルダを開き直して編集が反映されることを確認します。

初期実装は MPL-2.0 の [TurboWarp Plus Editor d14d065](https://github.com/kubohiroya/turbowarp-plus-editor/tree/d14d0659f77f37328c855ecfeeae0927d81ae81a/packages/editor-project-folder) から分離しました。
