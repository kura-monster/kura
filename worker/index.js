// ── Kura Auth + Shop Worker (Cloudflare Workers) ──
// Discord OAuth2 + MongoDB で money を管理
// users コレクション: { userid, username, money }  (bot と共有)
// products コレクション: { id, name, description, price, type, seller_id, seller_name, seller_icon }
// purchases コレクション: { userid, product_id, type, created_at }  (bot が非同期で拾う)
import { MongoClient } from 'mongodb';

// Target Discord Server ID for role colors
const TARGET_SERVER_ID = '1416945779741950134';

// ── HMAC-SHA256 署名 ──
async function sign(value, secret) {
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
    return value + '.' + [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── 署名検証（async）──
async function verify(token, secret) {
    if (!token || !token.includes('.')) return null;
    const dotIdx = token.indexOf('.');
    const value = token.slice(0, dotIdx);
    const expected = await sign(value, secret);
    return expected === token ? value : null;
}

// ── MongoDB 接続（グローバルキャッシュ）──
let mongoClient = null;

function db(env) {
    if (!mongoClient) {
        mongoClient = new MongoClient(env.MONGODB_URI);
    }
    const d = mongoClient.db('kura');
    return {
        users: d.collection('users'),
        products: d.collection('products'),
        purchases: d.collection('purchases')
    };
}

// ── CORS ヘッダーを生成 ──
function corsHeaders(env, request) {
    const origin = request.headers.get('Origin') || '';
    const siteOrigin = env.SITE_ORIGIN || '';
    // 許可されたオリジンのみ reflect する
    const allowedOrigin = origin === siteOrigin ? origin : siteOrigin;
    return {
        'Access-Control-Allow-Origin': allowedOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Credentials': 'true',
        'Vary': 'Origin'
    };
}

// ── JSON レスポンス（CORS 付き）──
function json(data, status = 200, extra = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', ...extra }
    });
}

function jsonWithCors(data, status = 200, env = {}, request = {}, extra = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            ...corsHeaders(env, request),
            ...extra
        }
    });
}

// ── Discord OAuth URL 生成 ──
function discordAuthUrl(env) {
    const params = new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        redirect_uri: env.REDIRECT_URI,
        response_type: 'code',
        scope: 'identify',
        prompt: 'consent'
    });
    return 'https://discord.com/oauth2/authorize?' + params.toString();
}

// ── Discord OAuth トークン取得 ──
async function discordToken(code, env) {
    const body = new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        client_secret: env.DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: env.REDIRECT_URI
    });
    const res = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
    });
    return res.json();
}

// ── Discord ユーザー情報取得 ──
async function discordUser(token) {
    const res = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: 'Bearer ' + token }
    });
    return res.json();
}

// ── セッション Cookie からユーザーID を取得（async）──
async function getSessionUserId(request, env) {
    const cookie = request.headers.get('Cookie') || '';
    const m = cookie.match(/__kura_session=([^;]+)/);
    if (!m) return null;
    return await verify(m[1], env.SESSION_SECRET);
}

