const { MessageFlags } = require('discord.js');
const { createGroqCompletion, GROQ_MODEL_ID, GROQ_SYSTEM_PROMPT } = require('../utils/groqClient');

module.exports = {
    name: 'bai',
    description: 'AIアシスタントに質問する (Powered by Qwen 32B)',
    options: [
        {
            name: 'question',
            description: '質問内容を入力してください',
            type: 3,
            required: true
        }
    ],
    async execute(interaction, appState) {
        const baiUserId = interaction.user.id;
        const now = Date.now();
        const RATE_WINDOW = 60 * 1000;
        const RATE_LIMIT = 5;
        
        const timestamps = (appState.baiRateLimit.get(baiUserId) || []).filter(t => now - t < RATE_WINDOW);
        if (timestamps.length >= RATE_LIMIT) {
            const waitSec = Math.ceil((RATE_WINDOW - (now - timestamps[0])) / 1000);
            return interaction.reply({ content: `使用回数が上限（1分間に5回）に達しました。${waitSec}秒後にお試しください。`, flags: [MessageFlags.Ephemeral] }).catch(() => {});
        }
        
        timestamps.push(now);
        appState.baiRateLimit.set(baiUserId, timestamps);
        
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
    }
};
