const express = require('express');
const multer = require('multer');
const cors = require('cors');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== 配置 n1n.ai API =====
const N1N_API_KEY = "sk-wEEKTNnWkyfcHNeLbEv1zLuiSk6vivrbQGRYAh7nZmksJ6Sy";
const N1N_API_URL = "https://api.n1n.ai/v1/chat/completions";
const N1N_UPSCALE_URL = "https://api.n1n.ai/v1/images/upscale";  // 超分 API（如果存在）

// ===== 支持的模型列表 =====
const SUPPORTED_MODELS = {
    // NanoBanana Pro - 专门图像生成
    'nano-banana-pro': {
        name: 'NanoBanana Pro',
        type: 'image',
        description: '专门图像生成模型，4K超清，细节丰富',
        price: '$0.248/次',
        recommended: true
    },
    // Gemini 3 系列
    'gemini-3.1-flash-image': {
        name: 'Gemini 3.1 Flash Image',
        type: 'image',
        description: '最具成本效益的多模态模型，支持图像生成',
        price: '$0.248/次'
    },
    'gemini-3-pro-image': {
        name: 'Gemini 3 Pro Image',
        type: 'image',
        description: 'Google最智能的图像模型，4K超清',
        price: '$0.495/次'
    },
    // Gemini 2.5 系列
    'gemini-2.5-flash-image': {
        name: 'Gemini 2.5 Flash Image',
        type: 'image',
        description: '标准图像生成模型，支持多图融合',
        price: '$0.225/次'
    },
    // 文本模型（可选）
    'gemini-3.1-flash': {
        name: 'Gemini 3.1 Flash',
        type: 'text',
        description: '文本对话模型',
        price: '$0.375/M'
    },
    'gemini-3-pro': {
        name: 'Gemini 3 Pro',
        type: 'text',
        description: '最强推理模型',
        price: '$3.00/M'
    }
};

// 默认使用的图像模型
const DEFAULT_IMAGE_MODEL = 'nano-banana-pro';  // 使用专门的图像模型

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
    res.json({ 
        status: 'ok', 
        default_model: DEFAULT_IMAGE_MODEL,
        supported_models: Object.keys(SUPPORTED_MODELS)
    });
});

// 获取可用模型列表
app.get('/api/models', (req, res) => {
    const imageModels = Object.entries(SUPPORTED_MODELS)
        .filter(([_, info]) => info.type === 'image')
        .map(([id, info]) => ({
            id: id,
            name: info.name,
            description: info.description,
            price: info.price,
            recommended: info.recommended || false
        }));
    
    res.json({
        success: true,
        default: DEFAULT_IMAGE_MODEL,
        models: imageModels
    });
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
    '1K': { maxDimension: 1024, label: '1024x1024', quality: 92 },
    '2K': { maxDimension: 2048, label: '2048x2048', quality: 95 },
    '4K': { maxDimension: 4096, label: '4096x4096', quality: 98 }
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

// ===== 尝试调用超分 API =====
async function tryUpscale(imageBase64, targetScale = 2) {
    try {
        console.log(`   🔍 尝试调用超分 API (scale: ${targetScale}x)...`);
        
        // 提取纯 base64 数据
        let pureBase64 = imageBase64;
        if (imageBase64.startsWith('data:image')) {
            pureBase64 = imageBase64.split(',')[1];
        }
        
        const response = await fetch(N1N_UPSCALE_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${N1N_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                image: pureBase64,
                scale: targetScale,
                model: "real-esrgan"  // 尝试多种超分模型
            })
        });
        
        if (response.ok) {
            const data = await response.json();
            console.log(`   ✅ 超分 API 调用成功！`);
            return data.image || data.data?.url || data.output;
        } else {
            const errorText = await response.text();
            console.log(`   ⚠️ 超分 API 不可用 (${response.status}): ${errorText.substring(0, 100)}`);
            return null;
        }
    } catch (error) {
        console.log(`   ⚠️ 超分 API 调用失败: ${error.message}`);
        return null;
    }
}

