const { MessageFlags, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } = require('discord.js');

module.exports = {
    name: 'to',
    description: 'タイムアウト解除の申請を開始します',
    async execute(interaction, appState) {
        const pendingReviews = [...appState.pendingTimeoutReviews.values()]
            .filter(review => review.targetUserId === interaction.user.id)
            .sort((a, b) => b.createdAt - a.createdAt);
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

        return interaction.reply({ embeds: [embed], components: [row], flags: [MessageFlags.Ephemeral] }).catch(() => {});
    }
};
