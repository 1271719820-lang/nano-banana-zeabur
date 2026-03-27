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
    // Gemini 模型 - 最强生图，支持参考图
    gemini: {
        name: "Gemini 2.5 Flash Image",
        modelId: "gemini-2.5-flash-image",
        supportsImages: true,
        requiresImages: false,
        description: "最强生图，支持多图融合、风格迁移、4K超清"
    },
    // Midjourney Blend 模型 - 混合模式，支持参考图
    midjourney: {
        name: "Midjourney Blend",
        modelId: "mj_blend",
        supportsImages: true,
        requiresImages: true,  // 必须上传参考图才能使用混合模式
        description: "混合模式，上传2-5张图片融合生成，艺术风格极佳，4K超清细节"
    }
};

// ===== 密码配置 =====
const PASSWORDS = {
    "xinxing10": { dailyLimit: 20, name: "试用用户" },
    "708-20vip": { dailyLimit: 30, name: "708靓仔" },
    "Xinxing50vip": { dailyLimit: 50, name: "VIP会员" },
    "xinxinggeniussvip": { dailyLimit: 100, name: "SVIP会员" },
    "xingyuesvip": { dailyLimit: 200, name: "星月SVIP" },
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
    '1K': { maxDimension: 1024, label: '1024x1024', quality: 90 },
    '2K': { maxDimension: 2048, label: '2048x2048', quality: 92 },
    '4K': { maxDimension: 4096, label: '4096x4096', quality: 95 }
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

// ===== 高质量图片缩放函数 =====
async function resizeImageWithQuality(imageBase64, targetWidth, targetHeight, quality) {
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
        const metadata = await sharp(imageBuffer).metadata();
        
        console.log(`   原图尺寸: ${metadata.width}x${metadata.height}`);
        
        // 使用高质量缩放算法 + 锐化
        const resizedBuffer = await sharp(imageBuffer)
            .resize(targetWidth, targetHeight, {
                fit: 'fill',
                kernel: 'lanczos3',  // 最高质量缩放算法
                withoutEnlargement: false
            })
            .sharpen()  // 添加锐化，增强细节
            .toFormat(mimeType === 'jpg' || mimeType === 'jpeg' ? 'jpeg' : 'png', {
                quality: quality || 95,
                compressionLevel: 9,
                effort: 10
            })
            .toBuffer();
        
        const resizedBase64 = resizedBuffer.toString('base64');
        console.log(`   缩放后尺寸: ${targetWidth}x${targetHeight}`);
        
        return `data:image/${mimeType === 'jpg' ? 'jpeg' : mimeType};base64,${resizedBase64}`;
        
    } catch (error) {
        console.error('图片缩放失败:', error);
        return imageBase64;
    }
}

// ===== 增强提示词 =====
function enhancePromptWithSettings(prompt, size, ratio, targetSize, modelType) {
    let cleanPrompt = prompt;
    cleanPrompt = cleanPrompt.replace(/[,，]?\s*比例:\s*[0-9:]+\s*$/, '');
    cleanPrompt = cleanPrompt.replace(/[,，]?\s*画质:\s*\w+\s*$/, '');
    
    const sizeQualityMap = {
        '1K': '标准清晰度，细节清晰',
        '2K': '高清画质，细节丰富，纹理细腻',
        '4K': '超高清 4K 画质，极致细节，专业摄影级别，光影质感极佳，8K分辨率级别清晰度'
    };
    
    const modelStyleMap = {
        gemini: '写实风格，照片级真实感',
        midjourney: '艺术风格，光影质感，电影级画面，构图精美'
    };
    
    return `${cleanPrompt}

【严格的技术要求 - 必须遵守】
- 画面比例：${targetSize.ratioName} (${ratio})
- 画质要求：${sizeQualityMap[size] || '高清画质'}
- 风格要求：${modelStyleMap[modelType] || '高质量图像'}
- 输出分辨率：${targetSize.label}，必须为超高清
- 细节要求：${size === '4K' ? '4K 超高清级别，纹理极其清晰，光影自然，边缘锐利' : '高清级别，细节丰富'}

请生成一张${size === '4K' ? '超高清 4K' : size === '2K' ? '高清' : '标准'}级别的图片，确保画质清晰，细节丰富。`;
}

// ===== Gemini 生成函数 =====
async function generateWithGemini(prompt, size, ratio, images) {
    const targetSize = calculateTargetSize(size, ratio);
    const sizeConfig = resolutionMap[size] || resolutionMap['2K'];
    
    const enhancedPrompt = enhancePromptWithSettings(prompt, size, ratio, targetSize, 'gemini');
    
    const content = [{ type: "text", text: enhancedPrompt }];
    
    if (images && images.length > 0) {
        for (const image of images) {
            const base64 = image.buffer.toString('base64');
            content.push({ type: "image_url", image_url: { url: `data:${image.mimetype};base64,${base64}` } });
        }
    }
    
    console.log(`📤 调用 Gemini 生成图片...`);
    console.log(`   参考图数量: ${images?.length || 0}`);
    console.log(`   目标尺寸: ${targetSize.label}`);
    console.log(`   画质: ${size}`);
    
    const response = await fetch(N1N_API_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${N1N_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: MODELS.gemini.modelId,
            messages: [{ role: "user", content }],
            max_tokens: 4096,
            temperature: 0.7
        })
    });
    
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Gemini API 请求失败');
    
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
    
    if (!imageUrl) throw new Error('Gemini 未返回图片');
    
    const resizedImage = await resizeImageWithQuality(imageUrl, targetSize.width, targetSize.height, sizeConfig.quality);
    
    return { image: resizedImage, targetSize: targetSize.label };
}

