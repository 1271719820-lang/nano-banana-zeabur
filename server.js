const express = require('express');
const multer = require('multer');
const cors = require('cors');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== 配置 n1n.ai API =====
const GEMINI_API_KEY = "sk-wEEKTNnWkyfcHNeLbEv1zLuiSk6vivrbQGRYAh7nZmksJ6Sy";
const API_URL = "https://api.n1n.ai/v1/chat/completions";
const MODEL = "gemini-2.5-flash-image";

// ===== 密码配置 =====
// 格式: { "密码": { dailyLimit: 次数, name: "用户名称" } }
const PASSWORDS = {
    "xinxing10": { dailyLimit: 20, name: "试用用户" },
    "708-20vip": { dailyLimit: 30, name: "VIP会员" },
    "Xinxing50vip": { dailyLimit: 50, name: "VIP会员" },
    "xinxinggeniussvip": { dailyLimit: 100, name: "SVIP会员" },
    "xingyuesvip": { dailyLimit: 200, name: "SVIP会员" },
    "xinrui888": { dailyLimit: 500, name: "管理员" }
};

// ===== 统计数据存储 =====
const STATS_FILE = path.join(__dirname, 'stats.json');

// 加载统计数据
let userStats = {};

function loadStats() {
    try {
        if (fs.existsSync(STATS_FILE)) {
            const data = fs.readFileSync(STATS_FILE, 'utf8');
            userStats = JSON.parse(data);
            console.log('📊 加载用户统计成功');
            
            // 检查是否需要重置每日计数
            const today = new Date().toDateString();
            let resetCount = 0;
            
            for (const [password, stats] of Object.entries(userStats)) {
                if (stats.lastResetDate !== today) {
                    stats.todayCount = 0;
                    stats.lastResetDate = today;
                    resetCount++;
                }
            }
            
            if (resetCount > 0) {
                console.log(`📅 重置了 ${resetCount} 个用户的每日计数`);
                saveStats();
            }
        } else {
            console.log('📊 首次运行，初始化统计文件');
            saveStats();
        }
    } catch (error) {
        console.error('加载统计数据失败:', error);
        userStats = {};
    }
}

function saveStats() {
    try {
        fs.writeFileSync(STATS_FILE, JSON.stringify(userStats, null, 2));
    } catch (error) {
        console.error('保存统计数据失败:', error);
    }
}

// 初始化用户统计
function initUserStats(password) {
    if (!userStats[password]) {
        const passwordConfig = PASSWORDS[password];
        userStats[password] = {
            dailyLimit: passwordConfig.dailyLimit,
            name: passwordConfig.name,
            todayCount: 0,
            totalGenerated: 0,
            lastResetDate: new Date().toDateString(),
            history: []
        };
        saveStats();
    }
}

// 检查用户是否可以生成
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

// 记录生成
function recordGeneration(password, prompt, size, ratio, success) {
    const stats = userStats[password];
    if (!stats) return;
    
    stats.totalGenerated++;
    stats.todayCount++;
    
    stats.history.unshift({
        timestamp: new Date().toISOString(),
        prompt: prompt.substring(0, 100),
        size: size,
        ratio: ratio,
        success: success
    });
    
    if (stats.history.length > 50) {
        stats.history = stats.history.slice(0, 50);
    }
    
    saveStats();
    console.log(`📊 [${stats.name}] 今日已生成: ${stats.todayCount}/${stats.dailyLimit}`);
}

// 验证密码
function validatePassword(password) {
    return PASSWORDS[password] !== undefined;
}

console.log('🔧 ===== 天才新星 启动配置 =====');
console.log('🤖 模型:', MODEL);
console.log('🔐 已配置密码:');
for (const [pwd, config] of Object.entries(PASSWORDS)) {
    console.log(`   - ${config.name}: 密码 ${pwd} (每日 ${config.dailyLimit} 次)`);
}
console.log('================================');

loadStats();

// ===== 中间件配置 =====
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedTypes = ['image/jpeg', 'image/png', 'image/jpg', 'image/webp'];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('只支持 JPG、PNG、WEBP 格式'));
        }
    }
});

// ===== 分辨率映射 =====
const resolutionMap = {
    '1K': { maxDimension: 1024, label: '1K' },
    '2K': { maxDimension: 2048, label: '2K' },
    '4K': { maxDimension: 4096, label: '4K' }
};

const ratioMap = {
    '1:1': { width: 1, height: 1, name: '正方形' },
    '4:3': { width: 4, height: 3, name: '横版 4:3' },
    '3:4': { width: 3, height: 4, name: '竖版 3:4' },
    '16:9': { width: 16, height: 9, name: '宽屏 16:9' },
    '9:16': { width: 9, height: 16, name: '竖屏 9:16' },
    '3:2': { width: 3, height: 2, name: '横版 3:2' },
    '2:3': { width: 2, height: 3, name: '竖版 2:3' }
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
    
    if (width > maxDimension) width = maxDimension;
    if (height > maxDimension) height = maxDimension;
    
    return { 
        width, 
        height, 
        label: `${width}x${height}`,
        ratioName: ratioConfig.name
    };
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
            .resize(targetWidth, targetHeight, {
                fit: 'cover',
                position: 'center',
                kernel: 'lanczos3'
            })
            .toFormat(mimeType === 'jpg' ? 'jpeg' : mimeType, {
                quality: 95
            })
            .toBuffer();
        
        const resizedBase64 = resizedBuffer.toString('base64');
        return `data:image/${mimeType};base64,${resizedBase64}`;
    } catch (error) {
        console.error('图片缩放失败:', error);
        return imageBase64;
    }
}

