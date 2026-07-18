const {
    MessageFlags,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    StringSelectMenuBuilder,
    PermissionsBitField,
    ChannelType
} = require('discord.js');
const { createGroqCompletion, GROQ_MODEL_ID, GROQ_SYSTEM_PROMPT } = require('../utils/groqClient');

module.exports = function registerInteractionHandlers(client, context) {
    async function createOrderTicket(interaction, fee, typeLabel) {
        const userId = interaction.user.id;
        const categoryId = '1504059407799947355';

        if (context.creatingTickets.has(userId)) {
            console.log('[DEBUG] ' + userId + ' status=ticket_creation_locked');
            await interaction.reply({ content: 'チケットを作成中です。しばらくお待ちください。', flags: [MessageFlags.Ephemeral] }).catch(() => {});
            return;
        }

        const existingChannel = interaction.guild.channels.cache.find(function(ch) {
            return ch.name === ('order-' + interaction.user.username) && ch.parentId === categoryId;
        });
        if (existingChannel) {
            console.log('[DEBUG] ' + userId + ' status=ticket_already_exists channel=' + existingChannel.id);
            await interaction.reply({
                content: 'すでにオープン中のチケットがあります: <#' + existingChannel.id + '>\n現在のチケットを閉じてから再度お試しください。',
                flags: [MessageFlags.Ephemeral]
            }).catch(() => {});
            return;
        }

        context.creatingTickets.add(userId);
        console.log('[DEBUG] ' + userId + ' status=ticket_creation_started');
        try {
            const channelName = 'order-' + interaction.user.username;
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
                .setTitle('新しい注文')
                .setDescription('**注文者**: <@' + userId + '>\n**内容**: ' + typeLabel + '\n**依頼料**: ' + fee + ' マネー')
                .setColor(0x00FFFF);
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('btn_close_ticket')
                    .setLabel('閉じる (Close)')
                    .setStyle(ButtonStyle.Danger)
            );
            const mentionText = '<@&1515621825948811414> <@&1438487519082713088> <@&1525302667835080795>';
            await ticketChannel.send({ content: mentionText, embeds: [embed], components: [row] });
            await interaction.reply({ content: 'チケットを作成しました: <#' + ticketChannel.id + '>', flags: [MessageFlags.Ephemeral] }).catch(() => {});
            console.log('[DEBUG] ' + userId + ' status=ticket_created channel=' + ticketChannel.id);
        } finally {
            context.creatingTickets.delete(userId);
            console.log('[DEBUG] ' + userId + ' status=ticket_lock_released');
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
            context.isMaintenanceMode = enable;
            return interaction.reply({ content: `メンテナンスモードを **${enable ? '有効' : '無効'}** に設定しました。`, flags: [MessageFlags.Ephemeral] }).catch(() => {});
        }

        if (context.isMaintenanceMode && !isOwnerOrAdmin) {
            return interaction.reply({ content: '現在メンテナンス中です。しばらくお待ちください。', flags: [MessageFlags.Ephemeral] }).catch(() => {});
        }

        if (interaction.isChatInputCommand()) {
            if (interaction.commandName === 'bai') {
                const baiUserId = interaction.user.id;
                const now = Date.now();
                const RATE_WINDOW = 60 * 1000;
                const RATE_LIMIT = 5;
                const timestamps = (context.baiRateLimit.get(baiUserId) || []).filter(function(t) { return now - t < RATE_WINDOW; });
                console.log('[DEBUG] user=' + baiUserId + ' status=bai_rate_check count=' + timestamps.length);
                if (timestamps.length >= RATE_LIMIT) {
                    const waitSec = Math.ceil((RATE_WINDOW - (now - timestamps[0])) / 1000);
                    console.log('[DEBUG] user=' + baiUserId + ' status=bai_rate_limited wait=' + waitSec + 's');
                    return interaction.reply({ content: '使用回数が上限（1分間に5回）に達しました。' + waitSec + '秒後にお試しください。', flags: [MessageFlags.Ephemeral] }).catch(() => {});
                }
                timestamps.push(now);
                context.baiRateLimit.set(baiUserId, timestamps);
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
                    }, { timeout: 15000 });

                    let replyContent = completion.choices[0]?.message?.content || '申し訳ありません、回答を生成できませんでした。';
                    replyContent = replyContent.replace(/<think>[\s\S]*?<\/think>\n*/g, '').trim();
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

            if (interaction.commandName === 'order') {
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
                            if (message.author.id === client.user.id && message.embeds.some(e => e.title === 'カジノ')) {
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
                    let backup = await context.Backup.findOne({ userId: interaction.user.id });
                    if (!backup) {
                        const member = interaction.member;
                        const roleIds = member && member.roles
                            ? member.roles.cache.filter(r => r.id !== interaction.guild.id).map(r => r.id)
                            : [];
                        backup = new context.Backup({
                            userId: interaction.user.id,
                            username: interaction.user.tag,
                            setupToken: context.generateToken(24),
                            roles: roleIds
                        });
                        await backup.save();
                    }
                    if (context.isBackupRegistered(backup)) {
                        return interaction.editReply({ content: '既に登録済みです。再登録が必要な場合は管理者に `B!backup` の再設定を依頼してください。' }).catch(() => {});
                    }
                    if (backup.setupTokenUsed) {
                        backup.setupToken = context.generateToken(24);
                        backup.setupTokenUsed = false;
                        await backup.save();
                    }
                    const registerUrl = `${context.BASE_URL}/register/${backup.setupToken}`;
                    const dmSent = await context.sendPrivateUrl(interaction.user, `**パスキー・パスワード登録**\n\n` + '下のURLから、復元用のパスキーとパスワードを登録してください。\n' + 'このURLはあなた以外には表示されません。\n\n' + `${registerUrl}\n\n` + '※ 24時間以内に使用してください。');
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
                    const backup = await context.Backup.findOne({ userId: interaction.user.id });
                    if (!backup) {
                        return interaction.editReply({ content: 'バックアップが設定されていません。' }).catch(() => {});
                    }
                    if (!context.isBackupRegistered(backup)) {
                        return interaction.editReply({ content: '先に `/Registration` コマンドでパスキーとパスワードを登録してください。' }).catch(() => {});
                    }
                    if (backup.used) {
                        return interaction.editReply({ content: 'このバックアップは既に使用済みです。' }).catch(() => {});
                    }
                    if (backup.roles.length === 0) {
                        return interaction.editReply({ content: '復元する役職データがありません。サーバー在籍中にバックアップが更新されるまでお待ちください。' }).catch(() => {});
                    }
                    const recoverSessionToken = context.generateToken(24);
                    backup.recoverSessionToken = recoverSessionToken;
                    backup.recoverSessionExpires = new Date(Date.now() + context.RECOVER_SESSION_TTL_MS);
                    await backup.save();
                    const recoverUrl = `${context.BASE_URL}/recover/${recoverSessionToken}`;
                    const dmSent = await context.sendPrivateUrl(interaction.user, `**アカウント復元**\n\n` + '下のURLから、新しいDiscordアカウントでログインし、登録したパスワード（またはパスキー）で役職を復元できます。\n' + 'このURLはあなた以外には表示されません。\n\n' + `${recoverUrl}\n\n` + '※ 15分以内に使用してください。');
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

        if (interaction.isButton() && interaction.customId === 'btn_toggle_autojoin') {
            const userRecord = await context.User.findOne({ userId: interaction.user.id });
            if (!userRecord) {
                await context.User.create({ userId: interaction.user.id, autoJoinEvent: true });
                await interaction.reply({ content: '[AUTO_ON] イベント自動参加を有効にしました。', flags: [MessageFlags.Ephemeral] }).catch(() => {});
            } else {
                const newState = !userRecord.autoJoinEvent;
                await context.User.updateOne({ userId: interaction.user.id }, { autoJoinEvent: newState });
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
            const lastUsed = context.FREE_BET_COOLDOWNS.get(interaction.user.id);
            if (lastUsed && now - lastUsed < 60 * 60 * 1000) {
                return interaction.reply({ content: '無料ベットは1時間に1回です。', flags: [MessageFlags.Ephemeral] }).catch(() => {});
            }
            context.FREE_BET_COOLDOWNS.set(interaction.user.id, now);
            await context.runCasinoRollingMessage(interaction);
            return context.processCasinoBet(interaction, { betAmount: 100, isFree: true });
        }

        if (interaction.isButton() && interaction.customId === 'btn_manual_join_event') {
            if (!context.currentEventManualParticipants.includes(interaction.user.id)) {
                context.currentEventManualParticipants.push(interaction.user.id);
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
            if (!context.hasAdminPermission(interaction.member)) {
                return interaction.reply({ content: 'この操作を行う権限がありません。', flags: [MessageFlags.Ephemeral] }).catch(() => {});
            }
            const originalEmbed = interaction.message.embeds[0];
            const targetMember = await context.resolveMember(interaction.guild, targetUserId);
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
            const fee = parseInt(context.toHalfWidth(feeStr));

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

            if (fee > 0) {
                const userRecord = await context.User.findOne({ userId: interaction.user.id });
                const currentMoney = userRecord ? userRecord.money : 5000;
                if (currentMoney < fee) {
                    return interaction.reply({
                        content: `残高が足りません。依頼料: **${fee} マネー** / 現在の残高: **${currentMoney} マネー**`,
                        flags: [MessageFlags.Ephemeral]
                    }).catch(() => {});
                }
            }

            if (fee >= 1 && fee <= 500) {
                const a = Math.floor(Math.random() * 9) + 1;
                const b = Math.floor(Math.random() * 9) + 1;
                const answer = a + b;

                context.pendingOrders.set(interaction.user.id, { fee, selectedType, typeLabel, captchaAnswer: answer });
                setTimeout(() => context.pendingOrders.delete(interaction.user.id), 5 * 60 * 1000);

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

            try {
                await createOrderTicket(interaction, fee, typeLabel);
            } catch (err) {
                console.error('チケットチャンネル作成エラー:', err);
                return interaction.reply({ content: 'チケットの作成に失敗しました。', flags: [MessageFlags.Ephemeral] }).catch(() => {});
            }
        }

        if (interaction.isModalSubmit() && interaction.customId === 'modal_captcha_order') {
            const pending = context.pendingOrders.get(interaction.user.id);
            if (!pending) {
                return interaction.reply({ content: 'セッションが切れました。もう一度最初からやり直してください。', flags: [MessageFlags.Ephemeral] }).catch(() => {});
            }
            const inputStr = interaction.fields.getTextInputValue('captcha_input').trim();
            const inputNum = parseInt(inputStr);
            if (isNaN(inputNum) || inputNum !== pending.captchaAnswer) {
                context.pendingOrders.delete(interaction.user.id);
                return interaction.reply({ content: 'CAPTCHAの回答が間違っています。もう一度最初からやり直してください。', flags: [MessageFlags.Ephemeral] }).catch(() => {});
            }
            context.pendingOrders.delete(interaction.user.id);
            try {
                await createOrderTicket(interaction, pending.fee, pending.typeLabel);
            } catch (err) {
                console.error('チケットチャンネル作成エラー (CAPTCHA後):', err);
                return interaction.reply({ content: 'チケットの作成に失敗しました。', flags: [MessageFlags.Ephemeral] }).catch(() => {});
            }
        }

        if (interaction.isModalSubmit() && interaction.customId === 'modal_buy_request') {
            const inputValue = interaction.fields.getTextInputValue('request_detail_input');
            const approvalChannel = client.channels.cache.get(context.APPROVAL_CHANNEL_ID);
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
            await approvalChannel.send({ content: `<@&${context.ADMIN_ROLE_ID}>`, embeds: [embed], components: [row] }).catch(() => {});
            await interaction.reply({ content: '購入申請を送信しました。管理者の承認をお待ちください。', flags: [MessageFlags.Ephemeral] }).catch(() => {});
            return;
        }

        if (interaction.isModalSubmit() && interaction.customId === 'modal_casino_bet') {
            let rawValue = interaction.fields.getTextInputValue('casino_bet_input').trim();
            rawValue = context.toHalfWidth(rawValue);
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
            let userRecord = await context.User.findOne({ userId: interaction.user.id });
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
                userRecord = new context.User({ userId: interaction.user.id, money: 0 });
            }

            const fee = Math.floor(betAmount * 0.05);
            const actualBet = betAmount - fee;

            const outcome = context.getCasinoOutcome(actualBet);
            const payout = outcome.multiplier > 0 ? Math.floor(actualBet * outcome.multiplier) : 0;
            const nextMoney = currentMoney - betAmount + payout;
            userRecord.money = nextMoney;
            await userRecord.save();

            await context.Pool.updateOne(
                { _id: 'global_pool' },
                { $inc: { amount: fee } },
                { upsert: true }
            );

            if (outcome.multiplier === 0) {
                await context.Pool.updateOne(
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
                await context.sendCasinoResult(interaction.user, actualBet, outcome.multiplier, payout, nextMoney);
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
            const targetMember = await context.resolveMember(interaction.guild, targetUserId);
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
            let userRecord = await context.User.findOne({ userId: targetUserId });
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
                userRecord = new context.User({ userId: targetUserId, money: 0 });
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
};