// ===== 增强版 4K 缩放函数（多级锐化+对比度优化）=====
async function resizeTo4KWithEnhancement(imageBase64, targetWidth, targetHeight, useUpscale = true) {
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
        
        // 先尝试超分 API
        if (useUpscale && targetWidth >= 3000) {
            const scale = Math.floor(targetWidth / 1024);
            const upscaled = await tryUpscale(imageBase64, Math.min(scale, 4));
            if (upscaled) {
                console.log(`   ✅ 使用超分 API 增强画质`);
                // 如果超分成功，使用超分后的图片继续处理
                imageBase64 = upscaled;
                base64Data = imageBase64.split(',')[1] || imageBase64;
            }
        }
        
        const imageBuffer = Buffer.from(base64Data, 'base64');
        const metadata = await sharp(imageBuffer).metadata();
        
        console.log(`   原图尺寸: ${metadata.width}x${metadata.height}`);
        console.log(`   🔥 启用 4K 超采样增强模式`);
        
        // 步骤1: 使用 lanczos3 高质量放大
        let processed = await sharp(imageBuffer)
            .resize(targetWidth, targetHeight, {
                fit: 'fill',
                kernel: 'lanczos3',
                withoutEnlargement: false
            })
            .toBuffer();
        
        // 步骤2: 第一级锐化 - 增强边缘
        processed = await sharp(processed)
            .sharpen({
                sigma: 1.5,
                m1: 1.2,
                m2: 0.8
            })
            .toBuffer();
        
        // 步骤3: 轻微增加对比度和饱和度
        processed = await sharp(processed)
            .modulate({
                brightness: 1.02,
                saturation: 1.08,
                hue: 0
            })
            .toBuffer();
        
        // 步骤4: 第二级锐化 - 细节增强
        processed = await sharp(processed)
            .sharpen({
                sigma: 0.8,
                m1: 0.6,
                m2: 0.4
            })
            .toBuffer();
        
        // 步骤5: 输出格式优化
        const outputFormat = mimeType === 'jpg' || mimeType === 'jpeg' ? 'jpeg' : 'png';
        const finalBuffer = await sharp(processed)
            .toFormat(outputFormat, {
                quality: 98,
                compressionLevel: 9,
                effort: 10,
                progressive: true
            })
            .toBuffer();
        
        console.log(`   ✅ 4K 增强完成: ${targetWidth}x${targetHeight}`);
        
        return `data:image/${outputFormat};base64,${finalBuffer.toString('base64')}`;
        
    } catch (error) {
        console.error('4K 增强失败:', error);
        return imageBase64;
    }
}

// ===== 标准图片缩放函数 =====
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
        
        const resizedBuffer = await sharp(imageBuffer)
            .resize(targetWidth, targetHeight, {
                fit: 'fill',
                kernel: 'lanczos3',
                withoutEnlargement: false
            })
            .sharpen()
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

// ===== 增强版提示词 =====
function getEnhancedPrompt(prompt, size, targetSize, ratio, modelId) {
    const modelInfo = SUPPORTED_MODELS[modelId] || SUPPORTED_MODELS[DEFAULT_IMAGE_MODEL];
    
    if (size === '4K') {
        return `${prompt}

【4K 超高清生成要求】
- 使用模型：${modelInfo.name}
- 输出分辨率：${targetSize.label} 超高清 (4096x4096 级别)
- 画质要求：极致细节，8K 级别清晰度，每个像素都清晰可见
- 纹理要求：极其细腻，边缘锐利无锯齿，毛发、材质细节完美呈现
- 光影要求：自然真实，层次丰富，高光阴影过渡平滑自然
- 色彩要求：鲜艳饱满，色彩准确，过渡平滑，无断层
- 构图要求：${targetSize.ratioName} 完美构图，画面平衡

请生成一张真正的 4K 超高清图片，确保放大到 100% 时细节依然清晰锐利。`;
    } else if (size === '2K') {
        return `${prompt}

【高清生成要求】
- 使用模型：${modelInfo.name}
- 画面比例：${targetSize.ratioName} (${ratio})
- 画质要求：高清画质，细节丰富
- 分辨率：${targetSize.label}
- 细节要求：纹理清晰，边缘锐利

请生成一张高清图片。`;
    } else {
        return `${prompt}

【生成要求】
- 使用模型：${modelInfo.name}
- 画面比例：${targetSize.ratioName} (${ratio})
- 画质要求：标准清晰度
- 分辨率：${targetSize.label}

请生成一张图片。`;
    }
}