// ── メインハンドラ ──
export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const path = url.pathname;
        const cors = corsHeaders(env, request);

        // ── CORS プリフライト ──
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: cors });
        }

        // ── ログイン開始 ──
        if (path === '/auth/login') {
            return Response.redirect(discordAuthUrl(env), 302);
        }

        // ── OAuth コールバック ──
        if (path === '/auth/callback') {
            const code = url.searchParams.get('code');
            if (!code) return json({ error: 'no code' }, 400);

            let tokenRes;
            try {
                tokenRes = await discordToken(code, env);
            } catch (e) {
                return json({ error: 'token request failed' }, 500);
            }
            if (!tokenRes.access_token) return json({ error: 'token failed' }, 400);

            let user;
            try {
                user = await discordUser(tokenRes.access_token);
            } catch (e) {
                return json({ error: 'discord user fetch failed' }, 500);
            }
            if (!user.id) return json({ error: 'invalid discord user' }, 400);

            const userId = user.id;
            const username = user.username;

            // bot と共有: userid / money
            const { users } = db(env);
            await users.updateOne(
                { userid: userId },
                {
                    $setOnInsert: { userid: userId, username, money: 0 },
                    $set: { username }
                },
                { upsert: true }
            );

            const sessionToken = await sign(userId, env.SESSION_SECRET);

            // Secure フラグは HTTPS 環境では必須
            return new Response(null, {
                status: 302,
                headers: {
                    'Location': env.SITE_ORIGIN + '/shop.html',
                    'Set-Cookie':
                        '__kura_session=' + sessionToken +
                        '; HttpOnly; Secure; Path=/; SameSite=None; Max-Age=2592000'
                }
            });
        }

        // ── セッション確認（/me）──
        if (path === '/me') {
            const discordId = await getSessionUserId(request, env);
            if (!discordId) return jsonWithCors({ error: 'unauthorized' }, 401, env, request);

            const doc = await db(env).users.findOne(
                { userid: discordId },
                { projection: { _id: 0 } }
            );
            if (!doc) return jsonWithCors({ error: 'not found' }, 404, env, request);

            // フロントが参照する `balance` フィールドも追加（money の別名）
            // アバター URL も追加
            const avatarUrl = doc.avatar 
                ? `https://cdn.discordapp.com/avatars/${discordId}/${doc.avatar}.${doc.avatar_animated ? 'gif' : 'png'}`
                : `https://cdn.discordapp.com/embed/avatars/${parseInt(discordId) % 5}.png`;
            
            return jsonWithCors(
                { ...doc, balance: doc.money, avatar: avatarUrl },
                200,
                env,
                request
            );
        }

        // ── ユーザーのロール情報を取得（サーバー 1416945779741950134）──
        if (path === '/api/roles' && request.method === 'GET') {
            const discordId = await getSessionUserId(request, env);
            if (!discordId) return jsonWithCors({ error: 'unauthorized' }, 401, env, request);

            try {
                // Discord Bot Token でメンバー情報を取得
                if (!env.DISCORD_BOT_TOKEN) {
                    return jsonWithCors({ error: 'bot token not configured' }, 500, env, request);
                }

                const memberRes = await fetch(
                    `https://discord.com/api/v10/guilds/${TARGET_SERVER_ID}/members/${discordId}`,
                    {
                        headers: {
                            'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`
                        }
                    }
                );

                if (!memberRes.ok) {
                    if (memberRes.status === 404) {
                        // サーバーにいない場合は空のロールリストを返す
                        return jsonWithCors({ roles: [], hasAnimatedRole: false }, 200, env, request);
                    }
                    return jsonWithCors({ error: 'failed to fetch member info' }, 500, env, request);
                }

                const memberData = await memberRes.json();
                const roleIds = memberData.roles || [];

                // ロール一覧を取得
                const rolesRes = await fetch(
                    `https://discord.com/api/v10/guilds/${TARGET_SERVER_ID}/roles`,
                    {
                        headers: {
                            'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}`
                        }
                    }
                );

                if (!rolesRes.ok) {
                    return jsonWithCors({ error: 'failed to fetch roles' }, 500, env, request);
                }

                const allRoles = await rolesRes.json();
                
                // ユーザーのロールをフィルタ（@everyone は除外）
                const userRoles = allRoles
                    .filter(role => role.id !== TARGET_SERVER_ID && roleIds.includes(role.id))
                    .map(role => ({
                        id: role.id,
                        name: role.name,
                        color: role.color !== 0 ? '#' + role.color.toString(16).padStart(6, '0') : '#999999',
                        animated: false // 後でチェック
                    }));

                // アニメーション付きロール（ブーストロールなど）をチェック
                // 簡易的に、色が付いていて特定の条件を満たすロールをアニメーション対象とする
                let hasAnimatedRole = false;
                userRoles.forEach(role => {
                    // 例：色が金色系 (#FEE75C など) の場合はアニメーション
                    if (role.color.toUpperCase().includes('FEE75C') || 
                        role.color.toUpperCase().includes('5865F2')) {
                        role.animated = true;
                        hasAnimatedRole = true;
                    }
                });

                return jsonWithCors({ roles: userRoles, hasAnimatedRole }, 200, env, request);

            } catch (err) {
                console.error('Role fetch error:', err);
                return jsonWithCors({ error: 'internal error' }, 500, env, request);
            }
        }

        // ── ログアウト ──
        if (path === '/auth/logout') {
            return new Response(null, {
                status: 200,
                headers: {
                    'Set-Cookie':
                        '__kura_session=; HttpOnly; Secure; Path=/; SameSite=None; Max-Age=0',
                    ...cors
                }
            });
        }

        // ── 商品一覧 ──
        if (path === '/api/products' && request.method === 'GET') {
            const products = await db(env).products.find(
                {},
                { projection: { _id: 0 } }
            ).toArray();
            return jsonWithCors(products, 200, env, request);
        }

        // ── 購入（非同期連携: bot が purchases を拾って処理）──
        if (path === '/api/purchase' && request.method === 'POST') {
            const discordId = await getSessionUserId(request, env);
            if (!discordId) return jsonWithCors({ error: 'unauthorized' }, 401, env, request);

            let body;
            try {
                body = await request.json();
            } catch (e) {
                return jsonWithCors({ error: 'invalid JSON' }, 400, env, request);
            }
            const { product_id } = body;
            if (!product_id) return jsonWithCors({ error: 'bad request: product_id required' }, 400, env, request);

            const { users, products, purchases } = db(env);

            const product = await products.findOne({ id: product_id }, { projection: { _id: 0 } });
            if (!product) return jsonWithCors({ error: 'product not found' }, 404, env, request);

            const user = await users.findOne({ userid: discordId });
            if (!user) return jsonWithCors({ error: 'user not found' }, 404, env, request);
            if (user.money < product.price) return jsonWithCors({ error: 'insufficient balance' }, 400, env, request);

            // 残高減算（bot との競合を防ぐため money >= price の条件付き）
            const result = await users.updateOne(
                { userid: discordId, money: { $gte: product.price } },
                { $inc: { money: -product.price } }
            );
            if (result.modifiedCount === 0) return jsonWithCors({ error: 'purchase failed (race condition or insufficient balance)' }, 409, env, request);

            // bot が非同期で拾う購入記録
            await purchases.insertOne({
                userid: discordId,
                product_id: product.id,
                type: product.type,
                created_at: new Date().toISOString()
            });

            const updated = await users.findOne({ userid: discordId });
            return jsonWithCors(
                { ok: true, product_id: product.id, money: updated.money, balance: updated.money },
                200,
                env,
                request
            );
        }

        return jsonWithCors({ error: 'not found' }, 404, env, request);
    }
};
