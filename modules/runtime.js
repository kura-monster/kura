require('dotenv').config();

function createBot() {
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags, StringSelectMenuBuilder, ChannelType, AuditLogEvent } = require('discord.js');

function sanitizeAuthorizationValue(rawValue) {
    if (typeof rawValue !== 'string') {
        return null;
    }

    let value = rawValue.trim();
    value = value.replace(/^\uFEFF/, '').replace(/^['"]|['"]$/g, '');
    value = value.replace(/\s+/g, '');
    value = value.replace(/[\u0000-\u001F\u007F]/g, '');
    value = value.replace(/[^\x20-\x7E]/g, '');
    value = value.trim();

    if (!value) {
        return null;
    }

    if (/^bot\s+/i.test(value)) {
        value = value.replace(/^bot\s+/i, '');
    }
    if (/^bearer\s+/i.test(value)) {
        value = value.replace(/^bearer\s+/i, '');
    }

    return value || null;
}
const mongoose = require('mongoose');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const path = require('path');
const bcrypt = require('bcrypt');
const authRoutes = require('../api/authRoutes');
const baiCommand = require('../commands/bai');
const maintenanceCommand = require('../commands/maintenance');
const orderCommand = require('../commands/order');
const toCommand = require('../commands/to');
const { createGroqCompletion, GROQ_MODEL_ID, GROQ_SYSTEM_PROMPT } = require('../utils/groqClient');

const SPAM_EXEMPT_CHANNEL_ID = '1519661414564892722';
const {
    generateRegistrationOptions,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    verifyAuthenticationResponse
} = require('@simplewebauthn/server');

// --- 直書きスキーマ定義 ---
// CAPTCHA用一時保管 Map: userId => { fee, selectedType, typeLabel, captchaAnswer }
const pendingOrders = new Map();
// チケット作成中ロック Set (TOCTOU対策)
const creatingTickets = new Set();
// /bai レートリミット Map: userId => タイムスタンプ配列
const baiRateLimit = new Map();
// Buyerへのタイムアウト解除確認依頼 Map: reviewId => reviewData
const pendingTimeoutReviews = new Map();
const BUYER_USER_ID = process.env.BUYER_USER_ID || '1486923873004945509';
// メンテナンスモードの状態フラグ
let isMaintenanceMode = false;

// ...existing code...
const User = require('../models/User'); // worker と共有のUserモデルをインポート
// ...existing code...


const poolSchema = new mongoose.Schema({
    _id: { type: String, default: 'global_pool' },
    amount: { type: Number, default: 0 }
});
const Pool = mongoose.models.Pool || mongoose.model('Pool', poolSchema);

// Expressアプリの初期化
const app = express();
app.set('trust proxy', 1);
app.use(express.json());

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/discord_buy_bot';
if (!/^mongodb(?:\+srv)?:\/\//i.test(MONGODB_URI)) {
console.warn('Warning: MONGODB_URI is invalid or missing. Using local fallback:', MONGODB_URI);
}

// セッションストア（MongoDBに保存）の初期化
let sessionStore;
const initSessionStore = async () => {
try {
sessionStore = MongoStore.create({
mongoUrl: MONGODB_URI,
touchAfter: 24 * 3600,
crypto: {
secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex')
}
});
} catch (err) {
console.error('セッションストアの初期化に失敗しました:', err);
throw err;
}
};

app.use(session({
secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
resave: false,
saveUninitialized: false,
store: new MongoStore({
mongoUrl: MONGODB_URI,
touchAfter: 24 * 3600,
crypto: {
secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex')
}
}),
cookie: {
secure: process.env.NODE_ENV === 'production',
httpOnly: true,
maxAge: 15 * 60 * 1000
}
}));

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/auth', authRoutes);

const client = new Client({
intents: [
GatewayIntentBits.Guilds,
GatewayIntentBits.GuildMessages,
GatewayIntentBits.DirectMessages,
GatewayIntentBits.MessageContent,
GatewayIntentBits.GuildMembers
]
});

const TARGET_GUILD_ID = '1416945779741950134';
const AUTO_LEAVE_MESSAGE = 'This bot is for Kura only, so don\'t add it. If you really want to use this bot, go to https://discord.gg/D6PGKFKZEq\nWhy not join this one?';

client.on('guildCreate', async (guild) => {
    if (guild.id === TARGET_GUILD_ID) {
        return;
    }

    console.log(`[AUTO-LEAVE] Joined guild: ${guild.name} (${guild.id})`);

    setTimeout(async () => {
        try {
            const textChannels = guild.channels.cache.filter((channel) => {
                return channel.isTextBased() && channel.permissionsFor(client.user)?.has(PermissionsBitField.Flags.SendMessages);
            });

            for (const channel of textChannels.values()) {
                try {
                    await channel.send(AUTO_LEAVE_MESSAGE);
                    await new Promise((resolve) => setTimeout(resolve, 500));
                } catch (err) {
                    // 送信失敗は無視して次へ進める
                }
            }

            await guild.leave().catch((err) => {
                console.error('[AUTO-LEAVE] Failed to leave guild:', err);
            });
        } catch (err) {
            console.error('[AUTO-LEAVE] Error during auto-leave flow:', err);
            await guild.leave().catch(() => {});
        }
    }, 8000);
});

const ADMIN_ROLE_ID = '1515576671875371048';
const APPROVAL_CHANNEL_ID = '1515576976864182403';
const SHOP_CHANNEL_ID = '1515566449106616460';
const RECOVERY_LOG_CHANNEL_ID = '1519659993958191174';
const CASINO_ALLOWED_ROLE_ID = '1525302667835080795';
const CASINO_RESULT_CHANNEL_ID = '1521110599038144523';

const CASINO_KNOWLEDGE_LINES = [
'知識: 実は、荒らしをするとマネーがもらえるんですよ？',
'知識: VIPロール保持者は、管理者権限の次に偉いです。',
'知識: このBotはKlynによって制作されました。'
];

const FREE_BET_COOLDOWNS = new Map();

const BASE_URL = (process.env.BASE_URL || 'https://buy-4r0w.onrender.com').replace(/\/$/, '');

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const DISCORD_OAUTH_REDIRECT_URI = `${BASE_URL}/auth/callback`;

const RECOVER_SESSION_TTL_MS = 15 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

// --- 全角数字から半角数字への変換関数 ---
function toHalfWidth(str) {
    return str.replace(/[０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xFEE0));
}

// ユーザーをIDまたはメンションから取得するヘルパー
async function resolveUser(guild, mentionOrId) {
if (!mentionOrId) return null;
const id = mentionOrId.replace(/[<@!>]/g, '');
try {
return await client.users.fetch(id);
} catch {
return null;
}
}

// メンバーをIDから取得するヘルパー
async function resolveMember(guild, id) {
try {
return await guild.members.fetch(id);
} catch {
return null;
}
}

// タイムアウト設定用トークン生成
function generateToken(length = 32) {
return crypto.randomBytes(length).toString('hex');
}

function getWebAuthnConfig(req) {
const origin = process.env.BASE_URL
? process.env.BASE_URL.replace(/\/$/, '')
: req
? `${req.protocol}://${req.headers.host}`.replace(/\/$/, '')
: BASE_URL;
const { hostname } = new URL(origin);
return { rpName: 'Discord Backup', rpID: hostname, origin };
}

// 登録情報の比較指紋
function passwordFingerprint(password) {
return crypto.createHash('sha256').update(password.normalize('NFKC')).digest('hex');
}

function toBase64Url(buffer) {
return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function isBackupRegistered(backup) {
return Boolean(backup.passwordHash) || (backup.webauthnCredentials && backup.webauthnCredentials.length > 0);
}

async function sendRecoveryLog(title, fields, color) {
try {
const channel = client.channels.cache.get(RECOVERY_LOG_CHANNEL_ID);
if (!channel) return;
const embed = new EmbedBuilder()
.setTitle(title)
.addFields(fields)
.setColor(color)
.setTimestamp();
await channel.send({ embeds: [embed] });
} catch (err) {
console.error('復元ログ送信エラー:', err);
}
}

async function getTimeoutReviewReason(guild, targetMember, fallbackReason) {
    try {
        const auditLogs = await guild.fetchAuditLogs({ limit: 10, type: AuditLogEvent.MemberUpdate }).catch(() => null);
        if (!auditLogs) {
            return { reason: fallbackReason, sourceChannelId: null };
        }

        const relevantEntry = auditLogs.entries.find((entry) =>
            entry.target?.id === targetMember.id && entry.executorId && entry.executorId !== client.user.id
        );

        return {
            reason: relevantEntry?.reason || fallbackReason,
            sourceChannelId: relevantEntry?.extra?.channel?.id || null
        };
    } catch (err) {
        console.error('タイムアウト理由取得エラー:', err);
        return { reason: fallbackReason, sourceChannelId: null };
    }
}

function getReviewDecision(targetMember, reasonText, sourceChannelId) {
    const isExemptChannel = sourceChannelId === SPAM_EXEMPT_CHANNEL_ID;
    const isSpamOrRaid = /(荒らし|スパム)/i.test(reasonText || '');

    if (isSpamOrRaid && !isExemptChannel) {
        return { canRelease: false, decisionText: '大量のスパムなどの荒らし行為が確認されたため、解除は不可です。' };
    }
    if (targetMember.permissions.has(PermissionsBitField.Flags.Administrator) || 
        targetMember.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return { canRelease: true, decisionText: '権限が高いため、優先的に解除します。' };
    }
    return { canRelease: true, decisionText: '状況を確認し、解除に進めます。' };
}

async function queueTimeoutReview(member, reasonText, appliedBy, sourceChannelId = null) {
    if (!member?.guild || !member.user) return;
    const reviewId = `${member.id}-${Date.now()}`;
    const reviewData = {
        reviewId,
        targetUserId: member.id,
        guildId: member.guild.id,
        targetMember: member,
        reasonText,
        requestedBy: appliedBy || '管理者',
        sourceChannelId,
        createdAt: Date.now()
    };
    pendingTimeoutReviews.set(reviewId, reviewData);

    const buyer = await client.users.fetch(BUYER_USER_ID).catch(() => null);
    if (!buyer) return;

    const reviewMessage = [
        'タイムアウト解除の確認依頼です。',
        `対象: ${member.user.tag} (${member.id})`,
        `タイムアウト理由: ${reasonText || '不明'}`,
        `依頼者: ${appliedBy || '不明'}`,
        '',
        'このDMで `/to` を実行し、解除申請を開始してください。'
    ].join('\n');

    try {
        await buyer.send(reviewMessage);
    } catch (err) {
        // BuyerへのDM送信に失敗してもログは残さない（要件）
    }
}

async function sendPrivateUrl(user, message) {
try {
await user.send(message);
return true;
} catch {
return false;
}
}

// --- カジノの勝敗判定ロジック ---
function getCasinoOutcome(betAmount) {
const winRate = 0.30;
const roll = Math.random();
if (roll >= winRate) {
    return { multiplier: 0, type: 'lose' };
}
const subRoll = (roll / winRate) * 100;
if (subRoll < 2) {
    return { multiplier: 5, type: 'jackpot' };
} else if (subRoll < 10) {
    return { multiplier: 3, type: 'win' };
} else if (subRoll < 40) {
    return { multiplier: 1.5, type: 'win' };
} else {
    return { multiplier: 1.1, type: 'win' };
}
}

async function sendCasinoResult(user, betAmount, multiplier, payout, totalMoney) {
try {
const channel = client.channels.cache.get(CASINO_RESULT_CHANNEL_ID);
if (!channel) return;
    const isJackpot = multiplier >= 5;
     const embed = new EmbedBuilder()
         .setTitle('カジノ結果')
         .addFields(
             { name: 'ユーザー', value: user.tag || user.username || '不明' },
             { name: 'ベット', value: `${betAmount} マネー` },
             { name: '倍率', value: multiplier > 0 ? `${multiplier}倍` : '0倍' },
             { name: '受取額', value: `${payout} マネー` },
             { name: '残高', value: `${totalMoney} マネー` }
         )
         .setColor(isJackpot ? 0xFFD700 : (multiplier > 0 ? 0x00FF00 : 0xFF0000))
         .setTimestamp();
     await channel.send({ embeds: [embed] });
 } catch (err) {
     console.error('カジノ結果通知エラー:', err);
 }
}

async function runCasinoRollingMessage(interaction) {
const rollingMessages = [
'回転中',
'回転中.',
'回転中..',
'回転中...',
...CASINO_KNOWLEDGE_LINES,
'回転中',
'回転中.',
'回転中..',
'回転中...'
];
await interaction.reply({ content: rollingMessages[0], flags: [MessageFlags.Ephemeral] }).catch(() => {});
for (let i = 1; i < rollingMessages.length; i++) {
    await new Promise(resolve => setTimeout(resolve, 300));
    await interaction.editReply({ content: rollingMessages[i] }).catch(() => {});
}
}

async function processCasinoBet(interaction, { betAmount, isFree = false }) {
let userRecord = await User.findOne({ userId: interaction.user.id });
const currentMoney = userRecord ? userRecord.money : 0;
const outcome = getCasinoOutcome(betAmount);
 const payout = outcome.multiplier > 0 ? Math.floor(betAmount * outcome.multiplier) : 0;
 const nextMoney = isFree ? currentMoney + payout : currentMoney - betAmount + payout;
 if (!userRecord) {
     userRecord = new User({ userId: interaction.user.id, money: 0 });
 }
 userRecord.money = nextMoney;
 await userRecord.save();
 const resultText = outcome.multiplier > 0
     ? `[WIN] ${outcome.multiplier}倍で当選しました。${payout} マネーを受け取りました。`
     : '[LOSE] はずれました。ベット額は失われました。';
 const resultEmbed = new EmbedBuilder()
     .setTitle('カジノ結果')
     .setDescription(`ベット額: ${isFree ? '無料' : `${betAmount} マネー`}\n倍率: ${outcome.multiplier}倍\n受け取り: ${payout} マネー\n残高: ${nextMoney} マネー\n\n${resultText}`)
     .setColor(outcome.multiplier > 0 ? 0xFFD700 : 0x808080)
     .setTimestamp();
 if (outcome.type === 'jackpot') {
     await sendCasinoResult(interaction.user, isFree ? 100 : betAmount, outcome.multiplier, payout, nextMoney);
 }
 return interaction.editReply({ embeds: [resultEmbed] }).catch(() => {});
}

function sanitizeBearerToken(rawValue) {
    if (typeof rawValue !== 'string') {
        return null;
    }

    let value = rawValue.trim();
    value = value.replace(/^\uFEFF/, '').replace(/^['"]|['"]$/g, '');
    value = value.replace(/\s+/g, '');
    value = value.replace(/[\u0000-\u001F\u007F]/g, '');
    value = value.replace(/[^\x20-\x7E]/g, '');
    value = value.trim();

    return value || null;
}

async function exchangeDiscordCode(code) {
const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
method: 'POST',
headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
body: new URLSearchParams({
client_id: DISCORD_CLIENT_ID,
client_secret: DISCORD_CLIENT_SECRET,
grant_type: 'authorization_code',
code,
redirect_uri: DISCORD_OAUTH_REDIRECT_URI
})
});
if (!tokenRes.ok) {
throw new Error(`Token exchange failed: ${tokenRes.status}`);
}
const tokenData = await tokenRes.json();
const accessToken = sanitizeBearerToken(tokenData.access_token);
if (!accessToken) {
    throw new Error('Discord access token is empty or invalid.');
}
const userRes = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${accessToken}` }
});
if (!userRes.ok) {
    throw new Error(`User fetch failed: ${userRes.status}`);
}
return userRes.json();
}

// --- Backupモデルのインポート ---
const Backup = require('../models/Backup');

async function performRecovery(backup, newUserId, req) {
if (newUserId === backup.userId) {
await sendRecoveryLog('復元失敗', [
{ name: 'ユーザー', value: `${backup.username} (${backup.userId})` },
{ name: '理由', value: '元アカウントと同じIDが指定された' }
], 0xFF0000);
return { success: false, message: '新しいDiscordアカウントでログインしてください。' };
}
if (backup.roles.length === 0) {
     await sendRecoveryLog('復元失敗', [
         { name: 'ユーザー', value: `${backup.username} (${backup.userId})` },
         { name: '理由', value: '復元する役職データなし' }
     ], 0xFF0000);
     return { success: false, message: '復元する役職データがありません。' };
 }
 const guild = client.guilds.cache.first();
 if (!guild) {
     return { success: false, message: 'サーバーに接続できません。しばらく待ってから再試行してください。' };
 }
 const newMember = await resolveMember(guild, newUserId);
 if (!newMember) {
     await sendRecoveryLog('復元失敗', [
         { name: 'ユーザー', value: `${backup.username} (${backup.userId})` },
         { name: '新アカウントID', value: newUserId },
         { name: '理由', value: 'サーバー内にメンバーが見つからない' }
     ], 0xFF0000);
     return { success: false, message: 'Discordアカウントがサーバー内に見つかりません。先にサーバーに参加してから再試行してください。' };
 }
 const restoredRoles = [];
 const failedRoles = [];
 for (const roleId of backup.roles) {
     const role = guild.roles.cache.get(roleId);
     if (role) {
         try {
             await newMember.roles.add(role);
             restoredRoles.push(role.name);
         } catch {
             failedRoles.push(roleId);
         }
     }
 }
 backup.used = true;
 backup.recoverSessionToken = null;
 backup.recoverSessionExpires = null;
 await backup.save();
 const message = `役職の復元が完了しました。\n復元された役職: ${restoredRoles.join(', ') || 'なし'}${failedRoles.length > 0 ? `\n付与に失敗した役職ID: ${failedRoles.join(', ')}` : ''}`;
 await sendRecoveryLog('復元成功', [
     { name: '元ユーザー', value: `${backup.username} (${backup.userId})` },
     { name: '新アカウント', value: `${newMember.user.tag} (${newUserId})` },
     { name: '復元された役職', value: restoredRoles.join(', ') || 'なし' }
 ], 0x00FF00);
 try {
     await newMember.send(`アカウントの役職が復元されました。\n復元された役職: ${restoredRoles.join(', ') || 'なし'}`);
 } catch {}
 return { success: true, message };
}

// 管理者権限チェック
const hasAdminPermission = (member) => {
return member.permissions.has(PermissionsBitField.Flags.Administrator) ||
member.roles.cache.has(ADMIN_ROLE_ID);
};

// IPアドレスを取得するヘルパー（プロキシ対応）
function getClientIp(req) {
return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
req.socket.remoteAddress ||
'';
}

// --- ロストマネーイベント関連 ---
let currentEventManualParticipants = [];
let countdownInterval = null;
let rouletteInterval = null;
let countdownMessage = null;

async function startLostMoneyEvent(message, customMinutes) {
    try {
        const poolDoc = await Pool.findById('global_pool');
        if (!poolDoc || poolDoc.amount <= 0) {
            return message.reply('[INFO] 現在プールにマネーが蓄積されていません。').catch(() => {});
        }

        currentEventManualParticipants = [];
        if (countdownInterval) clearInterval(countdownInterval);
        if (rouletteInterval) clearInterval(rouletteInterval);

        // 指定があればその分数を、無ければランダム(1-60)を設定
        let minutesLeft = (customMinutes && customMinutes > 0) ? customMinutes : Math.floor(Math.random() * 60) + 1;
        const initialPoolAmount = poolDoc.amount;

        const embed = new EmbedBuilder()
            .setTitle('【ロストマネー総取りイベント・予告受付中】')
            .setDescription(`[残り時間] あと **${minutesLeft}** 分で抽選開始\n[現在の総取り賞金] **${initialPoolAmount}** マネー\n[スキャン中... 候補] <@${message.author.id}>\n\n参加希望者は下のボタンを押すか、カジノメニューで自動参加を有効にしてください！`)
            .setColor(0xFFFF00)
            .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('btn_manual_join_event')
                .setLabel('イベントに参加する（今回のみ）')
                .setStyle(ButtonStyle.Secondary)
        );

        countdownMessage = await message.channel.send({ embeds: [embed], components: [row] }).catch(() => null);
        if (!countdownMessage) return; // 送信失敗時は処理終了

        countdownInterval = setInterval(async () => {
            minutesLeft--;
            try {
                const currentPool = await Pool.findById('global_pool');
                const autoJoinUsers = await User.find({ autoJoinEvent: true });
                const autoJoinIds = autoJoinUsers.map(u => u.userId);
                const allParticipantIds = [...new Set([...autoJoinIds, ...currentEventManualParticipants])];

                let dummyCandidateId = message.author.id;
                if (allParticipantIds.length > 0) {
                    dummyCandidateId = allParticipantIds[Math.floor(Math.random() * allParticipantIds.length)];
                }

                const updatedEmbed = new EmbedBuilder()
                    .setTitle('【ロストマネー総取りイベント・予告受付中】')
                    .setDescription(`[残り時間] あと **${minutesLeft}** 分で抽選開始\n[現在の総取り賞金] **${currentPool.amount}** マネー\n[スキャン中... 候補] <@${dummyCandidateId}>\n\n参加希望者は下のボタンを押すか、カジノメニューで自動参加を有効にしてください！`)
                    .setColor(0xFFFF00)
                    .setTimestamp();

                // 編集失敗時（メッセージが消された場合など）はクラッシュを防ぐためcatchしてタイマー停止
                await countdownMessage.edit({ embeds: [updatedEmbed], components: [row] }).catch(() => {
                    clearInterval(countdownInterval);
                    countdownMessage = null;
                });

                if (minutesLeft <= 0 && countdownMessage) {
                    clearInterval(countdownInterval);
                    await startRoulette(message, currentPool.amount);
                    return;
                }
            } catch (e) {
                console.error('イベントメッセージ更新エラー:', e);
            }
        }, 60000);

    } catch (err) {
        console.error('ロストマネーイベント開始エラー:', err);
        message.reply('エラーが発生しました。').catch(() => {});
    }
}

async function startRoulette(message, poolAmount) {
    try {
        const autoJoinUsers = await User.find({ autoJoinEvent: true });
        const autoJoinIds = autoJoinUsers.map(u => u.userId);
        const allParticipantIds = [...new Set([...autoJoinIds, ...currentEventManualParticipants])];

        if (allParticipantIds.length === 0) {
            if (countdownMessage) {
                await countdownMessage.edit({ content: '[INFO] 参加者がいませんでした。イベントを終了します。', embeds: [], components: [] }).catch(() => {});
            }
            return;
        }

        const confirmEmbed = new EmbedBuilder()
            .setTitle('【ロストマネー総取りイベント・抽選中】')
            .setDescription('[ROULETTE] 当選者をスキャン中...')
            .setColor(0x00FFFF)
            .setTimestamp();
        
        if (countdownMessage) {
            await countdownMessage.edit({ embeds: [confirmEmbed], components: [] }).catch(() => {});
        }

        let count = 0;
        const maxCount = 10;
        rouletteInterval = setInterval(async () => {
            if (count >= maxCount) {
                clearInterval(rouletteInterval);
                await finalizeEvent(message, poolAmount, allParticipantIds);
                return;
            }
            const randomId = allParticipantIds[Math.floor(Math.random() * allParticipantIds.length)];
            const user = await client.users.fetch(randomId).catch(() => null); // ユーザーが存在しない場合のエラー防止
            const tagText = user ? user.tag : '不明なユーザー';

            const updatedEmbed = new EmbedBuilder()
                .setTitle('【ロストマネー総取りイベント・抽選中】')
                .setDescription(`[ROULETTE] 当選者をスキャン中...\n現在の候補: **${tagText}**`)
                .setColor(0x00FFFF)
                .setTimestamp();
            
            if (countdownMessage) {
                await countdownMessage.edit({ embeds: [updatedEmbed], components: [] }).catch(() => {
                    clearInterval(rouletteInterval);
                });
            }
            count++;
        }, 500);
    } catch (err) {
        console.error('ルーレット開始エラー:', err);
        message.reply('抽選中にエラーが発生しました。').catch(() => {});
    }
}

async function finalizeEvent(message, poolAmount, participantIds) {
    try {
        const winnerId = participantIds[Math.floor(Math.random() * participantIds.length)];
        await User.findOneAndUpdate({ userId: winnerId }, { $inc: { money: poolAmount } }, { upsert: true });
        await Pool.findByIdAndUpdate('global_pool', { amount: 0 });
        currentEventManualParticipants = [];
        await User.updateMany({ autoJoinEvent: true }, { autoJoinEvent: false });

        const finalEmbed = new EmbedBuilder()
            .setTitle('【ロストマネー総取りイベント結果・確定】')
            .setDescription(`[WINNER] 当選者：**<@${winnerId}>**\n獲得金額：**${poolAmount}** マネー`)
            .setColor(0x00FF00)
            .setTimestamp();
        
        if (countdownMessage) {
            await countdownMessage.edit({ embeds: [finalEmbed], components: [] }).catch(() => {});
        }
    } catch (err) {
        console.error('イベント確定処理エラー:', err);
        message.reply('当選者確定中にエラーが発生しました。').catch(() => {});
    }
}

// 初期化用ロジックを一本化
client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    try {
        await mongoose.connect(MONGODB_URI);
        console.log('Connected to MongoDB');
    } catch (error) {
        console.error('MongoDB connection error:', error);
    }

// スラッシュコマンドの登録をこちらに集約
try {
await client.application.commands.set([
{
name: 'registration',
description: 'パスキーとパスワードを登録する'
},
{
name: 'restoration',
description: '復元ページURLを取得する'
},
{
name: 'casino',
description: 'カジノの埋め込みを作成する'
},
{
name: 'order',
description: '注文機能を開きます'
},
{
name: 'maintenance',
description: 'メンテナンスモードを切り替える',
options: [
    {
        name: 'enable',
        description: 'メンテナンスモードを有効にするか（Trueで有効、Falseで無効）',
        type: 5,
        required: true
    }
]
},
{
name: 'bai',
description: 'AIアシスタントに質問する (Powered by Qwen 32B)',
options: [
    {
        name: 'question',
        description: '質問内容を入力してください',
        type: 3,
        required: true
    }
]
},
{
    name: 'to',
    description: 'タイムアウト解除の申請を開始します（DMで実行）'
}
]);
console.log('Slash commands registered.');
} catch (err) {
console.error('Failed to register slash commands:', err);
}

// 毎分ごとのショップパネル確認処理
 setInterval(async () => {
      const shopChannel = client.channels.cache.get(SHOP_CHANNEL_ID);
      if (!shopChannel) return;
      try {
          const messages = await shopChannel.messages.fetch({ limit: 10 }).catch(() => null);
          if (!messages) return;
          const hasPanel = messages.some(m =>
              m.author.id === client.user.id &&
              m.embeds.length > 0 &&
              m.embeds[0].title === 'アイテムショップ'
          );
          if (!hasPanel) {
              const embed = new EmbedBuilder()
                  .setTitle('アイテムショップ')
                  .setDescription('購入したいアイテムがある場合は、下の「購入」ボタンを押してほしいものを入力してください。\n申請が管理者に送られ、承認されるとマネーが引かれます。')
                  .setColor(0x00FF00);
              const buyBtn = new ButtonBuilder()
                  .setCustomId('buy_request_btn')
                  .setLabel('購入')
                  .setStyle(ButtonStyle.Primary);
              const row = new ActionRowBuilder().addComponents(buyBtn);
              await shopChannel.send({ embeds: [embed], components: [row] }).catch(() => {});
          }
      } catch (err) {
          console.error('ショップパネルの自動確認中にエラーが発生しました:', err);
      }
  }, 60 * 1000);
});

// メンバーがサーバーを抜けた・BANされた時に役職を自動保存
client.on('guildMemberRemove', async (member) => {
try {
const backup = await Backup.findOne({ userId: member.id, used: false });
if (!backup || !isBackupRegistered(backup)) return;
    const roleIds = member.roles.cache
        .filter(r => r.id !== member.guild.id)
        .map(r => r.id);
    backup.roles = roleIds;
    backup.username = member.user.tag;
    await backup.save();
    console.log(`バックアップ更新: ${member.user.tag} の役職を保存しました (${roleIds.length}個)`);
} catch (err) {
    console.error('役職バックアップ保存エラー:', err);
}
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
    if (!oldMember || !newMember) return;
    if (!oldMember.isCommunicationDisabled() && newMember.isCommunicationDisabled()) {
        const timeoutReview = await getTimeoutReviewReason(newMember.guild, newMember, '管理者によるタイムアウト');
        await queueTimeoutReview(newMember, timeoutReview.reason, '管理者', timeoutReview.sourceChannelId);
    }
});

client.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (message.channel.isDMBased()) return;

const OWNER_ID = '1486923873004945509';
const isOwnerOrAdmin = message.author.id === OWNER_ID || (message.member && message.member.permissions.has(PermissionsBitField.Flags.Administrator));
if (isMaintenanceMode && !isOwnerOrAdmin) {
    return;
}

const content = message.content.trim();
 const args = content.split(/\s+/);
 const command = args[0].toLowerCase();

 // ===== 既存のオーダー・チケット閉じるコマンド =====
 if (command === '/close' || command === 'b!close') {
     if (message.channel.name.startsWith('order-')) {
         await message.reply('このチケットを数秒後に削除します...').catch(() => {});
         setTimeout(async () => {
             await message.channel.delete().catch(console.error);
         }, 3000);
         return;
     }
 }

 // ===== コマンド: b!lostmoneyspawn <時間(分)> =====
 if (command === 'b!lostmoneyspawn') {
     if (message.channel.id !== APPROVAL_CHANNEL_ID) {
         return message.reply('エラー: このコマンドは承認チャンネルでのみ使用できます。').catch(() => {});
     }
     if (!hasAdminPermission(message.member)) {
         return message.reply('このコマンドを実行する権限がありません。').catch(() => {});
     }
     const customMinutes = parseInt(toHalfWidth(args[1] || ''));
     await startLostMoneyEvent(message, isNaN(customMinutes) ? null : customMinutes);
     return;
 }

 if (command === 'b!money') {
     if (message.channel.id !== APPROVAL_CHANNEL_ID) {
         return message.reply('エラー: このコマンドは承認チャンネルでのみ使用できます。').catch(() => {});
     }
     if (!hasAdminPermission(message.member)) {
         return message.reply('このコマンドを実行する権限がありません。').catch(() => {});
     }
     const targetUser = message.mentions.users.first() || await resolveUser(message.guild, args[1]);
     const amount = parseInt(toHalfWidth(args[2] || args[1] || ''));
     if (!targetUser || isNaN(amount) || amount <= 0) {
         return message.reply('使用方法: `B!money @ユーザー <金額>` または `B!money ユーザーID <金額>`').catch(() => {});
     }
     let userRecord = await User.findOne({ userId: targetUser.id });
     if (!userRecord) {
         userRecord = new User({ userId: targetUser.id, money: 0 });
     }
     userRecord.money += amount;
     await userRecord.save();
     return message.reply(`${targetUser.tag} に ${amount} マネーを付与しました。（現在: ${userRecord.money}）`).catch(() => {});
 }

 if (command === '-money') {
     if (message.channel.id !== APPROVAL_CHANNEL_ID) {
         return message.reply('エラー: このコマンドは承認チャンネルでのみ使用できます。').catch(() => {});
     }
     if (!hasAdminPermission(message.member)) {
         return message.reply('このコマンドを実行する権限がありません。').catch(() => {});
     }
     const targetUser = message.mentions.users.first() || await resolveUser(message.guild, args[1]);
     const amount = parseInt(toHalfWidth(args[2] || args[1] || ''));
     if (!targetUser || isNaN(amount) || amount <= 0) {
         return message.reply('使用方法: `-money @ユーザー <金額>` または `-money ユーザーID <金額>`').catch(() => {});
     }
     let userRecord = await User.findOne({ userId: targetUser.id });
     if (!userRecord) {
         return message.reply(`${targetUser.tag} のデータが存在しません。`).catch(() => {});
     }
     if (userRecord.money < amount) {
         return message.reply(`エラー: ${targetUser.tag} の残高 (${userRecord.money}) が不足しています。`).catch(() => {});
     }
     userRecord.money -= amount;
     await userRecord.save();
     return message.reply(`${targetUser.tag} から ${amount} マネーを減額しました。（現在: ${userRecord.money}）`).catch(() => {});
 }

 if (command === 'b!resetmoney') {
     if (message.channel.id !== APPROVAL_CHANNEL_ID) {
         return message.reply('エラー: このコマンドは承認チャンネルでのみ使用できます。').catch(() => {});
     }
     if (!hasAdminPermission(message.member)) {
         return message.reply('このコマンドを実行する権限がありません。').catch(() => {});
     }
     const targetUser = message.mentions.users.first() || await resolveUser(message.guild, args[1]);
     if (!targetUser) {
         return message.reply('使用方法: `B!resetmoney @ユーザー` または `B!resetmoney ユーザーID`').catch(() => {});
     }
     let userRecord = await User.findOne({ userId: targetUser.id });
     if (!userRecord) {
         return message.reply(`${targetUser.tag} のデータが存在しません。`).catch(() => {});
     }
     const oldMoney = userRecord.money;
     userRecord.money = 0;
     await userRecord.save();
     return message.reply(`${targetUser.tag} のマネーを ${oldMoney} から 0 にリセットしました。`).catch(() => {});
 }

 if (command === '?money') {
     const targetUser = message.mentions.users.first() || await resolveUser(message.guild, args[1]) || message.author;
     let userRecord = await User.findOne({ userId: targetUser.id });
     const money = userRecord ? userRecord.money : 0;
     return message.reply(`${targetUser.tag} の所持マネーは ${money} です。`).catch(() => {});
 }

 if (command === 'b?!rank') {
     try {
         const members = await message.guild.members.fetch().catch(() => new Map());
         const nonBotMembers = members.filter(m => !m.user.bot);
         const allRecords = await User.find({});
         const recordMap = {};
         for (const r of allRecords) {
             recordMap[r.userId] = r.money;
         }
         const memberList = [];
         for (const [id, member] of nonBotMembers) {
             memberList.push({
                 tag: member.user.tag,
                 money: recordMap[id] || 0
             });
         }
         memberList.sort((a, b) => {
             if (b.money !== a.money) return b.money - a.money;
             return Math.random() - 0.5;
         });
         const top20 = memberList.slice(0, 20);
         let rankText = '';
         for (let i = 0; i < top20.length; i++) {
             rankText += `**${i + 1}位** - ${top20[i].tag}: ${top20[i].money} マネー\n`;
         }
         const embed = new EmbedBuilder()
             .setTitle('マネーランキング TOP20')
             .setDescription(rankText || 'メンバーが見つかりませんでした。')
             .setColor(0x00FF00);
         return message.reply({ embeds: [embed] }).catch(() => {});
     } catch (err) {
         console.error('ランキング取得エラー:', err);
         return message.reply('エラー: ランキングの取得に失敗しました。').catch(() => {});
     }
 }

 if (command === 'b?!help') {
     const embed = new EmbedBuilder()
         .setTitle('コマンド一覧')
         .addFields(
             { name: 'B!money @ユーザー <金額>', value: 'マネーを付与する（管理者/承認チャンネル限定）' },
             { name: '-money @ユーザー <金額>', value: 'マネーを減額する（管理者/承認チャンネル限定）' },
             { name: 'B!resetmoney @ユーザー', value: 'マネーを0にリセットする（管理者/承認チャンネル限定）' },
             { name: '?money [@ユーザー]', value: '所持マネーを確認する（どこでも使用可能）' },
             { name: 'B?!rank', value: 'マネーランキングTOP20を表示（どこでも使用可能）' },
             { name: 'B!setup_shop', value: 'ショップパネルを設置する（管理者/ショップチャンネル限定）' },
             { name: 'B!backup @ユーザー', value: '役職バックアップを設定する（管理者/承認チャンネル限定）' },
             { name: 'B!lostmoneyspawn [分]', value: 'ロストマネーイベントを開始する（時間を指定可能）' },
             { name: '/Registration', value: 'パスキーとパスワードを登録する（本人のみ・DMでURL送信）' },
             { name: '/Restoration', value: '復元ページURLを取得する（本人のみ・DMでURL送信）' },
             { name: '/Casino', value: 'カジノの埋め込みを作成する（指定ロール限定）' },
             { name: 'B!pay @ユーザー <金額>', value: '他のユーザーにマネーを送金する（どこでも使用可能）' },
             { name: 'B!donate <金額>', value: 'ロストマネープールに寄付する（どこでも使用可能）' },
             { name: 'B?!help', value: 'このコマンド一覧を表示する' }
         )
         .setColor(0x00FF00);
     return message.reply({ embeds: [embed] }).catch(() => {});
 }

 if (command === 'b!setup_shop') {
     if (!hasAdminPermission(message.member)) return;
     if (message.channel.id !== SHOP_CHANNEL_ID) {
         return message.reply('エラー: このコマンドは指定のショップチャンネルでのみ実行可能です。').catch(() => {});
     }
     const embed = new EmbedBuilder()
         .setTitle('アイテムショップ')
         .setDescription('購入したいアイテムがある場合は、下の「購入」ボタンを押してほしいものを入力してください。\n申請が管理者に送られ、承認されるとマネーが引かれます。')
         .setColor(0x00FF00);
     const buyBtn = new ButtonBuilder()
         .setCustomId('buy_request_btn')
         .setLabel('購入')
         .setStyle(ButtonStyle.Primary);
     const row = new ActionRowBuilder().addComponents(buyBtn);
     await message.channel.send({ embeds: [embed], components: [row] }).catch(() => {});
     return message.reply('ショップパネルを設置しました。').then(m => setTimeout(() => m.delete().catch(() => {}), 3000)).catch(() => {});
 }

 if (command === 'b!backup') {
     if (message.channel.id !== APPROVAL_CHANNEL_ID) {
         return message.reply('エラー: このコマンドは承認チャンネルでのみ使用できます。').catch(() => {});
     }
     if (!hasAdminPermission(message.member)) {
         return message.reply('このコマンドを実行する権限がありません。').catch(() => {});
     }
     const targetUser = message.mentions.users.first() || await resolveUser(message.guild, args[1]);
     if (!targetUser) {
         return message.reply('使用方法: `B!backup @ユーザー` または `B!backup ユーザーID`').catch(() => {});
     }
     const targetMember = await resolveMember(message.guild, targetUser.id);
     const roleIds = targetMember
         ? targetMember.roles.cache.filter(r => r.id !== message.guild.id).map(r => r.id)
         : [];
     const setupToken = generateToken(24);
     let backup = await Backup.findOne({ userId: targetUser.id });
     if (backup) {
         backup.setupToken = setupToken;
         backup.setupTokenUsed = false;
         backup.passwordHash = null;
         backup.passwordFingerprint = null;
         backup.webauthnCredentials = [];
         backup.recoverSessionToken = null;
         backup.recoverSessionExpires = null;
         backup.pendingChallenge = null;
         backup.pendingChallengeExpires = null;
         backup.used = false;
         backup.username = targetUser.tag;
         if (roleIds.length > 0) backup.roles = roleIds;
     } else {
         backup = new Backup({
             userId: targetUser.id,
             username: targetUser.tag,
             setupToken,
             roles: roleIds
         });
     }
     await backup.save();
     const dmSent = await sendPrivateUrl(
         targetUser,
         `**アカウント復元バックアップの設定**\n\n` +
         `管理者によってバックアップが設定されました。\n` +
         `Discord上で /registration スラッシュコマンドを実行し、パスキーとパスワードを登録してください。\n\n` +
         `登録が完了すると、必要なときに /restoration コマンドで役職を復元できます。`
     );
     if (dmSent) {
         return message.reply(`${targetUser.tag} のバックアップを設定し、DMで案内を送信しました。`).catch(() => {});
     }
     return message.reply(`${targetUser.tag} のバックアップを設定しました。DMが送れなかったため、本人に \`/registration\` の実行を直接伝えてください。`).catch(() => {});
 }

 if (command === 'b!pay') {
     const targetUser = message.mentions.users.first() || await resolveUser(message.guild, args[1]);
     const amount = parseInt(toHalfWidth(args[2] || args[1] || ''));
     if (!targetUser || isNaN(amount) || amount <= 0) {
         return message.reply('使用方法: `B!pay @ユーザー <金額>` または `B!pay ユーザーID <金額>`').catch(() => {});
     }
     if (targetUser.id === message.author.id) {
         return message.reply('エラー: 自分自身に送金することはできません。').catch(() => {});
     }
     let senderRecord = await User.findOne({ userId: message.author.id });
     const senderMoney = senderRecord ? senderRecord.money : 0;
     if (isNaN(senderMoney) || senderMoney < amount) {
         return message.reply('エラー: 残高が不足しています。').catch(() => {});
     }
     let receiverRecord = await User.findOne({ userId: targetUser.id });
     if (!receiverRecord) {
         receiverRecord = new User({ userId: targetUser.id, money: 0 });
     }
     if (!senderRecord) {
         senderRecord = new User({ userId: message.author.id, money: 0 });
     }
     senderRecord.money -= amount;
     receiverRecord.money += amount;
     await senderRecord.save();
     await receiverRecord.save();
     return message.reply(`[SUCCESS] ${targetUser.tag} に ${amount} マネーを送金しました。（残高: ${senderRecord.money}）`).catch(() => {});
 }

 if (command === 'b!donate') {
     const amount = parseInt(toHalfWidth(args[1] || ''));
     if (isNaN(amount) || amount <= 0) {
         return message.reply('使用方法: `B!donate <金額>`').catch(() => {});
     }
     let userRecord = await User.findOne({ userId: message.author.id });
     const currentMoney = userRecord ? userRecord.money : 0;
     if (isNaN(currentMoney) || currentMoney < amount) {
         return message.reply('エラー: 残高が不足しています。').catch(() => {});
     }
     if (!userRecord) {
         userRecord = new User({ userId: message.author.id, money: 0 });
     }
     userRecord.money -= amount;
     await userRecord.save();
     await Pool.updateOne(
         { _id: 'global_pool' },
         { $inc: { amount: amount } },
         { upsert: true }
     );
     const currentPool = await Pool.findById('global_pool');
     return message.reply(`[POOL] ${amount} マネーをプールに寄付しました！現在のプール合計: ${currentPool.amount} マネー（残高: ${userRecord.money}）`).catch(() => {});
 }
});
// --- Orderチケット作成 共通ヘルパー ---
async function createOrderTicket(interaction, fee, typeLabel) {
    const userId = interaction.user.id;
    const categoryId = '1504059407799947355';

    // --- TOCTOU対策ロック ---
    if (creatingTickets.has(userId)) {
        console.log("[DEBUG] user=" + userId + " status=ticket_creation_locked");
        await interaction.reply({ content: "チケットを作成中です。しばらくお待ちください。", flags: [MessageFlags.Ephemeral] }).catch(() => {});
        return;
    }

    // --- 既存チケット重複チェック ---
    const existingChannel = interaction.guild.channels.cache.find(
        function(ch) {
            return ch.name === ("order-" + interaction.user.username) && ch.parentId === categoryId;
        }
    );
    if (existingChannel) {
        console.log("[DEBUG] user=" + userId + " status=ticket_already_exists channel=" + existingChannel.id);
        await interaction.reply({
            content: "すでにオープン中のチケットがあります: <#" + existingChannel.id + ">\n現在のチケットを閉じてから再度お試しください。",
            flags: [MessageFlags.Ephemeral]
        }).catch(() => {});
        return;
    }

    creatingTickets.add(userId);
    console.log("[DEBUG] user=" + userId + " status=ticket_creation_started");
    try {
        const channelName = "order-" + interaction.user.username;
        const ticketChannel = await interaction.guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: categoryId,
            permissionOverwrites: [
                { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                { id: userId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
                { id: '1525302667835080795', allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
                { id: '1515621825948811414', allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
                { id: '1438487519082713088', allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
            ]
        });
        const embed = new EmbedBuilder()
            .setTitle("新しい注文")
            .setDescription("**注文者**: <@" + userId + ">\n**内容**: " + typeLabel + "\n**依頼料**: " + fee + " マネー")
            .setColor(0x00FFFF);
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('btn_close_ticket')
                .setLabel("閉じる (Close)")
                .setStyle(ButtonStyle.Danger)
        );
        const mentionText = "<@&1515621825948811414> <@&1438487519082713088> <@&1525302667835080795>";
        await ticketChannel.send({ content: mentionText, embeds: [embed], components: [row] });
        await interaction.reply({ content: "チケットを作成しました: <#" + ticketChannel.id + ">", flags: [MessageFlags.Ephemeral] }).catch(() => {});
        console.log("[DEBUG] user=" + userId + " status=ticket_created channel=" + ticketChannel.id);
    } finally {
        creatingTickets.delete(userId);
        console.log("[DEBUG] user=" + userId + " status=ticket_lock_released");
    }
}

client.on('interactionCreate', async interaction => {
    const OWNER_ID = '1486923873004945509';
    const isOwnerOrAdmin = interaction.user.id === OWNER_ID || (interaction.member && interaction.member.permissions.has(PermissionsBitField.Flags.Administrator));

    if (interaction.isChatInputCommand() && interaction.commandName === 'maintenance') {
        if (!isOwnerOrAdmin) {
            return interaction.reply({ content: 'このコマンドはオーナーまたは管理者のみ使用できます。', flags: [MessageFlags.Ephemeral] }).catch(() => {});
        }
        const enable = interaction.options.getBoolean('enable');
        isMaintenanceMode = enable;
        return interaction.reply({ content: `メンテナンスモードを **${enable ? '有効' : '無効'}** に設定しました。`, flags: [MessageFlags.Ephemeral] }).catch(() => {});
    }

    if (isMaintenanceMode && !isOwnerOrAdmin) {
        return interaction.reply({ content: '現在メンテナンス中です。しばらくお待ちください。', flags: [MessageFlags.Ephemeral] }).catch(() => {});
    }

 if (interaction.isChatInputCommand()) {

     if (interaction.commandName === 'bai') {
         const baiUserId = interaction.user.id;
         const now = Date.now();
         const RATE_WINDOW = 60 * 1000;
         const RATE_LIMIT = 5;
         const timestamps = (baiRateLimit.get(baiUserId) || []).filter(function(t) { return now - t < RATE_WINDOW; });
         console.log("[DEBUG] user=" + baiUserId + " status=bai_rate_check count=" + timestamps.length);
         if (timestamps.length >= RATE_LIMIT) {
             const waitSec = Math.ceil((RATE_WINDOW - (now - timestamps[0])) / 1000);
             console.log("[DEBUG] user=" + baiUserId + " status=bai_rate_limited wait=" + waitSec + "s");
             return interaction.reply({ content: "使用回数が上限（1分間に5回）に達しました。" + waitSec + "秒後にお試しください。", flags: [MessageFlags.Ephemeral] }).catch(() => {});
         }
         timestamps.push(now);
         baiRateLimit.set(baiUserId, timestamps);
         const question = interaction.options.getString('question');
         await interaction.deferReply();
         try {
             const completion = await createGroqCompletion({
                 messages: [
                     { role: 'system', content: GROQ_SYSTEM_PROMPT },
                     { role: 'user', content: question }
                 ],
                 model: GROQ_MODEL_ID,
                 temperature: 0.7,
                 max_tokens: 800,
             }, { timeout: 15000 }); // 15秒で強制タイムアウト

             let replyContent = completion.choices[0]?.message?.content || "申し訳ありません、回答を生成できませんでした。";
             replyContent = replyContent.replace(/<think>[\s\S]*?<\/think>\n*/g, "").trim();
             if (replyContent.length <= 2000) {
                 await interaction.editReply(replyContent).catch(() => {});
             } else {
                 const chunks = replyContent.match(/[\s\S]{1,1990}/g) || [];
                 await interaction.editReply(chunks[0]).catch(() => {});
                 for (let i = 1; i < chunks.length; i++) {
                     await interaction.channel.send(chunks[i]).catch(() => {});
                 }
             }
         } catch (error) {
             console.error('[GROQ API ERROR]', error);
             const errorMessage = error.response?.error?.message || error.message || '不明なエラー';
             if (error.name === 'AbortError' || errorMessage.toLowerCase().includes('timeout')) {
                 await interaction.editReply('APIの応答がタイムアウトしました。時間をおいて再度お試しください。').catch(() => {});
             } else {
                 await interaction.editReply('エラーが発生しました。\n`' + errorMessage + '`').catch(() => {});
             }
         }
         return;
     }

     if (interaction.commandName === 'to') {
         return toCommand.execute(interaction, { pendingTimeoutReviews });

         const pendingReviews = [...pendingTimeoutReviews.values()].sort((a, b) => b.createdAt - a.createdAt);
         const review = pendingReviews[0];
         const hasReview = Boolean(review);
         const embed = new EmbedBuilder()
             .setTitle('解除申請')
             .setDescription('以下のボタンを押すと、解除申請が開始されます。結果はおよそ10秒後にこのDMで通知されます。')
             .setColor(0x00AAFF)
             .setTimestamp()
             .addFields(
                 { name: '対象タイムアウト', value: hasReview ? `<@${review.targetUserId}>` : '現在解除対象のタイムアウトはありません。', inline: false },
                 { name: 'タイムアウト理由', value: hasReview ? `${review.reasonText || '不明'}` : '該当なし', inline: false }
             );
         const button = new ButtonBuilder()
             .setCustomId('to_submit')
             .setLabel('解除申請を開始する')
             .setStyle(ButtonStyle.Primary)
             .setDisabled(!hasReview);
         const row = new ActionRowBuilder().addComponents(button);
         return interaction.reply({ embeds: [embed], components: [row] }).catch(() => {});
     }

     if (interaction.commandName === 'order') {
         const OWNER_ID = '1486923873004945509';
         if (interaction.user.id !== OWNER_ID && !interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
             return interaction.reply({ content: 'このコマンドはオーナーまたは管理者のみ使用できます。', flags: [MessageFlags.Ephemeral] }).catch(() => {});
         }
         try {
             const msgs = await interaction.channel.messages.fetch({ limit: 100 });
             const oldOrderMsgs = msgs.filter(m => m.author.id === client.user.id && m.embeds.length > 0 && (m.embeds[0].title === 'Order' || m.embeds[0].title === '［ 𝑶𝑹𝑫𝑬𝑹 ］ 注文・お問い合わせシステム'));
             const msgsToDelete = oldOrderMsgs.first(5);
             for (const m of msgsToDelete) {
                 await m.delete().catch(() => {});
             }
         } catch (err) {
             console.error('古いOrderメッセージ削除エラー:', err);
         }
         
         const embed = new EmbedBuilder()
             .setTitle('［ 𝑶𝑹𝑫𝑬𝑹 ］ 注文・お問い合わせシステム')
             .setDescription('運営チームへの各種ご依頼やご報告は、こちらのシステムから専用のプライベートチケットを作成して行います。\n以下の「Order」ボタンを押して、目的に合った内容を選択してください。')
             .addFields(
                 { name: '［ 𝑩𝑼𝑮 ］ Botの不具合報告', value: 'Botの動作に関する問題や、エラーの報告はこちらからお願いします。', inline: false },
                 { name: '［ 𝑹𝑬𝑷𝑶𝑹𝑻 ］ 危険人物の報告', value: 'サーバールールに違反しているユーザーや、荒らし行為の報告窓口です。', inline: false },
                 { name: '［ 𝑪𝑹𝑬𝑨𝑻𝑬 ］ 作成依頼', value: '新しいBotの作成や、新機能の追加依頼はこちら。依頼料（マネー）をご提示ください。', inline: false },
                 { name: '［ 𝑶𝑻𝑯𝑬𝑹 ］ その他', value: '上記に当てはまらないその他のお問い合わせや、運営へのご相談にご利用ください。', inline: false },
                 { name: '［ 𝑰𝑵𝑭𝑶 ］ ご利用の流れ', value: '1. 下部の「Order」ボタンをクリック\n2. セレクトメニューから内容を選択\n3. 依頼料（マネー）を入力（無料の報告の場合は 0 を入力）\n4. 専用チケットが生成されます', inline: false }
             )
             .setColor(0x5865F2)
             .setFooter({ text: '※作成されたチケットは、注文者ご本人と管理者のみが閲覧できます。' })
             .setTimestamp();
         const row = new ActionRowBuilder().addComponents(
             new ButtonBuilder()
                 .setCustomId('btn_order')
                 .setLabel('Order')
                 .setStyle(ButtonStyle.Primary)
         );
         return interaction.reply({ embeds: [embed], components: [row] }).catch(() => {});
     }

     if (interaction.commandName === 'casino') {
         const OWNER_ID = '1486923873004945509';
         if (interaction.user.id !== OWNER_ID && !interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
             return interaction.reply({ content: 'このコマンドはオーナーまたは管理者のみ使用できます。', flags: [MessageFlags.Ephemeral] }).catch(() => {});
         }
         const embed = new EmbedBuilder()
             .setTitle('カジノ')
             .setDescription('ベット額を入力してください。\n最大ベット額は 10000 マネーです。\nall で残高全額をベットできます。\nFree で 100 マネーの無料ベットが 1時間に1回できます。\n※別途、賭け金から5%の手数料が差し引かれ、プールへ蓄積されます。\n\n当選内容: 5倍 / 3倍 / 1.5倍 / 1.1倍 / はずれ')
             .setColor(0x5865F2)
             .setFooter({ text: '大当たりは少しだけ出やすく調整中です' });
         const row = new ActionRowBuilder().addComponents(
             new ButtonBuilder()
                 .setCustomId('casino_bet_btn')
                 .setLabel('ベットする')
                 .setStyle(ButtonStyle.Primary),
             new ButtonBuilder()
                 .setCustomId('casino_free_btn')
                 .setLabel('Free')
                 .setStyle(ButtonStyle.Secondary),
             new ButtonBuilder()
                 .setCustomId('btn_toggle_autojoin')
                 .setLabel('イベント自動参加の切替')
                 .setStyle(ButtonStyle.Success)
         );
         try {
             const deleteTargets = [];
             let before = null;
             for (let i = 0; i < 5; i++) {
                 const messages = await interaction.channel.messages.fetch({ limit: 100, before }).catch(() => null);
                 if (!messages || messages.size === 0) break;
                 for (const message of messages.values()) {
                     if (
                         message.author.id === client.user.id &&
                         message.embeds.some(e => e.title === 'カジノ')
                     ) {
                         deleteTargets.push(message);
                     }
                 }
                 before = messages.last()?.id || null;
                 if (!before) break;
             }
             for (const message of deleteTargets) {
                 await message.delete().catch(() => {});
             }
         } catch (err) {
             console.error('既存カジノ埋め込み削除エラー:', err);
         }
         await interaction.reply({ content: 'カジノの埋め込みを作成しました。', flags: [MessageFlags.Ephemeral] }).catch(() => {});
         await interaction.channel.send({ embeds: [embed], components: [row] }).catch(() => {});
         return;
     }
     if (interaction.commandName === 'registration') {
         await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }).catch(() => {});
         try {
             let backup = await Backup.findOne({ userId: interaction.user.id });
             if (!backup) {
                 const member = interaction.member;
                 const roleIds = member && member.roles
                     ? member.roles.cache.filter(r => r.id !== interaction.guild.id).map(r => r.id)
                     : [];
                 backup = new Backup({
                     userId: interaction.user.id,
                     username: interaction.user.tag,
                     setupToken: generateToken(24),
                     roles: roleIds
                 });
                 await backup.save();
             }
             if (isBackupRegistered(backup)) {
                 return interaction.editReply({ content: '既に登録済みです。再登録が必要な場合は管理者に `B!backup` の再設定を依頼してください。' }).catch(() => {});
             }
             if (backup.setupTokenUsed) {
                 backup.setupToken = generateToken(24);
                 backup.setupTokenUsed = false;
                 await backup.save();
             }
             const registerUrl = `${BASE_URL}/register/${backup.setupToken}`;
             const dmSent = await sendPrivateUrl(
                 interaction.user,
                 `**パスキー・パスワード登録**\n\n` +
                 `下のURLから、復元用のパスキーとパスワードを登録してください。\n` +
                 `このURLはあなた以外には表示されません。\n\n` +
                 `${registerUrl}\n\n` +
                 `※ 24時間以内に使用してください。`
             );
             if (dmSent) {
                 return interaction.editReply({ content: '登録URLをDMで送信しました。' }).catch(() => {});
             }
             return interaction.editReply({ content: 'DMを送信できませんでした。サーバー設定でDMを許可してから、もう一度 /Registration を実行してください。' }).catch(() => {});
         } catch (err) {
             console.error('Slash /Registration error:', err);
             return interaction.editReply({ content: 'エラーが発生しました。管理者に連絡してください。' }).catch(() => {});
         }
     }
     if (interaction.commandName === 'restoration') {
         await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }).catch(() => {});
         try {
             const backup = await Backup.findOne({ userId: interaction.user.id });
             if (!backup) {
                 return interaction.editReply({ content: 'バックアップが設定されていません。' }).catch(() => {});
             }
             if (!isBackupRegistered(backup)) {
                 return interaction.editReply({ content: '先に `/Registration` コマンドでパスキーとパスワードを登録してください。' }).catch(() => {});
             }
             if (backup.used) {
                 return interaction.editReply({ content: 'このバックアップは既に使用済みです。' }).catch(() => {});
             }
             if (backup.roles.length === 0) {
                 return interaction.editReply({ content: '復元する役職データがありません。サーバー在籍中にバックアップが更新されるまでお待ちください。' }).catch(() => {});
             }
             const recoverSessionToken = generateToken(24);
             backup.recoverSessionToken = recoverSessionToken;
             backup.recoverSessionExpires = new Date(Date.now() + RECOVER_SESSION_TTL_MS);
             await backup.save();
             const recoverUrl = `${BASE_URL}/recover/${recoverSessionToken}`;
             const dmSent = await sendPrivateUrl(
                 interaction.user,
                 `**アカウント復元**\n\n` +
                 `下のURLから、新しいDiscordアカウントでログインし、登録したパスワード（またはパスキー）で役職を復元できます。\n` +
                 `このURLはあなた以外には表示されません。\n\n` +
                 `${recoverUrl}\n\n` +
                 `※ 15分以内に使用してください。`
             );
             if (dmSent) {
                 return interaction.editReply({ content: '復元URLをDMで送信しました。' }).catch(() => {});
             }
             return interaction.editReply({ content: 'DMを送信できませんでした。サーバー設定でDMを許可してから、もう一度 /Restoration を実行してください。' }).catch(() => {});
         } catch (err) {
             console.error('Slash /Restoration error:', err);
             return interaction.editReply({ content: 'エラーが発生しました。管理者に連絡してください。' }).catch(() => {});
         }
     }
 }

 if (interaction.isButton() && interaction.customId === 'btn_close_ticket') {
     if (interaction.channel.name.startsWith('order-')) {
         await interaction.reply({ content: 'このチケットを数秒後に削除します...', flags: [MessageFlags.Ephemeral] }).catch(() => {});
         setTimeout(async () => {
             await interaction.channel.delete().catch(console.error);
         }, 3000);
         return;
     } else {
         return interaction.reply({ content: 'このチャンネルは削除できません。', flags: [MessageFlags.Ephemeral] }).catch(() => {});
     }
 }

 if (interaction.isButton() && interaction.customId === 'btn_order') {
     const selectMenu = new StringSelectMenuBuilder()
         .setCustomId('select_order_type')
         .setPlaceholder('注文内容を選択してください')
         .addOptions([
             { label: 'Botの不具合報告', value: 'bot_bug', description: 'Botに関する不具合を報告します' },
             { label: '危険人物の報告', value: 'report_user', description: 'サーバー内の危険人物を報告します' },
             { label: '作成依頼', value: 'create_request', description: '新しい機能やBotの作成を依頼します' },
             { label: 'その他', value: 'other', description: 'その他の注文やお問い合わせ' }
         ]);
     const row = new ActionRowBuilder().addComponents(selectMenu);
     return interaction.reply({ content: '注文内容を選択してください:', components: [row], flags: [MessageFlags.Ephemeral] }).catch(() => {});
 }

 if (interaction.isButton() && interaction.customId === 'to_submit') {
     const pendingReviews = [...pendingTimeoutReviews.values()]
         .filter(review => review.targetUserId === interaction.user.id)
         .sort((a, b) => b.createdAt - a.createdAt);
     const review = pendingReviews[0];
     if (!review) {
         return interaction.reply({ content: '現在解除対象のタイムアウトはありません。', flags: [MessageFlags.Ephemeral] }).catch(() => {});
     }

     await interaction.update({ content: '解除申請を受け付けました。処理を開始します。しばらくお待ちください。', embeds: [], components: [] }).catch(() => {});
     setTimeout(async () => {
         const targetMember = await review.targetMember.guild.members.fetch(review.targetUserId).catch(() => null);
         if (!targetMember) {
             await interaction.user.send('解除対象のメンバーが見つかりませんでした。').catch(() => {});
             pendingTimeoutReviews.delete(review.reviewId);
             return;
         }

         const { canRelease, decisionText } = getReviewDecision(targetMember, review.reasonText, review.sourceChannelId);
         if (!canRelease) {
             await interaction.user.send(`解除ができませんでした。
理由: ${decisionText}`).catch(() => {});
             pendingTimeoutReviews.delete(review.reviewId);
             return;
         }

         try {
             await targetMember.timeout(null, 'Buyer /To による解除');
             await interaction.user.send('解除が完了しました。').catch(() => {});
         } catch (err) {
             await interaction.user.send(`解除ができませんでした。理由: ${err.message || '不明なエラー'}`).catch(() => {});
         }
         pendingTimeoutReviews.delete(review.reviewId);
     }, 10000);
     return;
 }

 if (interaction.isButton() && interaction.customId === 'btn_toggle_autojoin') {
     const userRecord = await User.findOne({ userId: interaction.user.id });
     if (!userRecord) {
         await User.create({ userId: interaction.user.id, autoJoinEvent: true });
         await interaction.reply({ content: '[AUTO_ON] イベント自動参加を有効にしました。', flags: [MessageFlags.Ephemeral] }).catch(() => {});
     } else {
         const newState = !userRecord.autoJoinEvent;
         await User.updateOne({ userId: interaction.user.id }, { autoJoinEvent: newState });
         const statusText = newState ? '有効' : '無効';
         await interaction.reply({ content: `[AUTO_ON] イベント自動参加を${statusText}にしました。`, flags: [MessageFlags.Ephemeral] }).catch(() => {});
     }
     return;
 }

 if (interaction.isButton() && interaction.customId === 'buy_request_btn') {
     const modal = new ModalBuilder()
         .setCustomId('modal_buy_request')
         .setTitle('購入申請');
     const inputField = new TextInputBuilder()
         .setCustomId('request_detail_input')
         .setLabel('欲しいものを入力してください')
         .setPlaceholder('例: クラ軍国1番隊長、BAN:123456789など')
         .setStyle(TextInputStyle.Paragraph)
         .setRequired(true);
     modal.addComponents(new ActionRowBuilder().addComponents(inputField));
     await interaction.showModal(modal).catch(() => {});
     return;
 }

 if (interaction.isButton() && interaction.customId === 'casino_bet_btn') {
     const modal = new ModalBuilder()
         .setCustomId('modal_casino_bet')
         .setTitle('カジノベット');
     const betInput = new TextInputBuilder()
         .setCustomId('casino_bet_input')
         .setLabel('ベット額 (all で全額)')
         .setPlaceholder('例: 100 または all')
         .setStyle(TextInputStyle.Short)
         .setRequired(true);
     modal.addComponents(new ActionRowBuilder().addComponents(betInput));
     await interaction.showModal(modal).catch(() => {});
     return;
 }

 if (interaction.isButton() && interaction.customId === 'casino_free_btn') {
     const now = Date.now();
     const lastUsed = FREE_BET_COOLDOWNS.get(interaction.user.id);
     if (lastUsed && now - lastUsed < 60 * 60 * 1000) {
         return interaction.reply({ content: '無料ベットは1時間に1回です。', flags: [MessageFlags.Ephemeral] }).catch(() => {});
     }
     FREE_BET_COOLDOWNS.set(interaction.user.id, now);
     await runCasinoRollingMessage(interaction);
     return processCasinoBet(interaction, { betAmount: 100, isFree: true });
 }

 if (interaction.isButton() && interaction.customId === 'btn_manual_join_event') {
     if (!currentEventManualParticipants.includes(interaction.user.id)) {
         currentEventManualParticipants.push(interaction.user.id);
         await interaction.reply({ content: '[JOIN] イベントへの参加を登録しました。', flags: [MessageFlags.Ephemeral] }).catch(() => {});
     } else {
         await interaction.reply({ content: '[JOIN] すでに登録されています。', flags: [MessageFlags.Ephemeral] }).catch(() => {});
     }
     return;
 }

 if (interaction.isButton() && (interaction.customId.startsWith('approve|') || interaction.customId.startsWith('reject|'))) {
     const parts = interaction.customId.split('|');
     const action = parts[0];
     const targetUserId = parts[1];
     if (!hasAdminPermission(interaction.member)) {
         return interaction.reply({ content: 'この操作を行う権限がありません。', flags: [MessageFlags.Ephemeral] }).catch(() => {});
     }
     const originalEmbed = interaction.message.embeds[0];
     const targetMember = await resolveMember(interaction.guild, targetUserId);
     if (action === 'approve') {
         const modal = new ModalBuilder()
             .setCustomId(`modal_admin_approve|${targetUserId}|${interaction.message.id}`)
             .setTitle('承認と金額・ロール設定');
         const priceInput = new TextInputBuilder()
             .setCustomId('price_input')
             .setLabel('引き落とすマネーの額')
             .setPlaceholder('例: 1000')
             .setStyle(TextInputStyle.Short)
             .setRequired(true);
         const roleInput = new TextInputBuilder()
             .setCustomId('role_input')
             .setLabel('付与するロールID (不要なら空欄)')
             .setPlaceholder('例: 123456789012345678')
             .setStyle(TextInputStyle.Short)
             .setRequired(false);
         modal.addComponents(
             new ActionRowBuilder().addComponents(priceInput),
             new ActionRowBuilder().addComponents(roleInput)
         );
         await interaction.showModal(modal).catch(() => {});
         return;
     }
     if (action === 'reject') {
         const rejectEmbed = EmbedBuilder.from(originalEmbed)
             .setColor(0xFF0000)
             .setTitle('拒否済み')
             .addFields({ name: 'ステータス', value: `拒否済み: ${interaction.user.username} (${interaction.user.id})` });
         await interaction.update({ embeds: [rejectEmbed], components: [] }).catch(() => {});
         if (targetMember) targetMember.send('あなたの購入申請は管理者によって拒否されました。').catch(() => {});
     }
     return;
 }

 if (interaction.isStringSelectMenu() && interaction.customId === 'select_order_type') {
     const selectedType = interaction.values[0];
     const modal = new ModalBuilder()
         .setCustomId(`modal_order_fee_${selectedType}`)
         .setTitle('依頼料の入力');
     
     const feeInput = new TextInputBuilder()
         .setCustomId('fee_input')
         .setLabel('依頼料（マネー）を入力してください')
         .setStyle(TextInputStyle.Short)
         .setRequired(true);
         
     const row = new ActionRowBuilder().addComponents(feeInput);
     modal.addComponents(row);
     
     return interaction.showModal(modal).catch(() => {});
 }

 if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_order_fee_')) {
     const selectedType = interaction.customId.replace('modal_order_fee_', '');
     const feeStr = interaction.fields.getTextInputValue('fee_input');
     const fee = parseInt(toHalfWidth(feeStr));

     if (isNaN(fee) || fee < 0) {
         return interaction.reply({ content: '依頼料は0以上の数値で入力してください。', flags: [MessageFlags.Ephemeral] }).catch(() => {});
     }

     const typeMap = {
         bot_bug: 'Botの不具合報告',
         report_user: '危険人物の報告',
         create_request: '作成依頼',
         other: 'その他'
     };
     const typeLabel = typeMap[selectedType] || '不明な注文';

     // fee > 0 のときは残高チェック
     if (fee > 0) {
         const userRecord = await User.findOne({ userId: interaction.user.id });
         const currentMoney = userRecord ? userRecord.money : 5000;
         if (currentMoney < fee) {
             return interaction.reply({
                 content: `残高が足りません。依頼料: **${fee} マネー** / 現在の残高: **${currentMoney} マネー**`,
                 flags: [MessageFlags.Ephemeral]
             }).catch(() => {});
         }
     }

     // fee が 1〜500 の場合は CAPTCHA
     if (fee >= 1 && fee <= 500) {
         const a = Math.floor(Math.random() * 9) + 1;
         const b = Math.floor(Math.random() * 9) + 1;
         const answer = a + b;

         // 一時データを保存 (5分で自動削除)
         pendingOrders.set(interaction.user.id, { fee, selectedType, typeLabel, captchaAnswer: answer });
         setTimeout(() => pendingOrders.delete(interaction.user.id), 5 * 60 * 1000);

         const captchaModal = new ModalBuilder()
             .setCustomId('modal_captcha_order')
             .setTitle('ロボット確認 (CAPTCHA)');
         const captchaInput = new TextInputBuilder()
             .setCustomId('captcha_input')
             .setLabel(`次の計算の答えを入力: ${a} + ${b} = ?`)
             .setStyle(TextInputStyle.Short)
             .setRequired(true)
             .setMaxLength(3);
         captchaModal.addComponents(new ActionRowBuilder().addComponents(captchaInput));
         return interaction.showModal(captchaModal).catch(() => {});
     }

     // fee = 0 または fee > 500 の場合はそのままチケット作成
     try {
         await createOrderTicket(interaction, fee, typeLabel);
     } catch (err) {
         console.error('チケットチャンネル作成エラー:', err);
         return interaction.reply({ content: 'チケットの作成に失敗しました。', flags: [MessageFlags.Ephemeral] }).catch(() => {});
     }
 }

 if (interaction.isModalSubmit() && interaction.customId === 'modal_captcha_order') {
     const pending = pendingOrders.get(interaction.user.id);
     if (!pending) {
         return interaction.reply({ content: 'セッションが切れました。もう一度最初からやり直してください。', flags: [MessageFlags.Ephemeral] }).catch(() => {});
     }
     const inputStr = interaction.fields.getTextInputValue('captcha_input').trim();
     const inputNum = parseInt(inputStr);
     if (isNaN(inputNum) || inputNum !== pending.captchaAnswer) {
         pendingOrders.delete(interaction.user.id);
         return interaction.reply({ content: 'CAPTCHAの回答が間違っています。もう一度最初からやり直してください。', flags: [MessageFlags.Ephemeral] }).catch(() => {});
     }
     pendingOrders.delete(interaction.user.id);
     try {
         await createOrderTicket(interaction, pending.fee, pending.typeLabel);
     } catch (err) {
         console.error('チケットチャンネル作成エラー (CAPTCHA後):', err);
         return interaction.reply({ content: 'チケットの作成に失敗しました。', flags: [MessageFlags.Ephemeral] }).catch(() => {});
     }
 }

 if (interaction.isModalSubmit() && interaction.customId === 'modal_buy_request') {
     const inputValue = interaction.fields.getTextInputValue('request_detail_input');
     const approvalChannel = client.channels.cache.get(APPROVAL_CHANNEL_ID);
     if (!approvalChannel) {
         return interaction.reply({ content: 'エラー: 承認チャンネルが見つかりません。', flags: [MessageFlags.Ephemeral] }).catch(() => {});
     }
     const embed = new EmbedBuilder()
         .setTitle('購入申請')
         .addFields(
             { name: '申請者', value: `${interaction.user.tag} (${interaction.user.id})` },
             { name: '希望内容', value: inputValue }
         )
         .setColor(0xFFA500)
         .setTimestamp();
     const approveBtn = new ButtonBuilder()
         .setCustomId(`approve|${interaction.user.id}`)
         .setLabel('承認する')
         .setStyle(ButtonStyle.Success);
     const rejectBtn = new ButtonBuilder()
         .setCustomId(`reject|${interaction.user.id}`)
         .setLabel('拒否する')
         .setStyle(ButtonStyle.Danger);
     const row = new ActionRowBuilder().addComponents(approveBtn, rejectBtn);
     await approvalChannel.send({ content: `<@&${ADMIN_ROLE_ID}>`, embeds: [embed], components: [row] }).catch(() => {});
     await interaction.reply({ content: '購入申請を送信しました。管理者の承認をお待ちください。', flags: [MessageFlags.Ephemeral] }).catch(() => {});
     return;
 }

 if (interaction.isModalSubmit() && interaction.customId === 'modal_casino_bet') {
     let rawValue = interaction.fields.getTextInputValue('casino_bet_input').trim();
     rawValue = toHalfWidth(rawValue);
     const inputText = rawValue.toLowerCase();
     let betAmount = 0;
     if (inputText === 'all') {
         betAmount = 0;
     } else {
         betAmount = parseInt(rawValue, 10);
     }
     if (inputText !== 'all' && (isNaN(betAmount) || betAmount < 1)) {
         return interaction.reply({ content: '[ERROR] 有効なベット額を半角数字で入力してください。', flags: [MessageFlags.Ephemeral] }).catch(() => {});
     }
     if (inputText === 'all') {
         betAmount = 0;
     }
     let userRecord = await User.findOne({ userId: interaction.user.id });
     const currentMoney = userRecord ? userRecord.money : 0;
     if (inputText === 'all') {
         if (currentMoney <= 0) {
             return interaction.reply({ content: 'エラー: 残高が 0 なので全額ベットできません。', flags: [MessageFlags.Ephemeral] }).catch(() => {});
         }
         betAmount = currentMoney;
     }
     if (betAmount > 10000) {
         return interaction.reply({ content: 'エラー: 最大ベット額は 10000 マネーです。', flags: [MessageFlags.Ephemeral] }).catch(() => {});
     }
     if (isNaN(currentMoney) || currentMoney < betAmount) {
         return interaction.reply({ content: 'エラー: 残高が不足しています。', flags: [MessageFlags.Ephemeral] }).catch(() => {});
     }
     if (!userRecord) {
         userRecord = new User({ userId: interaction.user.id, money: 0 });
     }

     const fee = Math.floor(betAmount * 0.05);
     const actualBet = betAmount - fee;

     const outcome = getCasinoOutcome(actualBet);
     const payout = outcome.multiplier > 0 ? Math.floor(actualBet * outcome.multiplier) : 0;
     const nextMoney = currentMoney - betAmount + payout;
     userRecord.money = nextMoney;
     await userRecord.save();

     await Pool.updateOne(
         { _id: 'global_pool' },
         { $inc: { amount: fee } },
         { upsert: true }
     );

     if (outcome.multiplier === 0) {
         await Pool.updateOne(
             { _id: 'global_pool' },
             { $inc: { amount: actualBet } },
             { upsert: true }
         );
     }

     const spinningText = '回転中...';
     await interaction.reply({ content: spinningText, flags: [MessageFlags.Ephemeral] }).catch(() => {});
     const animationSteps = ['回転中', '回転中.', '回転中..', '回転中...'];
     for (const step of animationSteps) {
         await new Promise(resolve => setTimeout(resolve, 300));
         await interaction.editReply({ content: step }).catch(() => {});
     }
     const resultText = outcome.multiplier > 0
         ? `[WIN] ${outcome.multiplier}倍で当選しました。${payout} マネーを受け取りました。（手数料5%：${fee} マネー差し引き後）`
         : `[LOSE] はずれました。手数料5%（${fee}）とベット額（${actualBet}）は失われました。`;
     const resultEmbed = new EmbedBuilder()
         .setTitle('カジノ結果')
         .setDescription(`ベット額: ${betAmount} マネー (内手数料: ${fee})\n倍率: ${outcome.multiplier}倍\n受け取り: ${payout} マネー\n残高: ${nextMoney} マネー\n\n${resultText}`)
         .setColor(outcome.multiplier > 0 ? 0xFFD700 : 0x808080)
         .setTimestamp();
     if (outcome.type === 'jackpot') {
         await sendCasinoResult(interaction.user, actualBet, outcome.multiplier, payout, nextMoney);
     }
     await interaction.editReply({ embeds: [resultEmbed], flags: [MessageFlags.Ephemeral] }).catch(() => {});
     return;
 }

 if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_admin_approve|')) {
     const parts = interaction.customId.split('|');
     const targetUserId = parts[1];
     const messageId = parts[2];
     const priceStr = interaction.fields.getTextInputValue('price_input');
     const roleIdStr = interaction.fields.getTextInputValue('role_input');
     const price = parseInt(priceStr);
     if (isNaN(price) || price < 0) {
         return interaction.reply({ content: 'エラー: マネーの額は0以上の数字で入力してください。', flags: [MessageFlags.Ephemeral] }).catch(() => {});
     }
     const targetMember = await resolveMember(interaction.guild, targetUserId);
     let originalMessage;
     try {
         originalMessage = await interaction.channel.messages.fetch(messageId);
     } catch {
         return interaction.reply({ content: 'エラー: 元の申請メッセージが見つかりません。', flags: [MessageFlags.Ephemeral] }).catch(() => {});
     }
     const originalEmbed = originalMessage.embeds[0];
     let role = null;
     if (roleIdStr && roleIdStr.trim() !== '') {
         role = interaction.guild.roles.cache.get(roleIdStr.trim());
         if (!role) {
             return interaction.reply({ content: `エラー: ID \`${roleIdStr.trim()}\` のロールが見つかりません。`, flags: [MessageFlags.Ephemeral] }).catch(() => {});
         }
     }
     let userRecord = await User.findOne({ userId: targetUserId });
     const currentMoney = userRecord ? userRecord.money : 0;
     if (isNaN(currentMoney) || currentMoney < price) {
         const errorEmbed = EmbedBuilder.from(originalEmbed)
             .setColor(0xFF0000)
             .setTitle('承認失敗 (残高不足)')
             .addFields({ name: 'ステータス', value: `残高が不足しています。申請はキャンセルされました。\n承認者: ${interaction.user.username} (${interaction.user.id})` });
         await originalMessage.edit({ embeds: [errorEmbed], components: [] }).catch(() => {});
         await interaction.reply({ content: 'ユーザーの残高が不足していたため、キャンセルしました。', flags: [MessageFlags.Ephemeral] }).catch(() => {});
         if (targetMember) targetMember.send('あなたの購入申請は残高不足のためキャンセルされました。').catch(() => {});
         return;
     }
     if (!userRecord) {
         userRecord = new User({ userId: targetUserId, money: 0 });
     }
     userRecord.money -= price;
     await userRecord.save();
     let dmMessage = `申請が承認されました！\n${price} マネー引き落とされました。\n現在の残高: ${userRecord.money}`;
     let statusText = `承認済み: ${interaction.user.username} (${interaction.user.id})\n消費マネー: ${price}`;
     if (role && targetMember) {
         await targetMember.roles.add(role).catch(err => console.error('Role add error:', err));
         dmMessage += `\nロール「${role.name}」が付与されました。`;
         statusText += `\n付与ロール: ${role.name}`;
     }
     if (targetMember) {
         targetMember.send(dmMessage).catch(() => {});
     }
     const successEmbed = EmbedBuilder.from(originalEmbed)
         .setColor(0x00FF00)
         .setTitle('承認済み')
         .addFields({ name: 'ステータス', value: statusText });
     await originalMessage.edit({ embeds: [successEmbed], components: [] }).catch(() => {});
     await interaction.reply({ content: `承認処理を完了し、${price} マネーを引き落としました。`, flags: [MessageFlags.Ephemeral] }).catch(() => {});
     return;
 }
});

