// ── Kura Auth + Shop Worker (Cloudflare Workers) ──
// Discord OAuth2 + MongoDB で money を管理
import { MongoClient } from 'mongodb';

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

// ── 署名検証 ──
async function verify(token, secret) {
    if (!token || !token.includes('.')) return null;
    const dotIdx = token.indexOf('.');
    const value = token.slice(0, dotIdx);
    const expected = await sign(value, secret);
    return expected === token ? value : null;
}

// ── MongoDB 接続 ──
let mongoClient = null;
let lastDbConnectTime = 0;

async function getDb(env) {
    const now = Date.now();
    if (!mongoClient || (now - lastDbConnectTime) > 300000) {
        if (mongoClient) {
            try { await mongoClient.close(); } catch (e) {}
        }
        mongoClient = new MongoClient(env.MONGODB_URI);
        await mongoClient.connect();
        lastDbConnectTime = now;
    }
    const d = mongoClient.db('kura');
    return {
        users: d.collection('users'),
        products: d.collection('products'),
        purchases: d.collection('purchases')
    };
}

// ── CORS ヘッダー ──
function corsHeaders(env, request) {
    const origin = request.headers.get('Origin') || '';
    const siteOrigin = env.SITE_ORIGIN || '';
    const allowedOrigin = origin === siteOrigin ? origin : siteOrigin;
    return {
        'Access-Control-Allow-Origin': allowedOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Credentials': 'true',
        'Vary': 'Origin'
    };
}

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

// ── Discord OAuth ──
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

async function discordUser(token) {
    const res = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: 'Bearer ' + token }
    });
    return res.json();
}

// ── セッション確認 ──
async function getSessionUserId(request, env) {
    const cookie = request.headers.get('Cookie') || '';
    const m = cookie.match(/__kura_session=([^;]+)/);
    if (!m) return null;
    return await verify(m[1], env.SESSION_SECRET);
}

// ── API ハンドラ ──
async function handleApi(request, env, url) {
    const path = url.pathname;
    const cors = corsHeaders(env, request);

    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: cors });
    }

    // ログイン開始
    if (path === '/auth/login') {
        return Response.redirect(discordAuthUrl(env), 302);
    }

    // OAuth コールバック
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

        const db = await getDb(env);
        await db.users.updateOne(
            { userid: userId },
            { $setOnInsert: { userid: userId, username, money: 0 }, $set: { username } },
            { upsert: true }
        );

        const sessionToken = await sign(userId, env.SESSION_SECRET);

        return new Response(null, {
            status: 302,
            headers: {
                'Location': env.SITE_ORIGIN + '/shop/',
                'Set-Cookie': '__kura_session=' + sessionToken + '; HttpOnly; Secure; Path=/; SameSite=None; Max-Age=2592000'
            }
        });
    }

    // セッション確認 (/me)
    if (path === '/me') {
        const discordId = await getSessionUserId(request, env);
        if (!discordId) return jsonWithCors({ error: 'unauthorized' }, 401, env, request);

        const doc = await (await getDb(env)).users.findOne({ userid: discordId }, { projection: { _id: 0 } });
        if (!doc) return jsonWithCors({ error: 'not found' }, 404, env, request);

        const avatarUrl = doc.avatar 
            ? `https://cdn.discordapp.com/avatars/${discordId}/${doc.avatar}.${doc.avatar_animated ? 'gif' : 'png'}`
            : `https://cdn.discordapp.com/embed/avatars/${parseInt(discordId) % 5}.png`;
        
        return jsonWithCors({ ...doc, balance: doc.money, avatar: avatarUrl }, 200, env, request);
    }

    // ロール情報取得
    if (path === '/api/roles' && request.method === 'GET') {
        const discordId = await getSessionUserId(request, env);
        if (!discordId) return jsonWithCors({ error: 'unauthorized' }, 401, env, request);

        try {
            if (!env.DISCORD_BOT_TOKEN) {
                return jsonWithCors({ error: 'bot token not configured' }, 500, env, request);
            }

            const memberRes = await fetch(`https://discord.com/api/v10/guilds/${TARGET_SERVER_ID}/members/${discordId}`, {
                headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}` }
            });

            if (!memberRes.ok) {
                if (memberRes.status === 404) {
                    return jsonWithCors({ roles: [], hasAnimatedRole: false }, 200, env, request);
                }
                return jsonWithCors({ error: 'failed to fetch member info' }, 500, env, request);
            }

            const memberData = await memberRes.json();
            const roleIds = memberData.roles || [];

            const rolesRes = await fetch(`https://discord.com/api/v10/guilds/${TARGET_SERVER_ID}/roles`, {
                headers: { 'Authorization': `Bot ${env.DISCORD_BOT_TOKEN}` }
            });

            if (!rolesRes.ok) {
                return jsonWithCors({ error: 'failed to fetch roles' }, 500, env, request);
            }

            const allRoles = await rolesRes.json();
            
            const userRoles = allRoles
                .filter(role => role.id !== TARGET_SERVER_ID && roleIds.includes(role.id))
                .map(role => ({
                    id: role.id,
                    name: role.name,
                    color: role.color !== 0 ? '#' + role.color.toString(16).padStart(6, '0') : '#999999',
                    animated: false
                }));

            let hasAnimatedRole = false;
            userRoles.forEach(role => {
                if (role.color.toUpperCase().includes('FEE75C') || role.color.toUpperCase().includes('5865F2')) {
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

    // ログアウト
    if (path === '/auth/logout') {
        return new Response(null, {
            status: 200,
            headers: {
                'Set-Cookie': '__kura_session=; HttpOnly; Secure; Path=/; SameSite=None; Max-Age=0',
                ...cors
            }
        });
    }

    // 商品一覧
    if (path === '/api/products' && request.method === 'GET') {
        const products = await (await getDb(env)).products.find({}, { projection: { _id: 0 } }).toArray();
        return jsonWithCors(products, 200, env, request);
    }

    // 購入
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

        const db = await getDb(env);
        const { users, products, purchases } = db;

        const product = await products.findOne({ id: product_id }, { projection: { _id: 0 } });
        if (!product) return jsonWithCors({ error: 'product not found' }, 404, env, request);

        const user = await users.findOne({ userid: discordId });
        if (!user) return jsonWithCors({ error: 'user not found' }, 404, env, request);
        if (user.money < product.price) return jsonWithCors({ error: 'insufficient balance' }, 400, env, request);

        const result = await db.users.updateOne(
            { userid: discordId, money: { $gte: product.price } },
            { $inc: { money: -product.price } }
        );
        if (result.modifiedCount === 0) return jsonWithCors({ error: 'purchase failed (race condition or insufficient balance)' }, 409, env, request);

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

// ── メインハンドラ ──
export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;

        // API パスのみ Worker で処理
        if (path.startsWith('/auth/') || path === '/me' || path.startsWith('/api/')) {
            return handleApi(request, env, url);
        }

        // 静的ファイルは ASSETS に委譲
        if (env.ASSETS) {
            return env.ASSETS.fetch(request);
        }

        return new Response('Not Found', { status: 404 });
    }
};
