// MongoDB 初期セットアップ: インデックスを作成する
// 使い方: MONGODB_URI="mongodb+srv://..." node setup-db.js
//
// Node.js 18+ (ESM + top-level await) が必要です。
// package.json に "type": "module" が設定されていることを確認してください。

import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI;
if (!uri) {
    console.error('❌  MONGODB_URI 環境変数を設定してください。');
    console.error('   例: MONGODB_URI="mongodb+srv://..." node setup-db.js');
    process.exit(1);
}

const client = new MongoClient(uri);

try {
    await client.connect();
    console.log('✅  MongoDB に接続しました。');

    const db = client.db('kura');

    // ── users コレクション ──
    // userid を一意にする（bot との共有前提）
    await db.collection('users').createIndex({ userid: 1 }, { unique: true });
    console.log('✅  users: userid ユニークインデックス作成');

    // ── products コレクション ──
    // id を一意にする
    await db.collection('products').createIndex({ id: 1 }, { unique: true });
    console.log('✅  products: id ユニークインデックス作成');

    // ── purchases コレクション ──
    // userid + product_id で高速検索できるよう複合インデックス
    await db.collection('purchases').createIndex({ userid: 1, product_id: 1 });
    console.log('✅  purchases: userid + product_id 複合インデックス作成');

    // created_at でソートできるよう単体インデックス（bot のポーリング用）
    await db.collection('purchases').createIndex({ created_at: 1 });
    console.log('✅  purchases: created_at インデックス作成');

    console.log('\n🎉  セットアップ完了！');
} catch (err) {
    console.error('❌  エラーが発生しました:', err);
    process.exit(1);
} finally {
    await client.close();
}