const express = require('express');
const multer = require('multer');
const cors = require('cors');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== 服务器超时设置（关键修复：5分钟）====================
const server = app.listen(PORT, '0.0.0.0');
server.timeout = 300000;
server.keepAliveTimeout = 300000;

// ==================== 多 API 提供商配置 ====================
const PROVIDERS = [
    {
        name: 'GRSAI',
        apiUrl: 'https://grsai.dakka.com.cn/v1/draw/nano-banana',
        apiKey: 'sk-a1c7ff1ce99f4e03a5aed5ddb82dce58',
        modelMapping: {
            'nano-banana-fast': 'nano-banana-fast',
            'nano-banana-pro': 'nano-banana-pro',
            'nano-banana-2': 'nano-banana-2'
        },
        buildRequestBody: (modelId, prompt, images, size, ratio) => {
            const body = {
                model: modelId,
                prompt: prompt,
                image_size: size,
                aspect_ratio: ratio,
                shutProgress: true
            };
            if (images && images.length > 0) {
                const urls = [];
                for (const image of images) {
                    const base64 = image.buffer.toString('base64');
                    const mimeType = image.mimetype;
                    urls.push(`data:${mimeType};base64,${base64}`);
                }
                body.urls = urls;
            }
            return body;
        },
        parseResponse: (data) => {
            if (data.results && Array.isArray(data.results) && data.results[0]) {
                return data.results[0].url || data.results[0];
            }
            if (data.data && data.data.results && data.data.results[0]) {
                return data.data.results[0].url || data.data.results[0];
            }
            if (data.output && Array.isArray(data.output) && data.output[0]) {
                return data.output[0];
            }
            if (data.url) return data.url;
            if (data.image) return data.image;
            return null;
        },
        isSuccess: (data) => {
            return !data.error && !data.msg?.includes('fail') && data.status !== 'failed';
        },
        getErrorMessage: (data) => {
            return data.msg || data.error || data.failure_reason || '未知错误';
        }
    },
    {
        name: 'n1n.ai',
        apiUrl: 'https://api.n1n.ai/v1/chat/completions',
        apiKey: 'sk-wEEKTNnWkyfcHNeLbEv1zLuiSk6vivrbQGRYAh7nZmksJ6Sy',
        modelMapping: {
            'nano-banana-fast': 'gemini-2.5-flash-image',
            'nano-banana-pro': 'gemini-2.5-flash-image',
            'nano-banana-2': 'gemini-2.5-flash-image'
        },
        buildRequestBody: (modelId, prompt, images, size, ratio) => {
            let enhancedPrompt = `${prompt}\n\n【技术要求】\n- 画面比例：${ratio}\n- 画质：${size === '4K' ? '超高清4K' : size === '2K' ? '高清' : '标准'}\n- 输出分辨率：${size}`;
            const content = [{ type: 'text', text: enhancedPrompt }];
            if (images && images.length > 0) {
                for (const image of images) {
                    const base64 = image.buffer.toString('base64');
                    const mimeType = image.mimetype;
                    content.push({
                        type: 'image_url',
                        image_url: { url: `data:${mimeType};base64,${base64}` }
                    });
                }
            }
            return {
                model: modelId,
                messages: [{ role: 'user', content }],
                max_tokens: 4096,
                temperature: 0.7
            };
        },
        parseResponse: (data) => {
            const messageContent = data.choices?.[0]?.message?.content;
            if (typeof messageContent === 'string') {
                const imgMatch = messageContent.match(/!\[.*?\]\((.*?)\)/);
                if (imgMatch) return imgMatch[1];
                const base64Match = messageContent.match(/data:image\/[^;]+;base64,[^"]+/);
                if (base64Match) return base64Match[0];
            }
            return null;
        },
        isSuccess: (data) => {
            return data.choices && data.choices[0] && !data.error;
        },
        getErrorMessage: (data) => {
            return data.error?.message || '未知错误';
        }
    }
];

// ==================== 模型配置 ====================
const MODELS = {
    'nano-banana-fast': {
        name: 'Nano Banana Fast',
        supportsImages: true,
        pricing: { '1K': 4, '2K': 5, '4K': 6 },
        supportedSizes: ['1K', '2K', '4K']
    },
    'nano-banana-pro': {
        name: 'Nano Banana Pro',
        supportsImages: true,
        pricing: { '1K': 6, '2K': 8, '4K': 12 },
        supportedSizes: ['1K', '2K', '4K']
    },
    'nano-banana-2': {
        name: 'Nano Banana 2',
        supportsImages: true,
        pricing: { '1K': 4, '2K': 6, '4K': 10 },
        supportedSizes: ['1K', '2K', '4K']
    }
};

const DEFAULT_MODEL = 'nano-banana-fast';

// ==================== 用户与积分系统 ====================
const PASSWORDS = {
    "xinxing10": { credits: 600, name: "试用用户" },
    "708-20vip": { credits: 800, name: "708舰仔" },
    "Xinxing50vip": { credits: 1000, name: "VIP会员" },
    "xinxinggeniussvip": { credits: 3000, name: "SVIP会员" },
    "xingyuesvip": { credits: 5000, name: "星月SVIP" },
    "xinrui888": { credits: 5000, name: "管理员" }
};

const USERS_FILE = path.join(__dirname, 'users.json');
let users = {};

function loadUsers() {
    try {
        if (fs.existsSync(USERS_FILE)) {
            users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
        }
    } catch(e) {}
}

function saveUsers() {
    try {
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    } catch(e) {}
}

function initUser(password) {
    if (!users[password]) {
        const config = PASSWORDS[password];
        if (!config) return false;
        users[password] = {
            credits: config.credits,
            name: config.name,
            totalGenerated: 0,
            history: []
        };
        saveUsers();
    }
    return true;
}

function deductCredits(password, cost) {
    if (!users[password] || users[password].credits < cost) return false;
    users[password].credits -= cost;
    saveUsers();
    return true;
}

function recordGeneration(password, prompt, size, ratio, model, cost, success) {
    const user = users[password];
    if (!user) return;
    user.totalGenerated++;
    user.history.unshift({
        timestamp: new Date().toISOString(),
        prompt: prompt.substring(0, 100),
        size, ratio, model, cost, success
    });
    if (user.history.length > 50) user.history = user.history.slice(0, 50);
    saveUsers();
}

loadUsers();

// ==================== 跨域 & 解析配置 ====================
app.use(cors({
    origin: true,
    credentials: true,
    maxAge: 86400
}));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use(express.static('public'));

const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 20 * 1024 * 1024 }
});

