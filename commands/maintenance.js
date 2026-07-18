const { MessageFlags, PermissionsBitField } = require('discord.js');

module.exports = {
    name: 'maintenance',
    description: 'メンテナンスモードを切り替える',
    options: [
        {
            name: 'enable',
            description: 'メンテナンスモードを有効にするか（Trueで有効、Falseで無効）',
            type: 5,
            required: true
        }
    ],
    async execute(interaction, appState) {
        const OWNER_ID = '1486923873004945509';
        const isOwnerOrAdmin = interaction.user.id === OWNER_ID || (interaction.member && interaction.member.permissions.has(PermissionsBitField.Flags.Administrator));
        
        if (!isOwnerOrAdmin) {
            return interaction.reply({ content: 'このコマンドはオーナーまたは管理者のみ使用できます。', flags: [MessageFlags.Ephemeral] }).catch(() => {});
        }
        
        const enable = interaction.options.getBoolean('enable');
        appState.isMaintenanceMode = enable;
        
        return interaction.reply({ content: `メンテナンスモードを **${enable ? '有効' : '無効'}** に設定しました。`, flags: [MessageFlags.Ephemeral] }).catch(() => {});
    }
};
