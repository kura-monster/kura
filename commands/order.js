const { MessageFlags, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionsBitField } = require('discord.js');
const User = require('../models/User');

module.exports = {
    name: 'order',
    description: '注文機能を開きます',
    async execute(interaction) {
        const embed = new EmbedBuilder()
            .setTitle('注文パネル')
            .setDescription('以下のボタンから注文する内容を選択してください。\nそれぞれの内容に応じた依頼料（マネー）がかかります。')
            .setColor(0x00FF00);
        
        const btnWeb = new ButtonBuilder()
            .setCustomId('order_web')
            .setLabel('Webサイト作成 (100000 マネー)')
            .setStyle(ButtonStyle.Primary);
            
        const btnBot = new ButtonBuilder()
            .setCustomId('order_bot')
            .setLabel('Discord Bot作成 (50000 マネー)')
            .setStyle(ButtonStyle.Primary);
            
        const btnVideo = new ButtonBuilder()
            .setCustomId('order_video')
            .setLabel('動画編集 (20000 マネー)')
            .setStyle(ButtonStyle.Primary);

        const row = new ActionRowBuilder().addComponents(btnWeb, btnBot, btnVideo);
        await interaction.reply({ embeds: [embed], components: [row] });
    }
};