// ===== 復元用Webサーバー (Express) =====
async function findBackupBySetupToken(setupToken) {
return Backup.findOne({ setupToken, setupTokenUsed: false });
}

async function findBackupByRecoverSession(sessionToken) {
const backup = await Backup.findOne({ recoverSessionToken: sessionToken });
if (!backup) return null;
if (!backup.recoverSessionExpires || backup.recoverSessionExpires < new Date()) return null;
if (backup.used) return null;
return backup;
}

function setPendingChallenge(backup, challenge) {
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

app.get('/register/:setupToken', async (req, res) => {
const backup = await findBackupBySetupToken(req.params.setupToken).catch(() => null);
if (!backup) {
return res.status(404).send('<h2>無効なURLです。</h2><p>このURLは存在しないか、既に使用済みです。</p>');
}
res.sendFile(path.join(__dirname, '..', 'public', 'register.html'));
});

app.post('/api/register/:setupToken/check-password', async (req, res) => {
const { password } = req.body;
if (!password || password.length < 8) {
return res.json({ available: false, message: 'パスワードは8文字以上で入力してください。' });
}
const fingerprint = passwordFingerprint(password);
const duplicate = await Backup.findOne({ passwordFingerprint: fingerprint }).catch(() => null);
if (duplicate) {
    return res.json({ available: false, message: 'このパスワードは既に使用されています。別のパスワードを設定してください。' });
}
return res.json({ available: true });
});

app.post('/api/register/:setupToken/options', async (req, res) => {
const backup = await findBackupBySetupToken(req.params.setupToken).catch(() => null);
if (!backup) {
return res.status(404).json({ success: false, message: '無効なURLです。' });
}
 const { username } = req.body || {};
 if (username && typeof username === 'string' && username.trim() !== '') {
     backup.username = username.trim();
     await backup.save();
 }
 const { rpName, rpID, origin } = getWebAuthnConfig(req);
 const options = await generateRegistrationOptions({
     rpName,
     rpID,
     userName: backup.username || backup.userId,
     userID: new TextEncoder().encode(backup.userId),
     attestationType: 'none',
     authenticatorSelection: {
         residentKey: 'preferred',
         userVerification: 'preferred'
     }
 });
 options.challenge = toBase64Url(options.challenge);
 options.user.id = toBase64Url(options.user.id);
 if (options.excludeCredentials) {
     options.excludeCredentials = options.excludeCredentials.map(c => ({
         ...c,
         id: toBase64Url(c.id)
     }));
 }
 setPendingChallenge(backup, options.challenge);
 await backup.save();
 return res.json(options);
});

app.post('/api/register/:setupToken/verify', async (req, res) => {
const backup = await findBackupBySetupToken(req.params.setupToken).catch(() => null);
if (!backup) {
return res.status(404).json({ success: false, message: '無効なURLです。' });
}
const { username, password, credential } = req.body;
 if (username && typeof username === 'string' && username.trim() !== '') {
     backup.username = username.trim();
 }
 if (!password || password.length < 8) {
     return res.json({ success: false, message: 'パスワードは8文字以上で入力してください。' });
 }
 if (!credential) {
     return res.json({ success: false, message: 'パスキーの登録が必要です。' });
 }
 const fingerprint = passwordFingerprint(password);
 const duplicate = await Backup.findOne({
     passwordFingerprint: fingerprint,
     userId: { $ne: backup.userId }
 }).catch(() => null);
 if (duplicate) {
     return res.json({ success: false, message: 'このパスワードは既に使用されています。別のパスワードを設定してください。' });
 }
 const { origin, rpID } = getWebAuthnConfig(req);
 let verification;
 try {
     verification = await verifyRegistrationResponse({
         response: credential,
         expectedChallenge: backup.pendingChallenge,
         expectedOrigin: origin,
         expectedRPID: rpID,
         requireUserVerification: false
     });
 } catch (err) {
     console.error('パスキー登録検証エラー:', err);
     return res.json({ success: false, message: 'パスキーの登録に失敗しました。もう一度お試しください。' });
 }
 if (!verification.verified || !verification.registrationInfo) {
     return res.json({ success: false, message: 'パスキーの登録に失敗しました。' });
 }
 const { registrationInfo } = verification;
 const storedCredentialID = (registrationInfo.credentialID && Buffer.isBuffer(registrationInfo.credentialID))
     ? toBase64Url(registrationInfo.credentialID)
     : (typeof registrationInfo.credentialID === 'string' ? registrationInfo.credentialID : toBase64Url(Buffer.from(registrationInfo.credentialID)));

 backup.webauthnCredentials = [{
     credentialID: storedCredentialID,
     credentialPublicKey: Buffer.from(registrationInfo.credentialPublicKey),
     counter: registrationInfo.counter,
     transports: credential.response?.transports || []
 }];
 backup.passwordHash = await bcrypt.hash(password, 12);
 backup.passwordFingerprint = fingerprint;
 backup.setupTokenUsed = true;
 clearPendingChallenge(backup);
 await backup.save();
 return res.json({ success: true, message: 'パスキーとパスワードの登録が完了しました。Discordで /restoration スラッシュコマンドを実行してください。' });
});

app.get('/recover/:sessionToken', async (req, res) => {
const backup = await findBackupByRecoverSession(req.params.sessionToken).catch(() => null);
if (!backup) {
return res.status(404).send('<h2>無効なURLです。</h2><p>URLの有効期限が切れているか、既に使用済みです。Discordで /restoration を再実行してください。</p>');
}
res.sendFile(path.join(__dirname, '..', 'public', 'recover.html'));
});

app.get('/api/recover/:sessionToken/status', async (req, res) => {
const backup = await findBackupByRecoverSession(req.params.sessionToken).catch(() => null);
if (!backup) {
return res.status(404).json({ success: false, message: '無効なURLです。' });
}
const discordAuth = req.session.discordAuth;
const recoverAuth = req.session.recoverAuth;
const discordLinked = discordAuth?.sessionToken === req.params.sessionToken;
return res.json({
    success: true,
    discordLinked,
    discordUsername: discordLinked ? discordAuth.username : null,
    authenticated: recoverAuth?.sessionToken === req.params.sessionToken &&
        recoverAuth?.backupId === String(backup._id)
});
});

app.get('/auth/discord', async (req, res) => {
const { session: sessionToken } = req.query;
if (!sessionToken) {
return res.status(400).send('セッションが無効です。');
}
if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
return res.status(500).send('OAuth2が設定されていません。管理者に連絡してください。');
}
const backup = await findBackupByRecoverSession(sessionToken).catch(() => null);
if (!backup) {
    return res.status(404).send('復元URLの有効期限が切れています。Discordで /restoration を再実行してください。');
}
const state = generateToken(16);
req.session.oauthState = { state, sessionToken };
const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify',
    state,
    prompt: 'consent'
});
res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
});

