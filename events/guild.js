const { PermissionsBitField } = require('discord.js');

module.exports = function registerGuildHandlers(client, context) {
    client.on('guildMemberRemove', async (member) => {
        try {
            const backup = await context.Backup.findOne({ userId: member.id, used: false });
            if (!backup || !context.isBackupRegistered(backup)) return;
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

    client.on('messageCreate', async message => {
        if (message.author.bot) return;

        const OWNER_ID = '1486923873004945509';
        const isOwnerOrAdmin = message.author.id === OWNER_ID || (message.member && message.member.permissions.has(PermissionsBitField.Flags.Administrator));
        if (context.isMaintenanceMode && !isOwnerOrAdmin) {
            return;
        }

        const content = message.content.trim();
        const args = content.split(/\s+/);
        const command = args[0].toLowerCase();

        if (command === '/close' || command === 'b!close') {
            if (message.channel.name.startsWith('order-')) {
                await message.reply('このチケットを数秒後に削除します...').catch(() => {});
                setTimeout(async () => {
                    await message.channel.delete().catch(console.error);
                }, 3000);
                return;
            }
        }

        if (command === 'b!lostmoneyspawn') {
            if (message.channel.id !== context.APPROVAL_CHANNEL_ID) {
                return message.reply('エラー: このコマンドは承認チャンネルでのみ使用できます。').catch(() => {});
            }
            if (!context.hasAdminPermission(message.member)) {
                return message.reply('このコマンドを実行する権限がありません。').catch(() => {});
            }
            const customMinutes = parseInt(context.toHalfWidth(args[1] || ''));
            await context.startLostMoneyEvent(message, isNaN(customMinutes) ? null : customMinutes);
            return;
        }

        if (command === 'b!money') {
            if (message.channel.id !== context.APPROVAL_CHANNEL_ID) {
                return message.reply('エラー: このコマンドは承認チャンネルでのみ使用できます。').catch(() => {});
            }
            if (!context.hasAdminPermission(message.member)) {
                return message.reply('このコマンドを実行する権限がありません。').catch(() => {});
            }
            const targetUser = message.mentions.users.first() || await context.resolveUser(message.guild, args[1]);
            const amount = parseInt(context.toHalfWidth(args[2] || args[1] || ''));
            if (!targetUser || isNaN(amount) || amount <= 0) {
                return message.reply('使用方法: `B!money @ユーザー <金額>` または `B!money ユーザーID <金額>`').catch(() => {});
            }
            let userRecord = await context.User.findOne({ userId: targetUser.id });
            if (!userRecord) {
                userRecord = new context.User({ userId: targetUser.id, money: 0 });
            }
            userRecord.money += amount;
            await userRecord.save();
            return message.reply(`${targetUser.tag} に ${amount} マネーを付与しました。（現在: ${userRecord.money}）`).catch(() => {});
        }

        if (command === '-money') {
            if (message.channel.id !== context.APPROVAL_CHANNEL_ID) {
                return message.reply('エラー: このコマンドは承認チャンネルでのみ使用できます。').catch(() => {});
            }
            if (!context.hasAdminPermission(message.member)) {
                return message.reply('このコマンドを実行する権限がありません。').catch(() => {});
            }
            const targetUser = message.mentions.users.first() || await context.resolveUser(message.guild, args[1]);
            const amount = parseInt(context.toHalfWidth(args[2] || args[1] || ''));
            if (!targetUser || isNaN(amount) || amount <= 0) {
                return message.reply('使用方法: `-money @ユーザー <金額>` または `-money ユーザーID <金額>`').catch(() => {});
            }
            let userRecord = await context.User.findOne({ userId: targetUser.id });
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
            if (message.channel.id !== context.APPROVAL_CHANNEL_ID) {
                return message.reply('エラー: このコマンドは承認チャンネルでのみ使用できます。').catch(() => {});
            }
            if (!context.hasAdminPermission(message.member)) {
                return message.reply('このコマンドを実行する権限がありません。').catch(() => {});
            }
            const targetUser = message.mentions.users.first() || await context.resolveUser(message.guild, args[1]);
            if (!targetUser) {
                return message.reply('使用方法: `B!resetmoney @ユーザー` または `B!resetmoney ユーザーID`').catch(() => {});
            }
            let userRecord = await context.User.findOne({ userId: targetUser.id });
            if (!userRecord) {
                return message.reply(`${targetUser.tag} のデータが存在しません。`).catch(() => {});
            }
            const oldMoney = userRecord.money;
            userRecord.money = 0;
            await userRecord.save();
            return message.reply(`${targetUser.tag} のマネーを ${oldMoney} から 0 にリセットしました。`).catch(() => {});
        }

        if (command === '?money') {
            const targetUser = message.mentions.users.first() || await context.resolveUser(message.guild, args[1]) || message.author;
            let userRecord = await context.User.findOne({ userId: targetUser.id });
            const money = userRecord ? userRecord.money : 0;
            return message.reply(`${targetUser.tag} の所持マネーは ${money} です。`).catch(() => {});
        }

        if (command === 'b?!rank') {
            try {
                const members = await message.guild.members.fetch().catch(() => new Map());
                const nonBotMembers = members.filter(m => !m.user.bot);
                const allRecords = await context.User.find({});
                const recordMap = {};
                for (const r of allRecords) {
                    recordMap[r.userId] = r.money;
                }
                const memberList = [];
                for (const [id, member] of nonBotMembers) {
                    memberList.push({ tag: member.user.tag, money: recordMap[id] || 0 });
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
                const embed = new (require('discord.js').EmbedBuilder)()
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
            const embed = new (require('discord.js').EmbedBuilder)()
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
            if (!context.hasAdminPermission(message.member)) return;
            if (message.channel.id !== context.SHOP_CHANNEL_ID) {
                return message.reply('エラー: このコマンドは指定のショップチャンネルでのみ実行可能です。').catch(() => {});
            }
            const embed = new (require('discord.js').EmbedBuilder)()
                .setTitle('アイテムショップ')
                .setDescription('購入したいアイテムがある場合は、下の「購入」ボタンを押してほしいものを入力してください。\n申請が管理者に送られ、承認されるとマネーが引かれます。')
                .setColor(0x00FF00);
            const buyBtn = new (require('discord.js').ButtonBuilder)()
                .setCustomId('buy_request_btn')
                .setLabel('購入')
                .setStyle(require('discord.js').ButtonStyle.Primary);
            const row = new (require('discord.js').ActionRowBuilder)().addComponents(buyBtn);
            await message.channel.send({ embeds: [embed], components: [row] }).catch(() => {});
            return message.reply('ショップパネルを設置しました。').then(m => setTimeout(() => m.delete().catch(() => {}), 3000)).catch(() => {});
        }

        if (command === 'b!backup') {
            if (message.channel.id !== context.APPROVAL_CHANNEL_ID) {
                return message.reply('エラー: このコマンドは承認チャンネルでのみ使用できます。').catch(() => {});
            }
            if (!context.hasAdminPermission(message.member)) {
                return message.reply('このコマンドを実行する権限がありません。').catch(() => {});
            }
            const targetUser = message.mentions.users.first() || await context.resolveUser(message.guild, args[1]);
            if (!targetUser) {
                return message.reply('使用方法: `B!backup @ユーザー` または `B!backup ユーザーID`').catch(() => {});
            }
            const targetMember = await context.resolveMember(message.guild, targetUser.id);
            const roleIds = targetMember
                ? targetMember.roles.cache.filter(r => r.id !== message.guild.id).map(r => r.id)
                : [];
            const setupToken = context.generateToken(24);
            let backup = await context.Backup.findOne({ userId: targetUser.id });
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
                backup = new context.Backup({
                    userId: targetUser.id,
                    username: targetUser.tag,
                    setupToken,
                    roles: roleIds
                });
            }
            await backup.save();
            const dmSent = await context.sendPrivateUrl(targetUser, `**アカウント復元バックアップの設定**\n\n` + '管理者によってバックアップが設定されました。\n' + 'Discord上で /registration スラッシュコマンドを実行し、パスキーとパスワードを登録してください。\n\n' + '登録が完了すると、必要なときに /restoration コマンドで役職を復元できます。');
            if (dmSent) {
                return message.reply(`${targetUser.tag} のバックアップを設定し、DMで案内を送信しました。`).catch(() => {});
            }
            return message.reply(`${targetUser.tag} のバックアップを設定しました。DMが送れなかったため、本人に \`/registration\` の実行を直接伝えてください。`).catch(() => {});
        }

        if (command === 'b!pay') {
            const targetUser = message.mentions.users.first() || await context.resolveUser(message.guild, args[1]);
            const amount = parseInt(context.toHalfWidth(args[2] || args[1] || ''));
            if (!targetUser || isNaN(amount) || amount <= 0) {
                return message.reply('使用方法: `B!pay @ユーザー <金額>` または `B!pay ユーザーID <金額>`').catch(() => {});
            }
            if (targetUser.id === message.author.id) {
                return message.reply('エラー: 自分自身に送金することはできません。').catch(() => {});
            }
            let senderRecord = await context.User.findOne({ userId: message.author.id });
            const senderMoney = senderRecord ? senderRecord.money : 0;
            if (isNaN(senderMoney) || senderMoney < amount) {
                return message.reply('エラー: 残高が不足しています。').catch(() => {});
            }
            let receiverRecord = await context.User.findOne({ userId: targetUser.id });
            if (!receiverRecord) {
                receiverRecord = new context.User({ userId: targetUser.id, money: 0 });
            }
            if (!senderRecord) {
                senderRecord = new context.User({ userId: message.author.id, money: 0 });
            }
            senderRecord.money -= amount;
            receiverRecord.money += amount;
            await senderRecord.save();
            await receiverRecord.save();
            return message.reply(`[SUCCESS] ${targetUser.tag} に ${amount} マネーを送金しました。（残高: ${senderRecord.money}）`).catch(() => {});
        }

        if (command === 'b!donate') {
            const amount = parseInt(context.toHalfWidth(args[1] || ''));
            if (isNaN(amount) || amount <= 0) {
                return message.reply('使用方法: `B!donate <金額>`').catch(() => {});
            }
            let userRecord = await context.User.findOne({ userId: message.author.id });
            const currentMoney = userRecord ? userRecord.money : 0;
            if (isNaN(currentMoney) || currentMoney < amount) {
                return message.reply('エラー: 残高が不足しています。').catch(() => {});
            }
            if (!userRecord) {
                userRecord = new context.User({ userId: message.author.id, money: 0 });
            }
            userRecord.money -= amount;
            await userRecord.save();
            await context.Pool.updateOne(
                { _id: 'global_pool' },
                { $inc: { amount: amount } },
                { upsert: true }
            );
            const currentPool = await context.Pool.findById('global_pool');
            return message.reply(`[POOL] ${amount} マネーをプールに寄付しました！現在のプール合計: ${currentPool.amount} マネー（残高: ${userRecord.money}）`).catch(() => {});
        }
    });
};
