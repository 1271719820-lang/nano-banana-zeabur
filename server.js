const express = require('express');
const multer = require('multer');
const cors = require('cors');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const app = express();

// ===== 端口配置 - 适配 Zeabur =====
const PORT = process.env.PORT || 3000;  // Zeabur 会自动注入 PORT 环境变量

// ===== 配置 n1n.ai API =====
const GEMINI_API_KEY = "sk-wEEKTNnWkyfcHNeLbEv1zLuiSk6vivrbQGRYAh7nZmksJ6Sy";
const API_URL = "https://api.n1n.ai/v1/chat/completions";
const MODEL = "gemini-2.5-flash-image";

// ===== 每日次数限制配置 =====
const DAILY_LIMIT = 200;
// 注意：Zeabur 上的文件系统是临时的，重启会丢失数据
// 建议后续改用数据库存储，这里先用文件存储作为演示
const STATS_FILE = path.join(__dirname, 'stats.json');

// ===== 统计数据管理 =====
let stats = {
    totalGenerated: 0,
    todayCount: 0,
    lastResetDate: new Date().toDateString(),
    history: []
};

// 加载统计数据
function loadStats() {
    try {
        if (fs.existsSync(STATS_FILE)) {
            const data = fs.readFileSync(STATS_FILE, 'utf8');
            const savedStats = JSON.parse(data);
            stats = savedStats;
            
            const today = new Date().toDateString();
            if (stats.lastResetDate !== today) {
                console.log(`📅 新的一天，重置今日计数 (昨日: ${stats.todayCount} 次)`);
                stats.todayCount = 0;
                stats.lastResetDate = today;
                saveStats();
            }
            
            console.log(`📊 加载统计: 今日已生成 ${stats.todayCount}/${DAILY_LIMIT} 次`);
        } else {
            console.log('📊 首次运行，初始化统计文件');
            saveStats();
        }
    } catch (error) {
        console.error('加载统计数据失败:', error);
        // 如果加载失败，使用默认值
        stats = {
            totalGenerated: 0,
            todayCount: 0,
            lastResetDate: new Date().toDateString(),
            history: []
        };
    }
}

// 保存统计数据
function saveStats() {
    try {
        fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
        console.log(`💾 统计数据已保存，今日已生成: ${stats.todayCount}/${DAILY_LIMIT}`);
    } catch (error) {
        console.error('保存统计数据失败:', error);
    }
}

// 检查是否可以生成
function canGenerate() {
    const today = new Date().toDateString();
    
    if (stats.lastResetDate !== today) {
        console.log(`📅 新的一天，重置今日计数 (昨日: ${stats.todayCount} 次)`);
        stats.todayCount = 0;
        stats.lastResetDate = today;
        saveStats();
    }
    
    return stats.todayCount < DAILY_LIMIT;
}

// 记录一次生成
function recordGeneration(prompt, size, ratio, success) {
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
    
    console.log(`📊 今日已生成: ${stats.todayCount}/${DAILY_LIMIT} 次`);
}

console.log('🔧 ===== 天才新星 启动配置 =====');
console.log('🤖 模型:', MODEL);
console.log(`📊 每日次数限制: ${DAILY_LIMIT} 次/天`);
console.log(`📁 统计文件路径: ${STATS_FILE}`);
console.log('================================');

// 加载统计数据
loadStats();

// ===== 中间件配置 =====
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// 配置 multer
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

// ===== 比例映射 =====
const ratioMap = {
    '1:1': { width: 1, height: 1, name: '正方形' },
    '4:3': { width: 4, height: 3, name: '横版 4:3' },
    '3:4': { width: 3, height: 4, name: '竖版 3:4' },
    '16:9': { width: 16, height: 9, name: '宽屏 16:9' },
    '9:16': { width: 9, height: 16, name: '竖屏 9:16' },
    '3:2': { width: 3, height: 2, name: '横版 3:2' },
    '2:3': { width: 2, height: 3, name: '竖版 2:3' }
};

// ===== 根据尺寸和比例计算目标尺寸 =====
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
        aspectRatio: aspectRatio,
        ratioName: ratioConfig.name
    };
}

// ===== 缩放图片函数 =====
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
        const metadata = await sharp(imageBuffer).metadata();
        console.log(`   原图尺寸: ${metadata.width}x${metadata.height}`);
        
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
        console.log(`   缩放后尺寸: ${targetWidth}x${targetHeight}`);
        
        return `data:image/${mimeType};base64,${resizedBase64}`;
        
    } catch (error) {
        console.error('图片缩放失败:', error);
        return imageBase64;
    }
}

// ===== 生成提示词 =====
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