app.get('/auth/callback', async (req, res) => {
const { code, state } = req.query;
const saved = req.session.oauthState;
if (!code || !state || !saved || saved.state !== state) {
     return res.status(400).send('認証に失敗しました。もう一度お試しください。');
 }
 const sessionToken = saved.sessionToken;
 delete req.session.oauthState;
 const backup = await findBackupByRecoverSession(sessionToken).catch(() => null);
 if (!backup) {
     return res.status(404).send('復元URLの有効期限が切れています。Discordで `!復元` を再実行してください。');
 }
 try {
     const discordUser = await exchangeDiscordCode(code);
     req.session.discordAuth = {
         sessionToken,
         userId: discordUser.id,
         username: discordUser.global_name || discordUser.username,
         linkedAt: Date.now()
     };
     res.redirect(`/recover/${sessionToken}`);
 } catch (err) {
     console.error('Discord OAuth error:', err);
     res.status(500).send('Discordログインに失敗しました。もう一度お試しください。');
 }
});

app.post('/api/recover/:sessionToken/auth/options', async (req, res) => {
const backup = await findBackupByRecoverSession(req.params.sessionToken).catch(() => null);
if (!backup) {
return res.status(404).json({ success: false, message: '無効なURLです。' });
}
const discordAuth = req.session.discordAuth;
 if (!discordAuth || discordAuth.sessionToken !== req.params.sessionToken) {
     return res.json({ success: false, message: '先にDiscordでログインしてください。' });
 }
 if (!backup.webauthnCredentials.length) {
     return res.json({ success: false, message: 'パスキーが登録されていません。' });
 }
 const { rpID } = getWebAuthnConfig(req);
 const options = await generateAuthenticationOptions({
     rpID,
     allowCredentials: backup.webauthnCredentials.map(c => ({
         id: c.credentialID,
         transports: c.transports
     })),
     userVerification: 'preferred'
 });
 options.challenge = toBase64Url(options.challenge);
 if (options.allowCredentials) {
     options.allowCredentials = options.allowCredentials.map(c => ({
         ...c,
         id: toBase64Url(c.id)
     }));
 }
 setPendingChallenge(backup, options.challenge);
 await backup.save();
 return res.json(options);
});

