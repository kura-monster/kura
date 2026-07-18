const express = require('express');
const axios = require('axios');
const router = express.Router();

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:3000/auth/callback';

router.get('/discord', (req, res) => {
    if (!req.query.sessionToken) {
        return res.status(400).send('Missing sessionToken');
    }
    const state = req.query.sessionToken;
    const authUrl = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify&state=${state}`;
    res.redirect(authUrl);
});

router.get('/callback', async (req, res) => {
    const code = req.query.code;
    const state = req.query.state;
    if (!code || !state) return res.send('無効なリクエストです。');

    try {
        const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
            client_id: DISCORD_CLIENT_ID,
            client_secret: DISCORD_CLIENT_SECRET,
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: REDIRECT_URI
        }).toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const accessToken = tokenResponse.data.access_token;
        const userResponse = await axios.get('https://discord.com/api/users/@me', {
            headers: { authorization: `Bearer ${accessToken}` }
        });

        req.session.discordAuth = {
            sessionToken: state,
            userId: userResponse.data.id,
            username: userResponse.data.username
        };
        res.send('Discord認証が完了しました。元のページに戻ってパスキー認証へ進んでください。<script>setTimeout(()=>window.close(),3000);</script>');
    } catch (err) {
        console.error('OAuth Error:', err.response ? err.response.data : err.message);
        res.send('認証に失敗しました。');
    }
});

module.exports = router;
