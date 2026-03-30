const express = require('express');
const multer = require('multer');
const cors = require('cors');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== 配置 GRSAI API =====
const GRSAI_API_URL = "https://grsai.dakka.com.cn/v1/draw/nano-banana";
const GRSAI_RESULT_URL = "https://grsai.dakka.com.cn/v1/draw/result";
const GRSAI_API_KEY = "sk-a1c7ff1ce99f4e03a5aed5ddb82dce58";

// ===== 模型配置 =====
// ===== 模型配置 =====
const MODELS = {
    'nano-banana-fast': {
        name: 'Nano Banana Fast',
        modelId: 'nano-banana-fast',
        supportsImages: true,
        description: '快速生成',
        pricing: { '1K': 3, '2K': 4 },          // 仅支持 1K 和 2K
        supportedSizes: ['1K', '2K']
    },
    'nano-banana-2': {
        name: 'Nano Banana 2',
        modelId: 'nano-banana-2',
        supportsImages: true,
        description: '标准版',
        pricing: { '1K': 4, '2K': 6, '4K': 10 },
        supportedSizes: ['1K', '2K', '4K']
    },
    'nano-banana-pro': {
        name: 'Nano Banana Pro',
        modelId: 'nano-banana-pro',
        supportsImages: true,
        description: '专业版',
        pricing: { '1K': 6, '2K': 8, '4K': 12 },
        supportedSizes: ['1K', '2K', '4K']
    }
};

const DEFAULT_MODEL = 'nano-banana-fast';

// ===== 密码配置（初始积分不同）=====
const PASSWORDS = {
    "xinxing10": { credits: 600, name: "试用用户" },
    "708-20vip": { credits: 800, name: "708靓仔" },
    "Xinxing50vip": { credits: 1000, name: "VIP会员" },
    "xinxinggeniussvip": { credits: 3000, name: "SVIP会员" },
    "xingyuesvip": { credits: 5000, name: "星月SVIP" },
    "xinrui888": { credits: 5000, name: "管理员" }
};

// ===== 用户数据存储（积分）=====
const USERS_FILE = path.join(__dirname, 'users.json');
let users = {};   // { password: { credits, name, history: [] } }

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

function getUserCredits(password) {
    return users[password]?.credits || 0;
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
    res.json({ status: 'ok', api: 'grsai', models: Object.keys(MODELS) });
});

// 获取模型列表
app.get('/api/models', (req, res) => {
    const models = Object.entries(MODELS).map(([id, info]) => ({
        id,
        name: info.name,
        description: info.description,
        pricing: info.pricing || { '1K': info.price },
        supportedSizes: info.supportedSizes || ['1K', '2K', '4K']
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

// ===== 分辨率映射 =====
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

// ===== 图片缩放 =====
async function resizeImageIfNeeded(imageUrl, targetWidth, targetHeight, quality) {
    try {
        const imgResponse = await fetch(imageUrl);
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
        return imageUrl;
    }
}

// ===== 获取模型积分 =====
function getCost(modelId, size) {
    const model = MODELS[modelId];
    if (!model) return 999;
    if (model.supportedSizes && !model.supportedSizes.includes(size)) {
        throw new Error(`模型 ${model.name} 不支持 ${size} 画质`);
    }
    if (model.price) return model.price; // sora-image 固定价格
    return model.pricing[size];
}

// ===== 调用 GRSAI API =====
async function callGRSAI(modelId, prompt, images, ratio, size) {
    const targetSize = calculateTargetSize(size, ratio);
    const modelConfig = MODELS[modelId];
    
    const requestBody = {
        model: modelConfig.modelId,
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
        requestBody.urls = urls;
    }
    
    console.log(`📤 调用 GRSAI: ${modelConfig.name}`);
    console.log(`   请求体:`, JSON.stringify(requestBody).substring(0, 500));
    
    const response = await fetch(GRSAI_API_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${GRSAI_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
    });
    
    const rawText = await response.text();
    console.log(`📥 原始响应 (前500字符): ${rawText.substring(0, 500)}`);
    
    // 解析 SSE
    let finalData = null;
    const lines = rawText.split('\n');
    for (const line of lines) {
        if (line.startsWith('data: ')) {
            const jsonStr = line.substring(6).trim();
            if (jsonStr && jsonStr !== '[DONE]') {
                try { finalData = JSON.parse(jsonStr); } catch(e) {}
            }
        }
    }
    if (!finalData) {
        try { finalData = JSON.parse(rawText); } catch(e) {
            throw new Error(`无法解析响应: ${rawText.substring(0, 200)}`);
        }
    }
    
    if (!response.ok) throw new Error(finalData.msg || finalData.error || 'API 请求失败');
    if (finalData.code === -1) throw new Error(finalData.msg || '账户余额不足，请充值');
    if (finalData.status === 'failed') throw new Error(`生成失败: ${finalData.failure_reason || '未知错误'}`);
    
    console.log('✅ 解析后的 finalData:', JSON.stringify(finalData, null, 2));
    
    // 提取图片 URL
    let imageUrl = null;
    if (finalData.results && finalData.results[0]) imageUrl = finalData.results[0].url;
    else if (finalData.data?.results?.[0]) imageUrl = finalData.data.results[0].url;
    else if (finalData.url) imageUrl = finalData.url;
    else if (finalData.image) imageUrl = finalData.image;
    else if (finalData.output?.[0]) imageUrl = finalData.output[0];
    
    if (!imageUrl) throw new Error('未返回图片 URL');
    
    console.log(`🖼️ 获取到图片 URL: ${imageUrl.substring(0, 100)}...`);
    
    const sizeConfig = resolutionMap[size] || resolutionMap['2K'];
    const finalImage = await resizeImageIfNeeded(imageUrl, targetSize.width, targetSize.height, sizeConfig.quality);
    
    return { image: finalImage, targetSize: targetSize.label };
}

// ===== 生成图片主路由 =====
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
        
        // 计算所需积分
        let cost;
        try {
            cost = getCost(model, size);
        } catch (err) {
            return res.status(400).json({ success: false, error: err.message });
        }
        
        // 检查积分
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
        
        // 调用 API
        const result = await callGRSAI(model, prompt, images, ratio, size);
        
        // 记录历史
        recordGeneration(password, prompt, size, ratio, model, cost, true);
        
        res.json({
            success: true,
            image: result.image,
            targetSize: result.targetSize,
            credits: users[password].credits,
            model: model
        });
        
    } catch (error) {
        console.error('❌ 生成错误:', error.message);
        // 如果生成失败，应退还已扣积分（可选）
        // 这里为了简化，不退还（积分已扣）
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 ===== 天才新星 (积分版) 已启动 =====`);
    console.log(`📡 http://localhost:${PORT}`);
    console.log(`🤖 可用模型:`);
    Object.entries(MODELS).forEach(([id, info]) => {
        console.log(`   - ${info.name} (${id})`);
    });
    console.log(`🔐 已配置密码及初始积分:`);
    Object.entries(PASSWORDS).forEach(([pwd, config]) => {
        console.log(`   - ${config.name}: ${pwd} (${config.credits} 积分)`);
    });
    console.log(`================================\n`);
});