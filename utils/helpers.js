// utils/helpers.js
// 汎用ユーティリティ関数群

const crypto = require('crypto');
const { EmbedBuilder } = require('discord.js');

// 全角数字→半角数字
function toHalfWidth(str) {
    return str.replace(/[０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xFEE0));
}

// トークン生成
function generateToken(length = 32) {
    return crypto.randomBytes(length).toString('hex');
}

// パスワードフィンガープリント
function passwordFingerprint(password) {
    return crypto.createHash('sha256').update(password.normalize('NFKC')).digest('hex');
}

// Base64URL変換
function toBase64Url(buffer) {
    return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// バックアップが登録済みか確認
function isBackupRegistered(backup) {
    return Boolean(backup.passwordHash) || (backup.webauthnCredentials && backup.webauthnCredentials.length > 0);
}

// WebAuthn設定取得
function getWebAuthnConfig(req) {
    const BASE_URL = (process.env.BASE_URL || 'https://buy-4r0w.onrender.com').replace(/\/$/, '');
    const origin = process.env.BASE_URL
        ? process.env.BASE_URL.replace(/\/$/, '')
        : req
        ? `${req.protocol}://${req.headers.host}`.replace(/\/$/, '')
        : BASE_URL;
    const { hostname } = new URL(origin);
    return { rpName: 'Discord Backup', rpID: hostname, origin };
}

// IPアドレス取得
function getClientIp(req) {
    return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
        req.socket.remoteAddress || '';
}

// ユーザーIDからDiscordユーザーを取得
async function resolveUser(client, guild, mentionOrId) {
    if (!mentionOrId) return null;
    const id = mentionOrId.replace(/[<@!>]/g, '');
    try {
        return await client.users.fetch(id);
    } catch {
        return null;
    }
}

// メンバーをIDから取得
async function resolveMember(guild, id) {
    try {
        return await guild.members.fetch(id);
    } catch {
        return null;
    }
}

// 管理者権限チェック
const ADMIN_ROLE_ID = '1515576671875371048';
function hasAdminPermission(member) {
    const { PermissionsBitField } = require('discord.js');
    return member.permissions.has(PermissionsBitField.Flags.Administrator) ||
        member.roles.cache.has(ADMIN_ROLE_ID);
}

// DMで任意のメッセージを送信
async function sendPrivateUrl(user, message) {
    try {
        await user.send(message);
        return true;
    } catch {
        return false;
    }
}

// チャレンジのセット・検証・クリア
function setPendingChallenge(backup, challenge) {
    const CHALLENGE_TTL_MS = 5 * 60 * 1000;
    backup.pendingChallenge = challenge;
    backup.pendingChallengeExpires = new Date(Date.now() + CHALLENGE_TTL_MS);
}

function isChallengeValid(backup, expectedChallenge) {
    return backup.pendingChallenge === expectedChallenge &&
        backup.pendingChallengeExpires &&
        backup.pendingChallengeExpires > new Date();
}

function clearPendingChallenge(backup) {
    backup.pendingChallenge = null;
    backup.pendingChallengeExpires = null;
}

module.exports = {
    toHalfWidth,
    generateToken,
    passwordFingerprint,
    toBase64Url,
    isBackupRegistered,
    getWebAuthnConfig,
    getClientIp,
    resolveUser,
    resolveMember,
    hasAdminPermission,
    sendPrivateUrl,
    setPendingChallenge,
    isChallengeValid,
    clearPendingChallenge
};
