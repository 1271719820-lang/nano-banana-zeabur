const express = require('express');
const multer = require('multer');
const cors = require('cors');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

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
            // 尝试多种可能的响应结构
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
        apiKey: 'sk-wEEKTNnWkyfcHNeLbEv1zLuiSk6vivrbQGRYAh7nZmksJ6Sy', // 替换为你的 n1n.ai Key
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

// ==================== 模型配置（支持 4K 画质，新积分规则）====================
const MODELS = {
    'nano-banana-fast': {
        name: 'Nano Banana Fast',
        supportsImages: true,
        description: '快速生成',
        pricing: { '1K': 4, '2K': 5, '4K': 6 },
        supportedSizes: ['1K', '2K', '4K']
    },
    'nano-banana-pro': {
        name: 'Nano Banana Pro',
        supportsImages: true,
        description: '专业版',
        pricing: { '1K': 6, '2K': 8, '4K': 12 },
        supportedSizes: ['1K', '2K', '4K']
    },
    'nano-banana-2': {
        name: 'Nano Banana 2',
        supportsImages: true,
        description: '标准版',
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

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// 健康检查
app.get('/health', (req, res) => {
    res.json({ status: 'ok', api: 'multi-provider', providers: PROVIDERS.map(p => p.name) });
});

// 获取模型列表
app.get('/api/models', (req, res) => {
    const models = Object.entries(MODELS).map(([id, info]) => ({
        id,
        name: info.name,
        description: info.description,
        pricing: info.pricing,
        supportedSizes: info.supportedSizes
    }));
    res.json({ success: true, default: DEFAULT_MODEL, models });
});

// 登录
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

// 获取用户统计
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

// ==================== 分辨率与图片处理 ====================
const resolutionMap = {
    '1K': { width: 1024, height: 1024, label: '1K', quality: 92 },
    '2K': { width: 2048, height: 2048, label: '2K', quality: 95 },
    '4K': { width: 4096, height: 4096, label: '4K', quality: 98 }
};

const ratioMap = {
    '1:1': { width: 1, height: 1, name: '正方形', apiValue: '1:1' },
    '16:9': { width: 16, height: 9, name: '宽屏 16:9', apiValue: '16:9' },
    '9:16': { width: 9, height: 16, name: '竖屏 9:16', apiValue: '9:16' },
    '4:3': { width: 4, height: 3, name: '横版 4:3', apiValue: '4:3' },
    '3:4': { width: 3, height: 4, name: '竖版 3:4', apiValue: '3:4' },
    '3:2': { width: 3, height: 2, name: '横版 3:2', apiValue: '3:2' },
    '2:3': { width: 2, height: 3, name: '竖版 2:3', apiValue: '2:3' },
    '21:9': { width: 21, height: 9, name: '超宽屏 21:9', apiValue: '21:9' }
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

async function resizeImageIfNeeded(imageUrl, targetWidth, targetHeight, quality) {
    try {
        const imgResponse = await fetch(imageUrl);
        if (!imgResponse.ok) throw new Error(`下载图片失败: ${imgResponse.status}`);
        const imgBuffer = await imgResponse.arrayBuffer();
        const metadata = await sharp(imgBuffer).metadata();
        const actualWidth = metadata.width;
        const actualHeight = metadata.height;

        console.log(`📐 实际图片尺寸: ${actualWidth}x${actualHeight}, 目标尺寸: ${targetWidth}x${targetHeight}`);

        if (actualWidth >= targetWidth && actualHeight >= targetHeight) {
            console.log(`✅ 图片尺寸已满足要求，直接使用原图`);
            const base64 = imgBuffer.toString('base64');
            const mimeType = imgResponse.headers.get('content-type') || 'image/png';
            return `data:image/${mimeType};base64,${base64}`;
        }

        console.log(`🖼️ 放大图片至 ${targetWidth}x${targetHeight}`);
        const processed = await sharp(imgBuffer)
            .resize(targetWidth, targetHeight, { fit: 'fill', kernel: 'lanczos3' })
            .sharpen()
            .toFormat(mimeType === 'jpg' || mimeType === 'jpeg' ? 'jpeg' : 'png', {
                quality: quality || 95,
                compressionLevel: 9,
                effort: 10
            })
            .toBuffer();
        const resizedBase64 = processed.toString('base64');
        const mimeType = imgResponse.headers.get('content-type') || 'image/png';
        return `data:image/${mimeType === 'jpg' ? 'jpeg' : 'png'};base64,${resizedBase64}`;
    } catch (error) {
        console.error('图片处理失败:', error);
        // 降级：直接返回原始图片 URL
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

// ==================== 核心生成函数（带故障转移）====================
async function generateWithFallback(modelId, prompt, images, ratio, size) {
    const targetSize = calculateTargetSize(size, ratio);
    const sizeConfig = resolutionMap[size] || resolutionMap['2K'];

    for (let provider of PROVIDERS) {
        try {
            const mappedModel = provider.modelMapping[modelId];
            if (!mappedModel) {
                console.log(`⚠️ 提供商 ${provider.name} 不支持模型 ${modelId}，跳过`);
                continue;
            }

            const requestBody = provider.buildRequestBody(mappedModel, prompt, images, size, ratio);
            console.log(`📤 尝试提供商: ${provider.name}, 模型: ${mappedModel}`);
            console.log(`   请求体:`, JSON.stringify(requestBody).substring(0, 500));

            const response = await fetch(provider.apiUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${provider.apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(requestBody)
            });

            const rawText = await response.text();
            console.log(`📥 ${provider.name} 原始响应 (前500字符): ${rawText.substring(0, 500)}`);

            let data = null;
            // 尝试解析 SSE 格式（每行以 data: 开头）
            if (rawText.startsWith('data: ')) {
                const lines = rawText.split('\n');
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const jsonStr = line.substring(6).trim();
                        if (jsonStr && jsonStr !== '[DONE]') {
                            try {
                                data = JSON.parse(jsonStr);
                                break; // 取第一个有效的 data
                            } catch(e) {}
                        }
                    }
                }
            } else {
                try {
                    data = JSON.parse(rawText);
                } catch(e) {}
            }

            if (!data) {
                throw new Error('无法解析响应');
            }

            if (!response.ok || !provider.isSuccess(data)) {
                throw new Error(provider.getErrorMessage(data));
            }

            let imageUrl = provider.parseResponse(data);
            if (!imageUrl) {
                console.error(`❌ ${provider.name} 响应中未找到图片 URL，完整响应:`, JSON.stringify(data, null, 2));
                throw new Error('未返回图片 URL');
            }

            console.log(`✅ ${provider.name} 生成成功，图片 URL: ${imageUrl.substring(0, 100)}...`);

            // 可选：如果需要缩放，则缩放；如果不需要，可以直接返回 URL（但前端需要支持跨域）
            const finalImage = await resizeImageIfNeeded(imageUrl, targetSize.width, targetSize.height, sizeConfig.quality);
            return { image: finalImage, targetSize: targetSize.label, provider: provider.name };

        } catch (error) {
            console.error(`❌ 提供商 ${provider.name} 失败:`, error.message);
        }
    }

    throw new Error('所有 API 提供商均失败，请稍后再试');
}

// ==================== 生成图片路由（支持并发）====================
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

        console.log(`\n📥 ===== 生成请求 =====`);
        console.log(`用户: ${users[password].name} (${password})`);
        console.log(`模型: ${modelConfig.name}`);
        console.log(`画质: ${size}, 比例: ${ratio}`);
        console.log(`所需积分: ${cost}`);
        console.log(`当前积分: ${users[password].credits}`);

        // 扣减积分
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
        // 生成失败，不退积分（可根据业务决定是否退还）
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 ===== 天才新星 (多提供商版) 已启动 =====`);
    console.log(`📡 http://localhost:${PORT}`);
    console.log(`🤖 可用模型: ${Object.keys(MODELS).join(', ')}`);
    console.log(`🔁 故障转移顺序: ${PROVIDERS.map(p => p.name).join(' → ')}`);
    console.log(`================================\n`);
});