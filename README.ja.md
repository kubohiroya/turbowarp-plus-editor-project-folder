# TurboWarp Plus Editor Project Folder

[English](README.md)

TurboWarp Plus Editor で既存の sb3-toolchain v1 の作品フォルダを開き、保存するパッケージです。ディレクトリハンドルから作品 JSON とローカルの画像・音声を読み込みます。保存時は外部変更を確認してから、選んだフォルダの `project.source.json` を更新します。

## 接続

- `mountProjectFolder({vm, document, host})` でワークスペースに接続します。ワークスペースの切り替え時には `dispose()` を呼びます。
- `renderProjectFolderMenu(createElement, props)` は既存の開く・保存コマンドをホストのファイルメニューに渡します。
- 接続後の `openDirectory(handle, confirmReplace)` には、ホストが選択済みのディレクトリハンドルを渡せます。ファイルメニューと同じ作品検証・未保存編集の確認を経て開き、保存先にはその作品フォルダを使います。

ホストは VM、メニューコンポーネント、作品状態を扱うコールバックを渡します。メニューからフォルダを開くには、ブラウザーが File System Access のフォルダ選択に対応している必要があります。試作段階では既存作品の標準ブロック編集を扱います。 [Editor #305](https://github.com/kubohiroya/turbowarp-plus-editor/issues/305) · [Editor #308](https://github.com/kubohiroya/turbowarp-plus-editor/issues/308)

## 外部変更

ホストが `host.blockReload` を渡すと、表示中は 2 秒ごと、ウィンドウにフォーカスが戻ったとき、ブラウザーが対応していれば `FileSystemObserver` の通知で、開いているフォルダを確認します。Editor の外でフォルダが変わると通知を表示します。

| Editor の状態 | 動作 |
| --- | --- |
| 未保存編集なし・実行停止中 | 既存ブロックの値と座標の変更は、2 回の確認でファイルが変わらなければその場で反映します。 |
| 作品の実行中 | 反映を保留します。値と座標の変更は停止後に反映します。 |
| 未保存編集あり | 編集を保持します。**編集を破棄して再読み込み…** は確認してからフォルダの内容に置き換えます。 |
| 作品 JSON のその他の変更、アセット・マニフェスト・拡張機能の変更 | **作品全体を再読み込み** で、開くときと同じ検証を経てフォルダを読み直します。自動では行いません。 |
| JSON の途中など書き込み途中 | 更新待ちを表示し、間を置かずに再確認します。 |

`mountProjectFolder` に `autoReload: false` を渡すと、すべての反映をボタン操作にします。確認はファイルの内容を読む前にサイズと更新時刻を比べるため、両方が変わらない上書きは検出できません。保存時はディスクのバイト列を照合し、変更されたフォルダへの上書きを拒否します。

## 開発

Node.js 26 で `npm ci` と `npm test` を実行します。Vite で JavaScript、TypeScript で型宣言を生成します。ホストとの接続検証には `npm pack` で作る tarball を使います。

Editor のヘッドレス統合テストは実ディスク上のフォルダを使い、選択画面の操作を差し替えます。OS のフォルダ選択画面を確認するときは、使い捨ての sb3-toolchain v1 作品を **ファイル → プロジェクトフォルダを開く…** から選び、読み書きを許可します。標準ブロックを変更し、**ファイル → プロジェクトフォルダに保存** を選びます。選んだフォルダの `project.source.json` が更新されたことを確かめ、同じフォルダを開き直して編集が反映されることを確認します。

初期実装は MPL-2.0 の [TurboWarp Plus Editor d14d065](https://github.com/kubohiroya/turbowarp-plus-editor/tree/d14d0659f77f37328c855ecfeeae0927d81ae81a/packages/editor-project-folder) から分離しました。