// 健康检查 - 用于 Zeabur 监控
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        api: 'n1n.ai', 
        model: MODEL,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

// 根路径 - 返回前端页面
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 获取统计数据
app.get('/api/stats', (req, res) => {
    const today = new Date().toDateString();
    if (stats.lastResetDate !== today) {
        stats.todayCount = 0;
        stats.lastResetDate = today;
        saveStats();
    }
    
    res.json({
        todayCount: stats.todayCount,
        dailyLimit: DAILY_LIMIT,
        remaining: Math.max(0, DAILY_LIMIT - stats.todayCount),
        totalGenerated: stats.totalGenerated,
        history: stats.history.slice(0, 20)
    });
});

// 生成图片
app.post('/api/generate', upload.array('images', 3), async (req, res) => {
    try {
        // 检查每日次数限制
        if (!canGenerate()) {
            return res.status(429).json({
                success: false,
                error: `今日生成次数已达上限 (${DAILY_LIMIT}次/天)，请明天再试`,
                remaining: 0,
                limit: DAILY_LIMIT,
                todayCount: stats.todayCount
            });
        }
        
        let prompt = req.body.prompt;
        let size = req.body.size || '2K';
        let ratio = req.body.ratio || '1:1';
        let model = req.body.model || MODEL;
        const images = req.files;
        
        const targetSize = calculateTargetSize(size, ratio);
        
        console.log('\n📥 ===== 收到生成请求 =====');
        console.log('原始提示词:', prompt);
        console.log('画质要求:', size);
        console.log('画面比例:', ratio);
        console.log('目标尺寸:', targetSize.label, `(${targetSize.ratioName})`);
        console.log('参考图数量:', images?.length || 0);
        console.log(`📊 今日剩余次数: ${DAILY_LIMIT - stats.todayCount - 1}/${DAILY_LIMIT}`);
        
        if (!prompt) {
            return res.status(400).json({ 
                success: false, 
                error: '请输入提示词' 
            });
        }
        
        const enhancedPrompt = enhancePromptWithSettings(prompt, size, ratio, targetSize);
        
        const content = [];
        content.push({ type: "text", text: enhancedPrompt });
        
        if (images && images.length > 0) {
            console.log(`📷 处理 ${images.length} 张参考图...`);
            for (let i = 0; i < images.length; i++) {
                const image = images[i];
                const base64 = image.buffer.toString('base64');
                content.push({
                    type: "image_url",
                    image_url: { url: `data:${image.mimetype};base64,${base64}` }
                });
                console.log(`  - 图片 ${i + 1}: ${image.mimetype}, ${(image.buffer.length / 1024).toFixed(2)}KB`);
            }
        }
        
        const requestBody = {
            model: MODEL,
            messages: [{ role: "user", content: content }],
            max_tokens: 4096,
            temperature: 0.7
        };
        
        console.log('📤 发送请求到 n1n.ai API...');
        
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
            console.error('❌ API 错误:', data);
            recordGeneration(prompt, size, ratio, false);
            throw new Error(data.error?.message || 'API 请求失败');
        }
        
        console.log('✅ API 响应成功');
        
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
            console.log('ℹ️ 模型返回了文本响应');
            recordGeneration(prompt, size, ratio, false);
            return res.json({
                success: true,
                text: textResponse || messageContent,
                image: null,
                requestedSize: targetSize.label
            });
        }
        
        console.log(`🖼️ 开始缩放图片到 ${targetSize.label}...`);
        const resizedImage = await resizeImage(imageUrl, targetSize.width, targetSize.height);
        console.log(`✅ 图片缩放完成！`);
        
        recordGeneration(prompt, size, ratio, true);
        
        res.json({
            success: true,
            image: resizedImage,
            text: textResponse,
            targetSize: targetSize.label,
            size: size,
            ratio: ratio,
            remaining: DAILY_LIMIT - stats.todayCount
        });
        
    } catch (error) {
        console.error('❌ 生成错误:', error.message);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.get('/api/config', (req, res) => {
    res.json({
        api: 'n1n.ai',
        model: MODEL,
        keyConfigured: true,
        dailyLimit: DAILY_LIMIT
    });
});

// ===== 启动服务器 =====
app.listen(PORT, '0.0.0.0', () => {
    console.log('\n🚀 ===== 天才新星 已启动 =====');
    console.log(`📡 本地地址: http://localhost:${PORT}`);
    console.log(`🌐 外部地址: http://0.0.0.0:${PORT}`);
    console.log(`🤖 模型: ${MODEL}`);
    console.log(`📊 每日限制: ${DAILY_LIMIT} 次/天`);
    console.log(`📁 统计文件: ${STATS_FILE}`);
    console.log('====================================\n');
});