function enhancePromptWithSettings(originalPrompt, size, ratio, targetSize) {
    let cleanPrompt = originalPrompt;
    cleanPrompt = cleanPrompt.replace(/[,，]?\s*比例:\s*[0-9:]+\s*$/, '');
    cleanPrompt = cleanPrompt.replace(/[,，]?\s*画质:\s*\w+\s*$/, '');
    
    const sizeMap = { '1K': '标准清晰度', '2K': '高清', '4K': '超高清 4K' };
    
    return `${cleanPrompt}

【构图要求】
- 画面比例：${targetSize.ratioName} (${ratio})
- 画质风格：${sizeMap[size] || size}，细节丰富
- 最终输出分辨率：${targetSize.label}

请按照以上比例和画质要求生成图片。`;
}

// ===== API 路由 =====

app.get('/health', (req, res) => {
    res.json({ status: 'ok', api: 'n1n.ai', model: MODEL });
});

// 验证密码
app.post('/api/login', (req, res) => {
    const { password } = req.body;
    
    if (!password) {
        return res.status(400).json({ success: false, error: '请输入密码' });
    }
    
    if (validatePassword(password)) {
        initUserStats(password);
        const stats = userStats[password];
        res.json({
            success: true,
            name: stats.name,
            dailyLimit: stats.dailyLimit,
            todayCount: stats.todayCount,
            remaining: stats.dailyLimit - stats.todayCount,
            message: `欢迎 ${stats.name}！今日剩余 ${stats.dailyLimit - stats.todayCount} 次生成机会`
        });
    } else {
        res.status(401).json({ success: false, error: '密码错误，请重试' });
    }
});

// 获取用户统计
app.get('/api/stats', (req, res) => {
    const password = req.headers['x-password'];
    
    if (!password || !userStats[password]) {
        return res.status(401).json({ success: false, error: '未登录或会话已过期' });
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

// 生成图片
app.post('/api/generate', upload.array('images', 3), async (req, res) => {
    try {
        const password = req.headers['x-password'];
        
        if (!password || !userStats[password]) {
            return res.status(401).json({ success: false, error: '请先登录' });
        }
        
        if (!canGenerate(password)) {
            const stats = userStats[password];
            return res.status(429).json({
                success: false,
                error: `今日生成次数已达上限 (${stats.dailyLimit}次/天)，请明天再试`,
                remaining: 0
            });
        }
        
        let prompt = req.body.prompt;
        let size = req.body.size || '2K';
        let ratio = req.body.ratio || '1:1';
        const images = req.files;
        const targetSize = calculateTargetSize(size, ratio);
        
        console.log(`\n📥 [${userStats[password].name}] 收到生成请求`);
        console.log('提示词:', prompt);
        console.log('画质:', size, '比例:', ratio);
        console.log('目标尺寸:', targetSize.label);
        
        if (!prompt) {
            return res.status(400).json({ success: false, error: '请输入提示词' });
        }
        
        const enhancedPrompt = enhancePromptWithSettings(prompt, size, ratio, targetSize);
        const content = [{ type: "text", text: enhancedPrompt }];
        
        if (images && images.length > 0) {
            for (let i = 0; i < images.length; i++) {
                const image = images[i];
                const base64 = image.buffer.toString('base64');
                content.push({
                    type: "image_url",
                    image_url: { url: `data:${image.mimetype};base64,${base64}` }
                });
            }
        }
        
        const requestBody = {
            model: MODEL,
            messages: [{ role: "user", content: content }],
            max_tokens: 4096,
            temperature: 0.7
        };
        
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${GEMINI_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            recordGeneration(password, prompt, size, ratio, false);
            throw new Error(data.error?.message || 'API 请求失败');
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
            recordGeneration(password, prompt, size, ratio, false);
            return res.json({ success: true, text: textResponse || messageContent, image: null });
        }
        
        const resizedImage = await resizeImage(imageUrl, targetSize.width, targetSize.height);
        recordGeneration(password, prompt, size, ratio, true);
        
        const stats = userStats[password];
        res.json({
            success: true,
            image: resizedImage,
            text: textResponse,
            targetSize: targetSize.label,
            remaining: stats.dailyLimit - stats.todayCount
        });
        
    } catch (error) {
        console.error('❌ 生成错误:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log('\n🚀 ===== 天才新星 已启动 =====');
    console.log(`📡 http://localhost:${PORT}`);
    console.log('================================\n');
});