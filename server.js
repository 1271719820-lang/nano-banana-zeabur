const express = require('express');
const multer = require('multer');
const cors = require('cors');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ==============================================
// 🔥 全局任务队列（异步生成，彻底绕开超时）
// ==============================================
const taskMap = new Map();

// ==============================================
// 仅保留最稳定、最便宜的 GRSAI
// ==============================================
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
            if (data.results && Array.isArray(data.results) && data.results[0])
                return data.results[0].url || data.results[0];
            if (data.data?.results?.[0])
                return data.data.results[0].url || data.data.results[0];
            if (data.output?.[0]) return data.output[0];
            if (data.url) return data.url;
            if (data.image) return data.image;
            return null;
        },
        isSuccess: (data) => !data.error && !data.msg?.includes('fail') && data.status !== 'failed',
        getErrorMessage: (data) => data.msg || data.error || data.failure_reason || '未知错误'
    }
];

// ==============================================
// 模型配置
// ==============================================
const MODELS = {
    'nano-banana-fast': { name: 'Nano Banana Fast', supportsImages: true, pricing: { '1K': 4, '2K': 5, '4K': 6 }, supportedSizes: ['1K', '2K', '4K'] },
    'nano-banana-pro': { name: 'Nano Banana Pro', supportsImages: true, pricing: { '1K': 6, '2K': 8, '4K': 12 }, supportedSizes: ['1K', '2K', '4K'] },
    'nano-banana-2': { name: 'Nano Banana 2', supportsImages: true, pricing: { '1K': 4, '2K': 6, '4K': 10 }, supportedSizes: ['1K', '2K', '4K'] }
};

const DEFAULT_MODEL = 'nano-banana-fast';

// ==============================================
// 用户积分系统
// ==============================================
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
    try { if (fs.existsSync(USERS_FILE)) users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch (e) {}
}

function saveUsers() {
    try { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); } catch (e) {}
}

function initUser(pwd) {
    if (!users[pwd]) {
        const cfg = PASSWORDS[pwd];
        if (!cfg) return false;
        users[pwd] = { credits: cfg.credits, name: cfg.name, totalGenerated: 0, history: [] };
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

function recordGeneration(pwd, prompt, size, ratio, model, cost) {
    if (!users[pwd]) return;
    users[pwd].totalGenerated++;
    users[pwd].history.unshift({
        time: new Date().toISOString(),
        prompt: prompt.substring(0, 100), size, ratio, model, cost
    });
    if (users[pwd].history.length > 50) users[pwd].history = users[pwd].history.slice(0, 50);
    saveUsers();
}

loadUsers();

// ==============================================
// 中间件
// ==============================================
app.use(cors({ origin: true, credentials: true, maxAge: 86400 }));
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));
app.use(express.static('public'));

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 }
});

// ==============================================
// 基础接口
// ==============================================
app.get('/health', (req, res) => {
    res.json({ status: 'ok', mode: 'async-task' });
});

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
    res.json({
        success: true,
        name: u.name,
        credits: u.credits,
        totalGenerated: u.totalGenerated
    });
});

// ==============================================
// 🔥 核心：异步生成任务（不会断开连接）
// ==============================================
async function runGenerateTask(taskId, params) {
    const { modelId, prompt, images, ratio, size, pwd } = params;
    try {
        let finalImage = null;
        let targetSize = `${size} ${ratio}`;

        for (const provider of PROVIDERS) {
            let retry = 2;
            while (retry > 0) {
                try {
                    const mid = provider.modelMapping[modelId];
                    if (!mid) break;

                    const body = provider.buildRequestBody(mid, prompt, images, size, ratio);
                    const ctrl = new AbortController();
                    const timer = setTimeout(() => ctrl.abort(), 180000);

                    const resp = await fetch(provider.apiUrl, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${provider.apiKey}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify(body),
                        signal: ctrl.signal
                    });

                    clearTimeout(timer);
                    const text = await resp.text();
                    let data = {};
                    try { data = JSON.parse(text); } catch (e) {}

                    if (!provider.isSuccess(data)) throw new Error(provider.getErrorMessage(data));
                    const imgUrl = provider.parseResponse(data);
                    if (!imgUrl) throw new Error('未返回图片');

                    finalImage = imgUrl;
                    break;
                } catch (e) {
                    retry--;
                    if (retry <= 0) break;
                    await new Promise(r => setTimeout(r, 3000));
                }
            }
            if (finalImage) break;
        }

        if (!finalImage) throw new Error('所有服务均失败');

        taskMap.set(taskId, {
            status: 'success',
            image: finalImage,
            targetSize: targetSize,
            error: null
        });

        recordGeneration(pwd, prompt, size, ratio, modelId, MODELS[modelId].pricing[size]);

    } catch (err) {
        taskMap.set(taskId, {
            status: 'failed',
            error: err.message
        });
    }
}

// ==============================================
// 提交生成任务（立即返回，不阻塞）
// ==============================================
app.post('/api/generate/submit', upload.array('images', 3), async (req, res) => {
    try {
        const pwd = req.headers['x-password'];
        if (!pwd || !users[pwd]) return res.status(401).json({ success: false, error: '请先登录' });

        const { prompt, size = '2K', ratio = '1:1', model = DEFAULT_MODEL } = req.body;
        const images = req.files;

        if (!prompt) return res.status(400).json({ success: false, error: '请输入提示词' });

        const modelCfg = MODELS[model];
        if (!modelCfg) return res.status(400).json({ success: false, error: '模型不存在' });

        const cost = modelCfg.pricing[size];
        if (users[pwd].credits < cost) {
            return res.status(402).json({
                success: false,
                error: `积分不足，需要 ${cost} 积分`
            });
        }

        deductCredits(pwd, cost);

        // 创建任务
        const taskId = Date.now().toString(36) + Math.random().toString(36).slice(2);
        taskMap.set(taskId, { status: 'processing' });

        // 后台异步执行，不占用请求
        runGenerateTask(taskId, {
            modelId: model, prompt, images, ratio, size, pwd
        });

        res.json({
            success: true,
            taskId,
            credits: users[pwd].credits
        });

    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ==============================================
// 查询任务结果
// ==============================================
app.get('/api/generate/result/:taskId', (req, res) => {
    const task = taskMap.get(req.params.taskId);
    if (!task) return res.status(404).json({ success: false, error: '任务不存在' });
    res.json({ success: true, ...task });
});

// ==============================================
// 启动
// ==============================================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 异步任务服务已启动`);
    console.log(`✅ 彻底解决 30 秒超时/断开连接`);
    console.log(`📡 端口: ${PORT}`);
});