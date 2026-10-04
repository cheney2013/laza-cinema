<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="frontend/public/laza-logo.svg">
    <img src="frontend/public/laza-logo-light.svg" alt="LAZA CINEMA STUDIO" width="420">
  </picture>
</p>

<p align="center"><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <b>日本語</b></p>

<p align="center">動画・画像・音声の生成と編集を、1 枚の無限キャンバスにまとめます。</p>

LAZA CINEMA STUDIO は、手元のマシンで動く映像制作スタジオです。キャンバス上でノードをつないでショットを組み立てると、バックエンドがそれを ComfyUI のワークフローに変換し、お使いの GPU でレンダリングします。キャンバスがプロジェクトの唯一の記録で、プロンプト、参照画像の順序、シード、各レンダリング結果はすべてノードに残ります。

現在のバージョンは [`VERSION`](VERSION) を参照してください。このリポジトリに入っているのは**プラットフォーム**（キャンバス、カット編集室、バックエンド、MCP）だけです。作品の内容（プロンプト、絵コンテ、素材）とモデルの重みファイルは含まれていません。

## できること

- **動画生成**: MiniMax H3。参照画像からの動画（Ref2VA）、最初と最後のフレーム指定、テキストからの動画に対応し、ショット間をつないで続きを生成できます。
- **画像の生成と編集**: Qwen-Image 2.1。画像を入力しなければテキストから画像を、入力すればその画像を編集します。
- **アップスケールとフレーム補間**: 動画のアップスケール（H3 潜在空間アップスケーラー）、画像のアップスケール、RIFE によるフレーム補間。
- **映像の加工**: 動画のトリミングと編集ウィンドウ、衣装の入れ替え、人物の入れ替え、ポーズ、アングル変更、深度動画（Depth Anything V2。カメラワークの参照にも使えます）。
- **音声**: 音声の生成と仕上げ、声のロック。
- **カット編集室**: キャンバス上のクリップをタイムラインに並べ、つなぎ目を調整します。
- **MCP インターフェース**: AI アシスタントがキャンバス MCP を通してプロジェクトを読み書きでき、レンダリング結果もキャンバスに書き戻されます。

## 動作環境

| 項目 | 要件 |
|---|---|
| OS | Windows 10/11（起動スクリプトは PowerShell） |
| GPU | NVIDIA、VRAM 16 GB 以上。RTX 50 シリーズと 40 シリーズ。**40 シリーズは実機で動かしておらず、5090 でのみテストしています** |
| メモリ | 32 GB、ページファイルは 32 GB 以上 |
| ディスク | 空き 100 GB 以上 |
| ソフトウェア | Python 3.12、Node.js 20 以上、Git、PATH にある ffmpeg と ffprobe、ComfyUI |

VRAM が 30 GB 以上のマシンでは `H3_MACHINE_PROFILE` を `workstation`（または `auto` のまま）にすると全機能が使えます。16 GB のマシンは自動的に低 VRAM 設定に切り替わります。

## クイックスタート

詳しい手順（ComfyUI のインストール、ノードパック、モデルファイル、トラブルシューティング）は **[docs/DEPLOY.md](docs/DEPLOY.md)**、モデルファイルの一覧は [docs/H3_WEIGHTS.md](docs/H3_WEIGHTS.md) にあります。どちらも現時点では**中国語のみ**です。手順の流れは次のとおりです。

```powershell
# 1. ComfyUI とカスタムノードを入れる（ワンショットスクリプト、DEPLOY.md の第 2・3 節）
python tools\install_comfyui_nodes.py --comfyui C:\ComfyUI

# 2. モデルの重みを ComfyUI\models に置く（DEPLOY.md の第 4 節）

# 3. このプロジェクトを設定して起動する
copy .env.example .env
.\start.ps1

# 4. 環境を確認する
python tools\check_install.py
```

起動後のアドレス:

| コンポーネント | アドレス |
|---|---|
| フロントエンド（キャンバス） | http://127.0.0.1:4000 |
| バックエンド API | http://127.0.0.1:8003 |
| ComfyUI | http://127.0.0.1:8188 |
| キャンバス MCP（任意） | http://127.0.0.1:8004 |

バックエンドの `GET /version` はバージョンとコミットを返します。画面のバージョン表示も同じ値を読んでいます。

## AI エージェントをつなぐ（キャンバス MCP）

キャンバス MCP サーバーを使うと、AI エージェント（たとえば Claude Code）がプロジェクトを読み書きできます。`start.ps1` がポート 8004 の `/mcp` で起動します。初回は `backend/requirements-mcp.txt` から専用の仮想環境 `backend/.venv-mcp` を作ります（バックエンドより新しい pydantic が必要なためです）。

1. トークンを作ります（ランダムな文字列で十分です。登録する場所はありません）。**同じ値**を 2 か所で使います。

   ```powershell
   python -c "import secrets; print(secrets.token_urlsafe(32))"
   ```

   - サーバー側: `.env` に `AI_CINEMA_MCP_TOKEN=<値>` を書き、`.\restart-mcp.ps1` と `.\restart-backend.ps1` を実行
   - クライアント側: `setx AI_CINEMA_MCP_TOKEN "<値>"` を実行し、ターミナルを開き直す
2. クライアントにサーバーを登録します。`.mcp.json.example` を `.mcp.json` にコピーするか、次のコマンドを使います。

   ```powershell
   claude mcp add --transport http ai-cinema-canvas http://127.0.0.1:8004/mcp --header "Authorization: Bearer <値>"
   ```
3. 動作確認: ヘッダーなしのリクエストは 401 を返すはずです。

   ```powershell
   curl.exe -s -o NUL -w "%{http_code}" -X POST http://127.0.0.1:8004/mcp -H "Content-Type: application/json" -d "{}"
   ```

エージェントの使い方（サーバー自身の説明にも書かれています）:

- まず `get_canvas(summary=True)` で読みます。1 つのノードを全文で見るには `node_ids=[...]` を渡します。
- 変更は `apply_canvas_operations` だけで行い、レンダリングは `run_canvas_node` のあと `refresh_canvas_node` を呼びます。ComfyUI に直接レンダリングを投げないでください。キャンバスが記録でなくなります。
- ノードにつながるエッジの順序が、そのまま `<Picture N>` の番号です。`get_node_catalog` でノードの種類とフィールドが分かります。
- トークンを設定しないとサーバーはすべてのリクエストを受け付けます。他の人が到達できないマシンでのみそうしてください。詳細は [docs/DEPLOY.md](docs/DEPLOY.md) の第 8 節（中国語）にあります。

## リポジトリ構成

```
frontend/        Next.js のキャンバスとカット編集室
backend/         FastAPI バックエンド、ワークフロービルダー、キャンバス MCP
comfyui_nodes/   このプロジェクト自作の ComfyUI ノードと、third_party/ に同梱したサードパーティのノードパック
tools/           インストール確認、ノードインストーラー、品質チェックスクリプト
docs/            デプロイ手順、重みファイル一覧
```

## 補足

- モデルの重みはリポジトリに含まれていません。入手元とファイル名は [docs/H3_WEIGHTS.md](docs/H3_WEIGHTS.md) と DEPLOY.md にあります。
- `comfyui_nodes/third_party/` のノードパックはそれぞれの作者のもので、元のファイルのまま入っています。使う前に各パックの説明を確認してください。
- このプロジェクトは非商用での利用を前提としています。
- まっさらなマシンでの最初から最後までのインストールは、まだ通しで試していません。DEPLOY.md に未検証の手順を明記しています。問題があれば issue を立ててください。
