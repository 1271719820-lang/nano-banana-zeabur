const express = require('express');
const multer = require('multer');
const cors = require('cors');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== 配置 n1n.ai API（统一密钥）=====
const N1N_API_KEY = "sk-wEEKTNnWkyfcHNeLbEv1zLuiSk6vivrbQGRYAh7nZmksJ6Sy";
const N1N_API_URL = "https://api.n1n.ai/v1/chat/completions";

// ===== 模型配置 =====
const MODELS = {
    // Gemini 模型
    gemini: {
        name: "Gemini 2.5 Flash Image",
        modelId: "gemini-2.5-flash-image",
        supportsImages: true,
        description: "最强生图，支持多图融合、4K超清"
    },
    // GPT 图像模型 (DALL-E)
    gpt: {
        name: "GPT-4o (DALL-E 3)",
        modelId: "gpt-4o",  // 或 "dall-e-3"，根据 n1n.ai 支持的格式
        supportsImages: false,
        description: "高质量写实风格、创意插画"
    }
};

// ===== 密码配置 =====
const PASSWORDS = {
    "xinxing10": { dailyLimit: 20, name: "试用用户" },
    "708-20vip": { dailyLimit: 30, name: "708靓仔" },
    "Xinxing50vip": { dailyLimit: 50, name: "VIP会员" },
    "xinxinggeniussvip": { dailyLimit: 100, name: "SVIP会员" },
    "xingyuesvip": { dailyLimit: 200, name: "SVIP会员" },
    "xinrui888": { dailyLimit: 500, name: "管理员" }
};

// ===== 统计数据存储 =====
const STATS_FILE = path.join(__dirname, 'stats.json');
let userStats = {};

function loadStats() {
    try {
        if (fs.existsSync(STATS_FILE)) {
            userStats = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
            const today = new Date().toDateString();
            for (const [pwd, stats] of Object.entries(userStats)) {
                if (stats.lastResetDate !== today) {
                    stats.todayCount = 0;
                    stats.lastResetDate = today;
                }
            }
        }
    } catch(e) {}
}

function saveStats() {
    try {
        fs.writeFileSync(STATS_FILE, JSON.stringify(userStats, null, 2));
    } catch(e) {}
}

function initUserStats(password) {
    if (!userStats[password]) {
        const config = PASSWORDS[password];
        userStats[password] = {
            dailyLimit: config.dailyLimit,
            name: config.name,
            todayCount: 0,
            totalGenerated: 0,
            lastResetDate: new Date().toDateString(),
            history: []
        };
        saveStats();
    }
}

function canGenerate(password) {
    const stats = userStats[password];
    if (!stats) return false;
    const today = new Date().toDateString();
    if (stats.lastResetDate !== today) {
        stats.todayCount = 0;
        stats.lastResetDate = today;
        saveStats();
    }
    return stats.todayCount < stats.dailyLimit;
}

function recordGeneration(password, prompt, size, ratio, model, success) {
    const stats = userStats[password];
    if (!stats) return;
    stats.totalGenerated++;
    stats.todayCount++;
    stats.history.unshift({
        timestamp: new Date().toISOString(),
        prompt: prompt.substring(0, 100),
        size, ratio, model, success
    });
    if (stats.history.length > 50) stats.history = stats.history.slice(0, 50);
    saveStats();
}

loadStats();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// 健康检查
app.get('/health', (req, res) => {
    res.json({ status: 'ok', api: 'n1n.ai', models: MODELS });
});

// 登录
app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (!PASSWORDS[password]) {
        return res.status(401).json({ success: false, error: '密码错误' });
    }
    initUserStats(password);
    const stats = userStats[password];
    res.json({
        success: true,
        name: stats.name,
        dailyLimit: stats.dailyLimit,
        todayCount: stats.todayCount,
        remaining: stats.dailyLimit - stats.todayCount
    });
});

// 获取统计
app.get('/api/stats', (req, res) => {
    const password = req.headers['x-password'];
    if (!password || !userStats[password]) {
        return res.status(401).json({ success: false });
    }
    const stats = userStats[password];
    const today = new Date().toDateString();
    if (stats.lastResetDate !== today) {
        stats.todayCount = 0;
        stats.lastResetDate = today;
        saveStats();
    }
    res.json({
        success: true,
        name: stats.name,
        dailyLimit: stats.dailyLimit,
        todayCount: stats.todayCount,
        remaining: stats.dailyLimit - stats.todayCount,
        totalGenerated: stats.totalGenerated,
        history: stats.history.slice(0, 20)
    });
});

// ===== 分辨率映射 =====
const resolutionMap = {
    '1K': { maxDimension: 1024, label: '1024x1024' },
    '2K': { maxDimension: 2048, label: '2048x2048' },
    '4K': { maxDimension: 4096, label: '4096x4096' }
};

const ratioMap = {
    '1:1': { width: 1, height: 1, name: '正方形' },
    '4:3': { width: 4, height: 3, name: '横版 4:3' },
    '3:4': { width: 3, height: 4, name: '竖版 3:4' },
    '16:9': { width: 16, height: 9, name: '宽屏 16:9' },
    '9:16': { width: 9, height: 16, name: '竖屏 9:16' }
};