// 健康检查
app.get('/health', (req, res) => {
    res.json({ status: 'ok', api: 'multi-provider', providers: PROVIDERS.map(p => p.name) });
});

app.get('/api/models', (req, res) => {
    const models = Object.entries(MODELS).map(([id, info]) => ({
        id,
        name: info.name,
        pricing: info.pricing,
        supportedSizes: info.supportedSizes
    }));
    res.json({ success: true, default: DEFAULT_MODEL, models });
});

app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (!PASSWORDS[password]) {
        return res.status(401).json({ success: false, error: '密码错误' });
    }
    initUser(password);
    const user = users[password];
    res.json({
        success: true,
        name: user.name,
        credits: user.credits,
        totalGenerated: user.totalGenerated
    });
});

app.get('/api/stats', (req, res) => {
    const password = req.headers['x-password'];
    if (!password || !users[password]) {
        return res.status(401).json({ success: false });
    }
    const user = users[password];
    res.json({
        success: true,
        name: user.name,
        credits: user.credits,
        totalGenerated: user.totalGenerated,
        history: user.history.slice(0, 20)
    });
});

// ==================== 分辨率与尺寸计算 ====================
const resolutionMap = {
    '1K': { width: 1024, height: 1024, label: '1K', quality: 92 },
    '2K': { width: 2048, height: 2048, label: '2K', quality: 95 },
    '4K': { width: 4096, height: 4096, label: '4K', quality: 98 }
};