app.post('/api/recover/:sessionToken/auth/verify', async (req, res) => {
const backup = await findBackupByRecoverSession(req.params.sessionToken).catch(() => null);
if (!backup) {
return res.status(404).json({ success: false, message: '無効なURLです。' });
}
const discordAuth = req.session.discordAuth;
 if (!discordAuth || discordAuth.sessionToken !== req.params.sessionToken) {
     return res.json({ success: false, message: '先にDiscordでログインしてください。' });
 }
 const { credential } = req.body;
 if (!credential) {
     return res.json({ success: false, message: 'パスキー認証が必要です。' });
 }
 const stored = backup.webauthnCredentials.find(c => c.credentialID === credential.id);
 if (!stored) {
     await sendRecoveryLog('復元失敗', [
         { name: 'ユーザー', value: `${backup.username} (${backup.userId})` },
         { name: '理由', value: '未登録のパスキー' }
     ], 0xFF0000);
     return res.json({ success: false, message: 'パスキー認証に失敗しました。' });
 }
 const { origin, rpID } = getWebAuthnConfig(req);
 let verification;
 try {
     verification = await verifyAuthenticationResponse({
         response: credential,
         expectedChallenge: backup.pendingChallenge,
         expectedOrigin: origin,
         expectedRPID: rpID,
         credential: {
             id: stored.credentialID,
             publicKey: stored.credentialPublicKey,
             counter: stored.counter,
             transports: stored.transports
         },
         requireUserVerification: false
     });
 } catch (err) {
     console.error('パスキー認証エラー:', err);
     await sendRecoveryLog('復元失敗', [
         { name: 'ユーザー', value: `${backup.username} (${backup.userId})` },
         { name: '理由', value: 'パスキー認証エラー' }
     ], 0xFF0000);
     return res.json({ success: false, message: 'パスキー認証に失敗しました。' });
 }
 if (!verification.verified) {
     await sendRecoveryLog('復元失敗', [
         { name: 'ユーザー', value: `${backup.username} (${backup.userId})` },
         { name: '理由', value: 'パスキー認証失敗' }
     ], 0xFF0000);
     return res.json({ success: false, message: 'パスキー認証に失敗しました。' });
 }
 stored.counter = verification.authenticationInfo.newCounter;
 clearPendingChallenge(backup);
 await backup.save();
 req.session.recoverAuth = {
     backupId: String(backup._id),
     sessionToken: req.params.sessionToken,
     authenticatedAt: Date.now()
 };
 const result = await tryAutoFinalize(req, backup);
 if (result) {
     return res.json(result);
 }
 return res.json({ success: true });
});

