# Editor独自実装の移管記録


## 残存実装の責務移管（0.22.2）

- 調査・移管元: `kubohiroya/turbowarp-plus-editor@6d2c73199de2b9ff76e27c516f7d2354605a9ed8`
- 元ファイル: `site/project-folder-host.ts`
- 担当: 作品フォルダのスナップショット操作。展開後の作品同一性、欠落ファイルの確認、フォルダ作成・コピーとキャンセル。
- 公開口: `./snapshot-workflows`。新しいパッケージは作らない。
- Editorには固定版、配布先URL・カタログ・制限値、実際のVM/Renderer/Packagerコンストラクター、GUI Redux/Desktop preloadの値とコールバックだけを残す。
- 元ファイル追加の著者はHiroya Kubo。移管対象はPlus独自部分で、著作権者によるMPL-2.0提供の明示承認を適用する。本家GUIのコンポーネント・Redux実装は移さない。ソースのSPDXを保持する。
- 既定の有効/無効、SB3/フォルダ/転送の形式、信頼カタログは変更しない。
- 受け入れ条件: この公開口と対象テストのビルド・型検査、変更ガード/取消/破棄とEditorの接続を確認する。
- 切り戻し: Editorの前の依存固定とアダプターを一緒に戻す。単独でアダプターだけを戻さない。上流APIは追加のため、既存consumerは以前の公開口を継続できる。
- 0.22.2 として公開する。作業と依存順は [Editor #875](https://github.com/kubohiroya/turbowarp-plus-editor/issues/875) に記録する。Workbenchは新しいGit/Project Folderの公開APIに対応する最低版を固定する。
