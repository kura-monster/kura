// ── 共通認証ヘルパー ──
// Worker の /me エンドポイントでセッションを確認する。
// config.js が先に読み込まれ WORKER_URL が定義されている必要があります。

/**
 * セッションを確認してユーザー情報を返す。
 * @returns {{ userid: string, username: string, money: number, balance: number } | null}
 */
async function checkSession() {
    try {
        const res = await fetch(WORKER_URL + '/me', {
            credentials: 'include'
        });
        if (!res.ok) return null;
        return await res.json(); // { userid, username, money, balance }
    } catch (err) {
        console.warn('session check failed:', err);
        return null;
    }
}

/**
 * 未ログイン時に auth.html へリダイレクトする。
 */
function redirectToLogin() {
    window.location.href = 'auth.html';
}

/**
 * ログアウトして auth.html に戻る。
 */
async function logout() {
    try {
        await fetch(WORKER_URL + '/auth/logout', {
            method: 'POST',
            credentials: 'include'
        });
    } catch (err) {
        console.warn('logout failed:', err);
    }
    window.location.href = 'auth.html';
}
