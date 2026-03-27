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
const GEMINI_MODEL = "gemini-2.5-flash-image";

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

function recordGeneration(password, prompt, size, ratio, success) {
    const stats = userStats[password];
    if (!stats) return;
    stats.totalGenerated++;
    stats.todayCount++;
    stats.history.unshift({
        timestamp: new Date().toISOString(),
        prompt: prompt.substring(0, 100),
        size, ratio, success
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
    res.json({ status: 'ok', model: GEMINI_MODEL });
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

// ===== Gemini 生成函数 =====
async function generateWithGemini(prompt, size, ratio, images) {
    const targetSize = calculateTargetSize(size, ratio);
    const sizeConfig = resolutionMap[size] || resolutionMap['2K'];
    
    const enhancedPrompt = `${prompt}

【技术要求】
- 画面比例：${targetSize.ratioName} (${ratio})
- 画质：${size === '4K' ? '超高清4K' : size === '2K' ? '高清' : '标准'}
- 分辨率：${targetSize.label}
- 细节要求：${size === '4K' ? '4K超高清级别，纹理极其清晰' : '高清级别，细节丰富'}

请直接生成图片。`;
    
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
    
    console.log(`📤 调用 Gemini 生成图片...`);
    console.log(`   参考图数量: ${images?.length || 0}`);
    console.log(`   目标尺寸: ${targetSize.label}`);
    
    const response = await fetch(N1N_API_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${N1N_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: GEMINI_MODEL,
            messages: [{ role: "user", content }],
            max_tokens: 4096,
            temperature: 0.7
        })
    });
    
    const data = await response.json();
    
    if (!response.ok) {
        console.error('❌ API 错误:', data);
        throw new Error(data.error?.message || 'Gemini API 请求失败');
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
            throw new Error(`Gemini 返回了文本: ${textResponse.substring(0, 100)}`);
        }
        throw new Error('Gemini 未返回图片');
    }
    
    const resizedImage = await resizeImageWithQuality(imageUrl, targetSize.width, targetSize.height, sizeConfig.quality);
    
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
        
        const { prompt, size = '2K', ratio = '1:1' } = req.body;
        const images = req.files;
        
        if (!prompt) {
            return res.status(400).json({ success: false, error: '请输入提示词' });
        }
        
        console.log(`\n📥 ===== 生成请求 =====`);
        console.log(`提示词: ${prompt}`);
        console.log(`画质: ${size}, 比例: ${ratio}`);
        console.log(`参考图数量: ${images?.length || 0}`);
        
        const result = await generateWithGemini(prompt, size, ratio, images);
        
        recordGeneration(password, prompt, size, ratio, true);
        const stats = userStats[password];
        
        console.log(`✅ 生成成功！剩余次数: ${stats.dailyLimit - stats.todayCount}`);
        
        res.json({
            success: true,
            image: result.image,
            targetSize: result.targetSize,
            remaining: stats.dailyLimit - stats.todayCount
        });
        
    } catch (error) {
        console.error('❌ 生成错误:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 ===== 天才新星已启动 =====`);
    console.log(`📡 http://localhost:${PORT}`);
    console.log(`🤖 模型: ${GEMINI_MODEL}`);
    console.log(`================================\n`);
});