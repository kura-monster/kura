const https = require('https');

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

    if (!value) {
        return null;
    }

    return value;
}

function normalizeGroqKey(rawValue) {
    if (typeof rawValue !== 'string') {
        return null;
    }

    let key = rawValue.trim();
    key = key.replace(/^\uFEFF/, '').replace(/^['"]|['"]$/g, '');
    key = key.replace(/\s+/g, '');
    key = key.replace(/[\u0000-\u001F\u007F]/g, '');
    key = key.replace(/[^\x20-\x7E]/g, '');
    key = key.trim();

    if (!key) {
        return null;
    }

    if (!/^gsk_[A-Za-z0-9_-]+$/i.test(key)) {
        return null;
    }

    return key;
}

function parseGroqKeys() {
    const sources = [process.env.GROQ_KEY, process.env.GROQ_API_KEYS, process.env.GROQ_API_KEY]
        .filter(value => typeof value === 'string' && value.trim() !== '');

    const rawKeys = sources
        .join(',')
        .split(/[,\n]+/)
        .map(key => normalizeGroqKey(key))
        .filter(Boolean);

    return rawKeys;
}

let groqKeys = [];

function refreshGroqKeys() {
    const keys = parseGroqKeys();
    groqKeys = keys;

    if (groqKeys.length === 0) {
        const detail = [
            'No valid Groq API keys were found.',
            'Set the environment variable GROQ_KEY with comma-separated keys, or use GROQ_API_KEYS/GROQ_API_KEY.',
            'Example: GROQ_KEY=gsk_key1,gsk_key2'
        ].join(' ');
        console.error(`[GROQ] ${detail}`);
        process.exit(1);
    }

    return groqKeys;
}

function getRandomGroqKey() {
    const keys = groqKeys.length > 0 ? groqKeys : refreshGroqKeys();
    if (keys.length === 0) {
        const detail = 'No valid Groq API keys are available after refresh.';
        console.error(`[GROQ] ${detail}`);
        process.exit(1);
    }

    const index = Math.floor(Math.random() * keys.length);
    return keys[index];
}

function normalizeGroqError(error) {
    const status = error?.status || error?.response?.status;
    const message = String(error?.message || '').toLowerCase();
    return {
        status,
        message,
        shouldRetry: status === 401 || status === 429 || message.includes('rate') || message.includes('auth') || message.includes('api key') || message.includes('authorization')
    };
}

async function createGroqCompletion(request, options = {}) {
    const keys = groqKeys.length > 0 ? groqKeys : refreshGroqKeys();
    if (keys.length === 0) {
        const detail = 'No valid Groq API keys are available before request execution.';
        console.error(`[GROQ] ${detail}`);
        process.exit(1);
    }

    const timeoutMs = Number(options.timeout) || 15000;

    let lastError;
    for (let i = 0; i < keys.length; i++) {
        const key = sanitizeBearerToken(getRandomGroqKey());
        if (!key) {
            continue;
        }
        try {
            const body = JSON.stringify(request);
            const response = await new Promise((resolve, reject) => {
                const req = https.request({
                    hostname: 'api.groq.com',
                    path: '/openai/v1/chat/completions',
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${key}`,
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    },
                    timeout: timeoutMs
                }, (res) => {
                    const chunks = [];
                    res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
                    res.on('end', () => {
                        const bodyText = Buffer.concat(chunks).toString('utf8');
                        let parsedBody = null;
                        try {
                            parsedBody = bodyText ? JSON.parse(bodyText) : null;
                        } catch (error) {
                            parsedBody = { raw: bodyText };
                        }
                        resolve({
                            statusCode: res.statusCode || 0,
                            bodyText,
                            parsedBody
                        });
                    });
                });

                req.on('timeout', () => {
                    req.destroy(new Error('timeout'));
                });
                req.on('error', reject);
                req.write(body);
                req.end();
            });

            if (response.statusCode >= 400) {
                const errorMessage = response.parsedBody?.error?.message || response.parsedBody?.message || response.bodyText || `HTTP ${response.statusCode}`;
                const error = new Error(errorMessage);
                error.status = response.statusCode;
                throw error;
            }

            const parsedBody = response.parsedBody || {};
            if (parsedBody.choices) {
                return parsedBody;
            }

            return {
                choices: [
                    {
                        message: {
                            content: parsedBody?.choices?.[0]?.message?.content || parsedBody?.content || parsedBody?.message || ''
                        }
                    }
                ]
            };
        } catch (error) {
            lastError = error;
            const { shouldRetry } = normalizeGroqError(error);
            if (!shouldRetry) {
                throw error;
            }
        }
    }

    throw lastError || new Error('Groq request failed.');
}

const GROQ_MODEL_ID = "qwen/qwen3-32b";
const GROQ_SYSTEM_PROMPT = `あなたは役立つアシスタントです。
プロンプトエンジニアリングの観点から以下の情報を踏まえて回答してください：
- あなた自身のアイデンティティ（自認）は「Qwenをもとに作られた Kura-32b (ID-1m123nb1n)」です。
- 開発者はKlyn
- 提供元はKura
- 公式Discordサーバー: <https://discord.gg/D6PGKFKZEq> （※Discordの仕様上、URLは必ず \`<\` と \`>\` で囲んで出力してください。URLの直後に句読点「。」をつけないでください）
- 【重要】回答は必ず 600文字以内 に収めてください。短く簡潔にまとめること。

ユーザーからの質問に対して、自身が Kura-32b であることを踏まえつつ、適切かつ高品質な回答を提供してください。`;

module.exports = {
    getGroqClient: getRandomGroqKey,
    createGroqCompletion,
    GROQ_MODEL_ID,
    GROQ_SYSTEM_PROMPT
};