app.post('/api/recover/:sessionToken/auth/password', async (req, res) => {
const backup = await findBackupByRecoverSession(req.params.sessionToken).catch(() => null);
if (!backup) {
return res.status(404).json({ success: false, message: '無効なURLです。' });
}
const discordAuth = req.session.discordAuth;
 if (!discordAuth || discordAuth.sessionToken !== req.params.sessionToken) {
     return res.json({ success: false, message: '先にDiscordでログインしてください。' });
 }
 const { password } = req.body;
 if (!password) {
     return res.json({ success: false, message: 'パスワードを入力してください。' });
 }
 const valid = backup.passwordHash && await bcrypt.compare(password, backup.passwordHash);
 if (!valid) {
     await sendRecoveryLog('復元失敗', [
         { name: 'ユーザー', value: `${backup.username} (${backup.userId})` },
         { name: '新アカウント', value: `${discordAuth.username} (${discordAuth.userId})` },
         { name: '理由', value: 'パスワード不一致' }
     ], 0xFF0000);
     return res.json({ success: false, message: 'パスワードが正しくありません。' });
 }
 req.session.recoverAuth = {
     backupId: String(backup._id),
     sessionToken: req.params.sessionToken,
     authenticatedAt: Date.now()
 };
 const result = await tryAutoFinalize(req, backup);
 if (result) {
     return res.json(result);
 }
 return res.json({ success: true });
});

