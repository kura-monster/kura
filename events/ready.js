const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

module.exports = function registerReadyHandlers(client, context) {
    client.once('clientReady', async () => {
        console.log(`Logged in as ${client.user.tag}!`);
        try {
            await context.mongoose.connect(context.MONGODB_URI);
            console.log('Connected to MongoDB');
        } catch (error) {
            console.error('MongoDB connection error:', error);
        }

        try {
            await client.application.commands.set(context.commandDefinitions);
            console.log('Slash commands registered.');
        } catch (err) {
            console.error('Failed to register slash commands:', err);
        }

        setInterval(async () => {
            const shopChannel = client.channels.cache.get(context.SHOP_CHANNEL_ID);
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
};