function calculateTargetSize(size, ratio) {
    const sizeConfig = resolutionMap[size] || resolutionMap['2K'];
    const ratioConfig = ratioMap[ratio] || ratioMap['1:1'];
    const maxDimension = sizeConfig.maxDimension;
    const aspectRatio = ratioConfig.width / ratioConfig.height;
    let width, height;
    if (aspectRatio >= 1) {
        width = maxDimension;
        height = Math.round(maxDimension / aspectRatio);
    } else {
        height = maxDimension;
        width = Math.round(maxDimension * aspectRatio);
    }
    width = width % 2 === 0 ? width : width + 1;
    height = height % 2 === 0 ? height : height + 1;
    return { width, height, label: `${width}x${height}`, ratioName: ratioConfig.name };
}

async function resizeImage(imageBase64, targetWidth, targetHeight) {
    try {
        let base64Data = imageBase64;
        let mimeType = 'image/png';
        if (imageBase64.startsWith('data:image')) {
            const matches = imageBase64.match(/^data:image\/(\w+);base64,(.+)$/);
            if (matches) {
                mimeType = matches[1];
                base64Data = matches[2];
            }
        }
        const imageBuffer = Buffer.from(base64Data, 'base64');
        const resizedBuffer = await sharp(imageBuffer)
            .resize(targetWidth, targetHeight, { fit: 'cover', kernel: 'lanczos3' })
            .toFormat(mimeType === 'jpg' ? 'jpeg' : mimeType, { quality: 95 })
            .toBuffer();
        return `data:image/${mimeType};base64,${resizedBuffer.toString('base64')}`;
    } catch (error) {
        return imageBase64;
    }
}

// ===== 通用生成函数（使用 n1n.ai）=====
async function generateWithModel(prompt, size, ratio, images, modelType) {
    const targetSize = calculateTargetSize(size, ratio);
    const modelConfig = MODELS[modelType];
    
    // 构建提示词
    let enhancedPrompt = `${prompt}\n\n【技术要求】\n- 画面比例：${targetSize.ratioName} (${ratio})\n- 画质风格：${size === '1K' ? '标准' : size === '2K' ? '高清' : '超高清4K'}\n- 最终输出分辨率：${targetSize.label}`;
    
    // 构建消息内容
    const content = [{ type: "text", text: enhancedPrompt }];
    
    // 只有 Gemini 支持参考图
    if (modelConfig.supportsImages && images && images.length > 0) {
        for (const image of images) {
            const base64 = image.buffer.toString('base64');
            content.push({ type: "image_url", image_url: { url: `data:${image.mimetype};base64,${base64}` } });
        }
    }
    
    // 调用 n1n.ai API
    const response = await fetch(N1N_API_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${N1N_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: modelConfig.modelId,
            messages: [{ role: "user", content }],
            max_tokens: 4096,
            temperature: 0.7
        })
    });
    
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || `${modelConfig.name} API 请求失败`);
    
    const messageContent = data.choices[0].message.content;
    let imageUrl = null;
    
    if (typeof messageContent === 'string') {
        const imgMatch = messageContent.match(/!\[.*?\]\((.*?)\)/);
        if (imgMatch) imageUrl = imgMatch[1];
        else {
            const base64Match = messageContent.match(/data:image\/[^;]+;base64,[^"]+/);
            if (base64Match) imageUrl = base64Match[0];
        }
    }
    
    if (!imageUrl) throw new Error(`${modelConfig.name} 未返回图片`);
    
    const resizedImage = await resizeImage(imageUrl, targetSize.width, targetSize.height);
    return { image: resizedImage, targetSize: targetSize.label };
}

// 生成图片主路由
app.post('/api/generate', upload.array('images', 3), async (req, res) => {
    try {
        const password = req.headers['x-password'];
        if (!password || !userStats[password]) {
            return res.status(401).json({ success: false, error: '请先登录' });
        }
        
        if (!canGenerate(password)) {
            return res.status(429).json({
                success: false,
                error: `今日次数已用完 (${userStats[password].dailyLimit}次/天)`
            });
        }
        
        const { prompt, size = '2K', ratio = '1:1', model = 'gemini' } = req.body;
        const images = req.files;
        
        if (!prompt) {
            return res.status(400).json({ success: false, error: '请输入提示词' });
        }
        
        // 验证模型是否存在
        if (!MODELS[model]) {
            throw new Error(`不支持的模型: ${model}`);
        }
        
        // GPT 模型不支持参考图，如果上传了参考图但选了 GPT，给个提示但继续生成
        if (model === 'gpt' && images && images.length > 0) {
            console.log('⚠️ GPT 模型不支持参考图融合，将忽略参考图');
        }
        
        const result = await generateWithModel(prompt, size, ratio, images, model);
        
        recordGeneration(password, prompt, size, ratio, model, true);
        const stats = userStats[password];
        
        res.json({
            success: true,
            image: result.image,
            targetSize: result.targetSize,
            remaining: stats.dailyLimit - stats.todayCount,
            model: model
        });
        
    } catch (error) {
        console.error('生成错误:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🔑 使用统一 n1n.ai API Key`);
    console.log(`🤖 可用模型: ${Object.keys(MODELS).join(', ')}`);
});