const ratioMap = {
    '1:1': { width: 1, height: 1, name: '正方形' },
    '16:9': { width: 16, height: 9, name: '宽屏 16:9' },
    '9:16': { width: 9, height: 16, name: '竖屏 9:16' },
    '4:3': { width: 4, height: 3, name: '横版 4:3' },
    '3:4': { width: 3, height: 4, name: '竖版 3:4' },
    '3:2': { width: 3, height: 2, name: '横版 3:2' },
    '2:3': { width: 2, height: 3, name: '竖版 2:3' },
    '21:9': { width: 21, height: 9, name: '超宽屏 21:9' }
};

function calculateTargetSize(size, ratio) {
    const sizeConfig = resolutionMap[size] || resolutionMap['2K'];
    const ratioConfig = ratioMap[ratio] || ratioMap['1:1'];
    const aspectRatio = ratioConfig.width / ratioConfig.height;
    let width, height;
    if (aspectRatio >= 1) {
        width = sizeConfig.width;
        height = Math.round(sizeConfig.width / aspectRatio);
    } else {
        height = sizeConfig.height;
        width = Math.round(sizeConfig.height * aspectRatio);
    }
    width = width % 2 === 0 ? width : width + 1;
    height = height % 2 === 0 ? height : height + 1;
    return { width, height, label: `${width}x${height}`, ratioName: ratioConfig.name };
}

// 图片缩放（超时延长）
async function resizeImageIfNeeded(imageUrl, targetWidth, targetHeight, quality) {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000);
        const imgResponse = await fetch(imageUrl, { signal: controller.signal });
        clearTimeout(timeoutId);

        if (!imgResponse.ok) throw new Error(`下载图片失败: ${imgResponse.status}`);
        const imgBuffer = await imgResponse.arrayBuffer();
        const metadata = await sharp(imgBuffer).metadata();
        const actualWidth = metadata.width;
        const actualHeight = metadata.height;

        console.log(`📐 实际图片尺寸: ${actualWidth}x${actualHeight}, 目标尺寸: ${targetWidth}x${targetHeight}`);

        if (actualWidth >= targetWidth && actualHeight >= targetHeight) {
            console.log(`✅ 图片尺寸已满足要求`);
            const base64 = Buffer.from(imgBuffer).toString('base64');
            const mimeType = imgResponse.headers.get('content-type') || 'image/png';
            return `data:image/${mimeType};base64,${base64}`;
        }

        console.log(`🖼️ 放大图片至 ${targetWidth}x${targetHeight}`);
        const mimeType = imgResponse.headers.get('content-type') || 'image/png';
        const processed = await sharp(imgBuffer)
            .resize(targetWidth, targetHeight, { fit: 'fill', kernel: 'lanczos3' })
            .sharpen()
            .toFormat(mimeType === 'jpg' || mimeType === 'jpeg' ? 'jpeg' : 'png', {
                quality: quality || 95,
                compressionLevel: 6
            })
            .toBuffer();

        const resizedBase64 = processed.toString('base64');
        return `data:image/${mimeType === 'jpg' ? 'jpeg' : 'png'};base64,${resizedBase64}`;
    } catch (error) {
        console.error('图片处理失败:', error.message);
        return imageUrl;
    }
}

function getCost(modelId, size) {
    const model = MODELS[modelId];
    if (!model) return 999;
    if (!model.supportedSizes.includes(size)) {
        throw new Error(`模型 ${model.name} 不支持 ${size} 画质`);
    }
    return model.pricing[size];
}

