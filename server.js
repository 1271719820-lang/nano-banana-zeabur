const express = require('express');
const multer = require('multer');
const cors = require('cors');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8080;

// 存储任务（内存，重启丢失，适合测试）
const tasks = new Map();

// 长连接设置
app.use((req, res, next) => {
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Keep-Alive', 'timeout=600');
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    next();
});

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 服务启动成功 - 端口: ${PORT}`);
});
server.timeout = 180000;
server.keepAliveTimeout = 180000;

// ==============================================
// GRSAI 配置
// ==============================================
const PROVIDER = {
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
            for (const img of images) {
                const base64 = img.buffer.toString('base64');
                urls.push(`data:${img.mimetype};base64,${base64}`);
            }
            body.urls = urls;
        }
        return body;
    },
    parseResponse: (data) => {
        if (data.results && Array.isArray(data.results) && data.results[0]) {
            return data.results[0].url || data.results[0];
        }
        if (data.data?.results?.[0]) {
            return data.data.results[0].url || data.data.results[0];
        }
        if (data.output && Array.isArray(data.output) && data.output[0]) {
            return data.output[0];
        }
        if (data.url) return data.url;
        if (data.image) return data.image;
        return null;
    },
    isSuccess: (data) => !data.error && !data.msg?.includes('fail') && data.status !== 'failed',
    getErrorMsg: (data) => data.msg || data.error || '未知错误'
};

// ==============================================
// 模型 & 用户配置
// ==============================================
const MODELS = {
    'nano-banana-fast': { name: 'Fast', pricing: { '1K': 4, '2K': 5, '4K': 6 }, supportImg: true },
    'nano-banana-pro': { name: 'Pro', pricing: { '1K': 6, '2K': 8, '4K': 12 }, supportImg: true },
    'nano-banana-2': { name: '2', pricing: { '1K': 4, '2K': 6, '4K': 10 }, supportImg: true }
};

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
function loadUsers() { try { if (fs.existsSync(USERS_FILE)) users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch (e) { } }
function saveUsers() { try { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); } catch (e) { } }
function initUser(pwd) {
    if (!users[pwd]) {
        const c = PASSWORDS[pwd];
        if (!c) return false;
        users[pwd] = { credits: c.credits, name: c.name, totalGenerated: 0, history: [] };
        saveUsers();
    }
    return true;
}
function deductCredits(pwd, cost) {
    if (!users[pwd] || users[pwd].credits < cost) return false;
    users[pwd].credits -= cost;
    saveUsers();
    return true;
}
loadUsers();

app.use(cors({ origin: true, credentials: true, maxAge: 86400 }));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use(express.static('public'));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ==============================================
// 分辨率映射与图片处理
// ==============================================
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

async function processImage(imageUrl, targetWidth, targetHeight, quality, size) {
    if (size === '4K') {
        console.log(`4K 画质：直接返回原始图片 URL，不进行缩放`);
        return imageUrl;
    }

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);
        const imgResponse = await fetch(imageUrl, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!imgResponse.ok) throw new Error(`下载图片失败: ${imgResponse.status}`);
        const imgBuffer = await imgResponse.arrayBuffer();
        const metadata = await sharp(imgBuffer).metadata();
        const actualWidth = metadata.width;
        const actualHeight = metadata.height;

        console.log(`📐 实际图片尺寸: ${actualWidth}x${actualHeight}, 目标尺寸: ${targetWidth}x${targetHeight}`);

        if (actualWidth >= targetWidth && actualHeight >= targetHeight) {
            console.log(`✅ 图片尺寸已满足要求，直接使用原图`);
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
                compressionLevel: 9,
                effort: 10
            })
            .toBuffer();
        const resizedBase64 = processed.toString('base64');
        return `data:image/${mimeType === 'jpg' ? 'jpeg' : 'png'};base64,${resizedBase64}`;
    } catch (error) {
        console.error('图片处理失败:', error);
        return imageUrl;
    }
}

// ==============================================
// 图片增强函数（锐化+饱和+对比度）
// ==============================================
async function enhanceImage(imageUrl) {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);
        const imgResponse = await fetch(imageUrl, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!imgResponse.ok) throw new Error(`下载图片失败: ${imgResponse.status}`);
        const imgBuffer = await imgResponse.arrayBuffer();
        const metadata = await sharp(imgBuffer).metadata();
        const originalWidth = metadata.width;
        const originalHeight = metadata.height;

        // 增强：锐化 + 提高饱和度/对比度 + 高质量输出
        const enhanced = await sharp(imgBuffer)
            .sharpen({
                sigma: 1.5,
                m1: 1.2,
                m2: 0.6
            })
            .modulate({
                brightness: 1.05,
                saturation: 1.1,
                hue: 0
            })
            .toFormat('png', {
                quality: 98,
                compressionLevel: 9,
                effort: 10
            })
            .toBuffer();

        const enhancedBase64 = enhanced.toString('base64');
        console.log(`✅ 图片增强完成，原尺寸 ${originalWidth}x${originalHeight}`);
        return `data:image/png;base64,${enhancedBase64}`;
    } catch (error) {
        console.error('图片增强失败:', error);
        return imageUrl;
    }
}

// ==============================================
// 异步处理函数（生成）
// ==============================================
async function processGeneration(taskId, pwd, model, prompt, images, size, ratio) {
    try {
        const mappedModel = PROVIDER.modelMapping[model];
        if (!mappedModel) throw new Error('模型映射失败');

        const body = PROVIDER.buildRequestBody(mappedModel, prompt, images, size, ratio);

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 180000);
        const resp = await fetch(PROVIDER.apiUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${PROVIDER.apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body),
            signal: controller.signal
        });
        clearTimeout(timeout);

        const text = await resp.text();
        let data = null;
        const lines = text.split('\n');
        for (const line of lines) {
            if (line.startsWith('data: ')) {
                const jsonStr = line.substring(6).trim();
                if (jsonStr && jsonStr !== '[DONE]') {
                    try {
                        data = JSON.parse(jsonStr);
                        break;
                    } catch (e) {}
                }
            }
        }
        if (!data) {
            try {
                data = JSON.parse(text);
            } catch (e) {}
        }

        if (!data) throw new Error('无法解析响应');
        if (!PROVIDER.isSuccess(data)) throw new Error(PROVIDER.getErrorMsg(data));

        let imageUrl = PROVIDER.parseResponse(data);
        if (!imageUrl) throw new Error('未获取到图片URL');

        const targetSize = calculateTargetSize(size, ratio);
        const sizeConfig = resolutionMap[size] || resolutionMap['2K'];
        const finalImage = await processImage(imageUrl, targetSize.width, targetSize.height, sizeConfig.quality, size);

        tasks.set(taskId, {
            status: 'completed',
            image: finalImage,
            targetSize: targetSize.label
        });

        // 记录用户成功
        users[pwd].totalGenerated++;
        users[pwd].history.unshift({
            t: new Date().toISOString(),
            p: prompt.substring(0, 100),
            s: size,
            r: ratio,
            m: model,
            c: MODELS[model].pricing[size]
        });
        if (users[pwd].history.length > 50) users[pwd].history = users[pwd].history.slice(0, 50);
        saveUsers();

    } catch (error) {
        console.error(`任务 ${taskId} 失败:`, error.message);
        tasks.set(taskId, { status: 'failed', error: error.message });
    }
}

// ==============================================
// API 路由
// ==============================================
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (!PASSWORDS[password]) return res.status(401).json({ success: false, error: '密码错误' });
    initUser(password);
    const u = users[password];
    res.json({ success: true, name: u.name, credits: u.credits, totalGenerated: u.totalGenerated });
});

app.get('/api/stats', (req, res) => {
    const pwd = req.headers['x-password'];
    if (!pwd || !users[pwd]) return res.status(401).json({ success: false });
    const u = users[pwd];
    res.json({ success: true, name: u.name, credits: u.credits, totalGenerated: u.totalGenerated });
});

app.post('/api/generate', upload.array('images', 3), async (req, res) => {
    try {
        const pwd = req.headers['x-password'];
        if (!pwd || !users[pwd]) return res.status(401).json({ success: false, error: '请登录' });

        const { prompt, size = '2K', ratio = '1:1', model = 'nano-banana-fast' } = req.body;
        const imgs = req.files;

        if (!prompt) return res.status(400).json({ success: false, error: '请输入提示词' });
        if (!MODELS[model]) return res.status(400).json({ success: false, error: '模型不存在' });

        const cost = MODELS[model].pricing[size];
        if (users[pwd].credits < cost) return res.status(402).json({ success: false, error: `积分不足，需${cost}` });

        // 扣积分
        deductCredits(pwd, cost);

        const taskId = crypto.randomUUID();
        tasks.set(taskId, { status: 'pending' });

        // 异步处理
        processGeneration(taskId, pwd, model, prompt, imgs, size, ratio).catch(err => {
            console.error(`异步任务 ${taskId} 异常:`, err);
            tasks.set(taskId, { status: 'failed', error: err.message });
        });

        res.json({ success: true, taskId: taskId, credits: users[pwd].credits });

    } catch (e) {
        console.error('生成接口报错:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/result/:taskId', (req, res) => {
    const taskId = req.params.taskId;
    const task = tasks.get(taskId);
    if (!task) return res.status(404).json({ success: false, error: '任务不存在' });

    if (task.status === 'completed') {
        res.json({
            success: true,
            status: 'completed',
            image: task.image,
            targetSize: task.targetSize
        });
        tasks.delete(taskId); // 结果取走后删除任务
    } else if (task.status === 'failed') {
        res.json({ success: false, status: 'failed', error: task.error });
        tasks.delete(taskId);
    } else {
        res.json({ success: false, status: 'pending' });
    }
});

// ==============================================
// 图片增强接口（高清放大）
// ==============================================
app.post('/api/enhance', async (req, res) => {
    try {
        const pwd = req.headers['x-password'];
        if (!pwd || !users[pwd]) return res.status(401).json({ success: false, error: '请登录' });

        const { imageUrl } = req.body;
        if (!imageUrl) return res.status(400).json({ success: false, error: '缺少图片URL' });

        const cost = 5; // 固定消耗5积分
        if (users[pwd].credits < cost) {
            return res.status(402).json({ success: false, error: `积分不足，需要 ${cost} 积分，当前剩余 ${users[pwd].credits}` });
        }

        // 扣积分
        deductCredits(pwd, cost);

        // 执行增强
        const enhancedImage = await enhanceImage(imageUrl);

        // 记录历史（可选，这里不单独记录，但可以视为一次生成操作？我们作为单独记录方便用户）
        // 为了不混淆，不记录到总生成次数，只扣积分。
        // 但为了用户体验，可以提示增强成功。

        res.json({
            success: true,
            image: enhancedImage,
            credits: users[pwd].credits,
            message: '图片增强成功，消耗 5 积分'
        });

    } catch (error) {
        console.error('增强接口报错:', error.message);
        res.status(500).json({ success: false, error: '图片增强失败，请重试' });
    }
});

console.log('✅ 异步轮询版 + 图片增强服务已加载完成！');