// ===== Midjourney Blend 生成函数（支持参考图混合）=====
async function generateWithMidjourneyBlend(prompt, size, ratio, images) {
    const targetSize = calculateTargetSize(size, ratio);
    const sizeConfig = resolutionMap[size] || resolutionMap['2K'];
    
    // 检查是否有参考图（Blend 模式必须有参考图）
    if (!images || images.length === 0) {
        throw new Error('Midjourney Blend 模式需要至少上传 1 张参考图进行混合');
    }
    
    if (images.length < 2) {
        console.log('⚠️ 提示：混合模式效果最佳是 2-5 张图片，当前只有 1 张');
    }
    
    // 构建混合提示词
    const enhancedPrompt = `混合生成一张图片，融合这些图片的元素和风格。${prompt}

【混合要求】
- 画面比例：${targetSize.ratioName} (${ratio})
- 画质：${size === '4K' ? '超高清4K' : size === '2K' ? '高清' : '标准'}
- 融合风格：自然过渡，元素融合，${size === '4K' ? '极致细节' : '细节丰富'}
- 输出分辨率：${targetSize.label}`;
    
    // 构建消息内容
    const content = [{ type: "text", text: enhancedPrompt }];
    
    // 添加参考图
    for (const image of images) {
        const base64 = image.buffer.toString('base64');
        const mimeType = image.mimetype;
        content.push({
            type: "image_url",
            image_url: { url: `data:${mimeType};base64,${base64}` }
        });
    }
    
    console.log(`📤 调用 Midjourney Blend 混合模式...`);
    console.log(`   参考图数量: ${images.length}`);
    console.log(`   目标尺寸: ${targetSize.label}`);
    console.log(`   画质: ${size}`);
    
    // 根据比例设置 dimensions 参数
    let dimensions = 'square';
    if (ratio === '16:9') dimensions = 'landscape';
    else if (ratio === '9:16') dimensions = 'portrait';
    else if (ratio === '4:3') dimensions = 'landscape';
    else if (ratio === '3:4') dimensions = 'portrait';
    
    // 调用 n1n.ai Midjourney Blend API
    const response = await fetch(N1N_API_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${N1N_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: MODELS.midjourney.modelId,
            messages: [{ role: "user", content }],
            dimensions: dimensions,
            max_tokens: 4096
        })
    });
    
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Midjourney Blend API 请求失败');
    
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
    
    if (!imageUrl) throw new Error('Midjourney Blend 未返回图片');
    
    // 高质量缩放
    const resizedImage = await resizeImageWithQuality(imageUrl, targetSize.width, targetSize.height, sizeConfig.quality);
    
    return { image: resizedImage, targetSize: targetSize.label };
}

// ===== 生成图片主路由 =====
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
        
        const modelConfig = MODELS[model];
        
        // 检查 Midjourney Blend 是否需要参考图
        if (model === 'midjourney' && modelConfig.requiresImages && (!images || images.length === 0)) {
            return res.status(400).json({ 
                success: false, 
                error: 'Midjourney Blend 模式需要上传至少 1 张参考图进行混合生成'
            });
        }
        
        console.log(`\n📥 ===== 生成请求 =====`);
        console.log(`模型: ${modelConfig.name}`);
        console.log(`提示词: ${prompt}`);
        console.log(`画质: ${size}, 比例: ${ratio}`);
        console.log(`参考图数量: ${images?.length || 0}`);
        
        let result;
        if (model === 'gemini') {
            result = await generateWithGemini(prompt, size, ratio, images);
        } else if (model === 'midjourney') {
            result = await generateWithMidjourneyBlend(prompt, size, ratio, images);
        } else {
            throw new Error('未知模型');
        }
        
        recordGeneration(password, prompt, size, ratio, model, true);
        const stats = userStats[password];
        
        console.log(`✅ 生成成功！剩余次数: ${stats.dailyLimit - stats.todayCount}`);
        
        res.json({
            success: true,
            image: result.image,
            targetSize: result.targetSize,
            remaining: stats.dailyLimit - stats.todayCount,
            model: model
        });
        
    } catch (error) {
        console.error('❌ 生成错误:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 ===== 天才新星已启动 =====`);
    console.log(`📡 http://localhost:${PORT}`);
    console.log(`🔑 使用统一 n1n.ai API Key`);
    console.log(`🤖 可用模型:`);
    console.log(`   - ${MODELS.gemini.name}: ${MODELS.gemini.description}`);
    console.log(`   - ${MODELS.midjourney.name}: ${MODELS.midjourney.description}`);
    console.log(`================================\n`);
});