// ===== Gemini/NanoBanana 生成函数 =====
async function generateWithModel(prompt, size, ratio, images, modelId) {
    const targetSize = calculateTargetSize(size, ratio);
    const sizeConfig = resolutionMap[size] || resolutionMap['2K'];
    const modelInfo = SUPPORTED_MODELS[modelId] || SUPPORTED_MODELS[DEFAULT_IMAGE_MODEL];
    
    // 使用增强版提示词
    const enhancedPrompt = getEnhancedPrompt(prompt, size, targetSize, ratio, modelId);
    
    const content = [{ type: "text", text: enhancedPrompt }];
    
    if (images && images.length > 0) {
        console.log(`📷 添加 ${images.length} 张参考图`);
        for (const image of images) {
            const base64 = image.buffer.toString('base64');
            const mimeType = image.mimetype;
            content.push({
                type: "image_url",
                image_url: { url: `data:${mimeType};base64,${base64}` }
            });
        }
    }
    
    console.log(`📤 调用 ${modelInfo.name} 生成图片...`);
    console.log(`   模型 ID: ${modelId}`);
    console.log(`   画质: ${size === '4K' ? '4K 超高清' : size === '2K' ? '高清' : '标准'}`);
    console.log(`   目标尺寸: ${targetSize.label}`);
    console.log(`   参考图数量: ${images?.length || 0}`);
    
    const response = await fetch(N1N_API_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${N1N_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: modelId,
            messages: [{ role: "user", content }],
            max_tokens: 4096,
            temperature: 0.7
        })
    });
    
    const data = await response.json();
    
    if (!response.ok) {
        console.error('❌ API 错误:', data);
        throw new Error(data.error?.message || `${modelInfo.name} API 请求失败`);
    }
    
    const messageContent = data.choices[0].message.content;
    let imageUrl = null;
    let textResponse = null;
    
    if (typeof messageContent === 'string') {
        const imgMatch = messageContent.match(/!\[.*?\]\((.*?)\)/);
        if (imgMatch) {
            imageUrl = imgMatch[1];
            textResponse = messageContent.replace(/!\[.*?\]\(.*?\)/g, '').trim();
        } else {
            const base64Match = messageContent.match(/data:image\/[^;]+;base64,[^"]+/);
            if (base64Match) {
                imageUrl = base64Match[0];
                textResponse = messageContent.replace(base64Match[0], '').trim();
            } else {
                textResponse = messageContent;
            }
        }
    }
    
    if (!imageUrl) {
        if (textResponse) {
            console.log(`⚠️ 模型返回了文本: ${textResponse.substring(0, 100)}`);
            throw new Error(`模型返回了文本而非图片: ${textResponse.substring(0, 100)}`);
        }
        throw new Error(`${modelInfo.name} 未返回图片`);
    }
    
    console.log(`🖼️ 图片获取成功，开始处理...`);
    
    // 根据画质选择不同的缩放处理
    let resizedImage;
    if (size === '4K') {
        // 4K 使用增强版缩放（尝试超分 API）
        resizedImage = await resizeTo4KWithEnhancement(imageUrl, targetSize.width, targetSize.height, true);
    } else {
        // 2K 和 1K 使用标准缩放
        resizedImage = await resizeImageWithQuality(imageUrl, targetSize.width, targetSize.height, sizeConfig.quality);
    }
    
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
        
        const { prompt, size = '2K', ratio = '1:1', model = DEFAULT_IMAGE_MODEL } = req.body;
        const images = req.files;
        
        if (!prompt) {
            return res.status(400).json({ success: false, error: '请输入提示词' });
        }
        
        // 验证模型是否支持
        if (!SUPPORTED_MODELS[model] || SUPPORTED_MODELS[model].type !== 'image') {
            console.log(`⚠️ 模型 ${model} 不可用，使用默认模型 ${DEFAULT_IMAGE_MODEL}`);
            model = DEFAULT_IMAGE_MODEL;
        }
        
        console.log(`\n📥 ===== 生成请求 =====`);
        console.log(`用户: ${userStats[password].name}`);
        console.log(`模型: ${SUPPORTED_MODELS[model].name}`);
        console.log(`提示词: ${prompt}`);
        console.log(`画质: ${size}, 比例: ${ratio}`);
        console.log(`参考图数量: ${images?.length || 0}`);
        console.log(`今日剩余: ${userStats[password].dailyLimit - userStats[password].todayCount}/${userStats[password].dailyLimit}`);
        
        const result = await generateWithModel(prompt, size, ratio, images, model);
        
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
    console.log(`🤖 默认模型: ${SUPPORTED_MODELS[DEFAULT_IMAGE_MODEL].name}`);
    console.log(`🎨 可用图像模型:`);
    Object.entries(SUPPORTED_MODELS)
        .filter(([_, info]) => info.type === 'image')
        .forEach(([id, info]) => {
            console.log(`   - ${info.name} (${id}): ${info.description}`);
        });
    console.log(`🔍 超分 API: ${N1N_UPSCALE_URL}`);
    console.log(`================================\n`);
});