// ==================== 核心生成（自动重试 + 长超时）====================
async function generateWithFallback(modelId, prompt, images, ratio, size) {
    const targetSize = calculateTargetSize(size, ratio);
    const sizeConfig = resolutionMap[size] || resolutionMap['2K'];

    for (let provider of PROVIDERS) {
        let retries = 2;
        while (retries > 0) {
            try {
                const mappedModel = provider.modelMapping[modelId];
                if (!mappedModel) break;

                const requestBody = provider.buildRequestBody(mappedModel, prompt, images, size, ratio);
                console.log(`📤 尝试: ${provider.name} | 重试剩余: ${retries}`);

                const controller = new AbortController();
                const fetchTimeout = setTimeout(() => controller.abort(), 180000);

                const response = await fetch(provider.apiUrl, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${provider.apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(requestBody),
                    signal: controller.signal
                });

                clearTimeout(fetchTimeout);
                const rawText = await response.text();
                let data = null;

                try {
                    if (rawText.startsWith('data: ')) {
                        const lines = rawText.split('\n');
                        for (const line of lines) {
                            if (line.startsWith('data: ')) {
                                const jsonStr = line.substring(6).trim();
                                if (jsonStr && jsonStr !== '[DONE]') {
                                    data = JSON.parse(jsonStr);
                                    break;
                                }
                            }
                        }
                    } else {
                        data = JSON.parse(rawText);
                    }
                } catch (e) {}

                if (!data || !provider.isSuccess(data)) {
                    throw new Error(provider.getErrorMessage(data) || 'API返回异常');
                }

                let imageUrl = provider.parseResponse(data);
                if (!imageUrl) throw new Error('未获取到图片');

                console.log(`✅ ${provider.name} 生成成功`);

                let finalImage;
                if (size === '4K') {
                    finalImage = imageUrl;
                } else {
                    finalImage = await resizeImageIfNeeded(imageUrl, targetSize.width, targetSize.height, sizeConfig.quality);
                }

                return { image: finalImage, targetSize: targetSize.label, provider: provider.name };

            } catch (error) {
                retries--;
                console.error(`❌ 失败，剩余重试: ${retries} → ${error.message}`);
                if (retries <= 0) break;
                await new Promise(r => setTimeout(r, 3000));
            }
        }
    }

    throw new Error('所有API均失败，请稍后再试');
}

// ==================== 生成图片路由 ====================
app.post('/api/generate', upload.array('images', 3), async (req, res) => {
    try {
        const password = req.headers['x-password'];
        if (!password || !users[password]) {
            return res.status(401).json({ success: false, error: '请先登录' });
        }

        const { prompt, size = '2K', ratio = '1:1', model = DEFAULT_MODEL } = req.body;
        const images = req.files;

        if (!prompt) {
            return res.status(400).json({ success: false, error: '请输入提示词' });
        }

        const modelConfig = MODELS[model];
        if (!modelConfig) {
            return res.status(400).json({ success: false, error: `不支持的模型: ${model}` });
        }

        let cost;
        try {
            cost = getCost(model, size);
        } catch (err) {
            return res.status(400).json({ success: false, error: err.message });
        }

        if (users[password].credits < cost) {
            return res.status(402).json({
                success: false,
                error: `积分不足！需要 ${cost} 积分，当前剩余 ${users[password].credits} 积分`
            });
        }

        console.log(`\n📥 生成请求 | 用户: ${users[password].name} | 积分: ${users[password].credits}`);

        const deducted = deductCredits(password, cost);
        if (!deducted) {
            return res.status(402).json({ success: false, error: '积分扣减失败' });
        }

        const result = await generateWithFallback(model, prompt, images, ratio, size);
        recordGeneration(password, prompt, size, ratio, model, cost, true);

        res.json({
            success: true,
            image: result.image,
            targetSize: result.targetSize,
            credits: users[password].credits,
            provider: result.provider,
            model: model
        });

    } catch (error) {
        console.error('❌ 生成错误:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

console.log(`\n🚀 ===== 天才新星 修复版已启动 =====`);
console.log(`✅ 超时：5分钟 | ✅ 自动重试 | ✅ 跨域修复 | ✅ 大文件支持`);
console.log(`=======================================\n`);