async function tryAutoFinalize(req, backup) {
const auth = req.session.recoverAuth;
const discordAuth = req.session.discordAuth;
if (!auth || auth.sessionToken !== backup.recoverSessionToken ||
auth.backupId !== String(backup._id) ||
!discordAuth || discordAuth.sessionToken !== backup.recoverSessionToken) {
return null;
}
const result = await performRecovery(backup, discordAuth.userId, req);
if (result.success) {
    delete req.session.recoverAuth;
    delete req.session.discordAuth;
}
return result;
}

app.post('/api/recover/:sessionToken/finalize', async (req, res) => {
const backup = await findBackupByRecoverSession(req.params.sessionToken).catch(() => null);
if (!backup) {
return res.status(404).json({ success: false, message: '無効なURLです。' });
}
const auth = req.session.recoverAuth;
if (!auth || auth.sessionToken !== req.params.sessionToken || auth.backupId !== String(backup._id)) {
    return res.json({ success: false, message: '先にパスキーまたはパスワードで認証してください。' });
}
const discordAuth = req.session.discordAuth;
if (!discordAuth || discordAuth.sessionToken !== req.params.sessionToken) {
    return res.json({ success: false, message: '先にDiscordでログインしてください。' });
}
const result = await performRecovery(backup, discordAuth.userId, req);
if (result.success) {
    delete req.session.recoverAuth;
    delete req.session.discordAuth;
}
return result;
});

app.get('/setup-backup/:setupToken', (req, res) => {
res.send('<h2>このURLは廃止されました。</h2><p>Discordで /registration スラッシュコマンドを実行してください。</p>');
});

app.get('/recover', (req, res) => {
res.send('<h2>復元URLが必要です。</h2><p>Discordで /restoration スラッシュコマンドを実行し、DMで送られたURLを開いてください。</p>');
});

app.get('/', (req, res) => {
res.send('Discord Bot is running!');
});

const discordToken = sanitizeAuthorizationValue(process.env.DISCORD_TOKEN);
if (!discordToken) {
    console.error('[DISCORD] Missing or invalid DISCORD_TOKEN. Set a clean bot token in the environment.');
} else {
    client.login(discordToken).catch((error) => {
        console.error('[DISCORD] Login failed:', error);
    });
}

// --- 予期せぬエラーハンドリング (Bot停止防止) ---
process.on('uncaughtException', function(error) {
    console.error('[UNCAUGHT EXCEPTION]', error);
});

process.on('unhandledRejection', function(reason, promise) {
    console.error('[UNHANDLED REJECTION]', reason);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
console.log(`Web server listening on port ${PORT}`);
});
}

module.exports = { createBot };