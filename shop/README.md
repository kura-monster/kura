# Kura Web - Member Shop

## Overview
Discord raid organization "Kura" のメンバー向けショップサイト。Discord OAuth2認証でログインし、MongoDBで管理される`money`で商品を購入できます。

## 技術スタック
- **フロントエンド**: GitHub Pages（静的HTML）
- **認証・API**: Cloudflare Workers
- **データベース**: MongoDB Atlas
- **認証プロバイダ**: Discord OAuth2

## ファイル構成

```
kura_web/
├── index.html          # メインサイト（既存）
├── auth.html           # ログインページ
├── shop.html           # ショップページ
└── js/
    ├── config.js       # ワーカーURL設定（差し替え必須）
    └── auth.js         # 認証ヘルパー
```

```
kura_web/worker/
├── index.js            # Cloudflare Workersメインコード
├── wrangler.toml       # Workers設定（差し替え必須）
└── setup-db.js         # MongoDBインデックス作成スクリプト
```

## セットアップ手順

### 1. Cloudflare Workersの設定

```bash
cd worker
npm install mongodb
```

`wrangler.toml`を編集してください：
- `SITE_ORIGIN`: GitHub PagesのURL（例: `https://yuto0926space.github.io/kura_web`）
- `REDIRECT_URI`: Discord Developer Portalに登録するコールバックURL

### 2. Secretsの設定

```bash
cd worker
wrangler secret put MONGODB_URI
wrangler secret put DISCORD_CLIENT_ID
wrangler secret put DISCORD_CLIENT_SECRET
wrangler secret put SESSION_SECRET
```

### 3. Discord OAuthの設定

Discord Developer Portalで：
1. OAuth2 → URL Generator → `identify`スコープを選択
2. Redirectsに`REDIRECT_URI`を登録
3. `CLIENT_ID`と`CLIENT_SECRET`を取得

### 4. MongoDBの準備

```bash
MONGODB_URI="your_connection_string" node setup-db.js
```

**コレクション構造**:
- `users`: `{ userid, username, money }` - botと共有（同一MongoDB）
- `products`: `{ id, name, description, price, type, seller_id, seller_name, seller_icon }`
- `purchases`: `{ userid, product_id, type, created_at }` - botがポーリングして処理

### 5. 商品データの登録

`products`コレクションに商品を登録してください：

```javascript
// 例
db.products.insertMany([
  {
    id: "boost-slot",
    name: "Boosted Raid Slot",
    description: "Priority queue for the next operation.",
    price: 500,
    type: "role",
    seller_id: "123456789",
    seller_name: "zumi",
    seller_icon: "https://cdn.discordapp.com/icons/serverid/avatar.png"
  }
])
```

### 6. Workersのデプロイ

```bash
cd worker
wrangler deploy
```

### 7. フロントエンドの設定

`js/config.js`を編集してください：
```javascript
const WORKER_URL = 'https://your-worker-name.your-subdomain.workers.dev';
```

## APIエンドポイント

| エンドポイント | メソッド | 説明 |
|---------------|--------|------|
| `/auth/login` | GET | Discord認証開始 |
| `/auth/callback` | GET | Discord認証コールバック |
| `/me` | GET | セッションユーザー情報取得 |
| `/auth/logout` | POST | ログアウト |
| `/api/products` | GET | 商品一覧取得 |
| `/api/purchase` | POST | 商品購入（`product_id`を送信） |

## フロー

1. ユーザーが`auth.html`からDiscordログイン
2. WorkersがOAuth2コールバックを処理し、MongoDBにユーザーをupsert（money初期値0）
3. `shop.html`がセッション確認 → 未ログインなら`auth.html`へリダイレクト
4. MongoDBから`products`を取得して商品一覧表示
5. 購入時は`/api/purchase` → `purchases`コレクションに記録
6. Botが`purchases`をポーリングしてロール付与などの処理

## 注意事項

- `MONGODB_URI`はbotと同一のものを使用してください（ユーザー情報を共有するため）
- `SESSION_SECRET`はランダムな文字列を設定してください（推測されにくいもの）
- 購入記録の処理（ロール付与など）はBot側で行ってください