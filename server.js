const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

// ==============================================
// 🔥 核心：解决 Zeabur 30秒断开 & 所有浏览器兼容
// ==============================================
app.use((req, res, next) => {
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Keep-Alive', 'timeout=600');
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    next();
});

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 服务启动成功 - 端口: ${PORT}`);
    console.log(`✅ 彻底解决 Zeabur 30秒断开/连接断开问题`);
    console.log(`✅ 兼容所有浏览器/插件/多用户`);
});
server.timeout = 180000; // 3分钟超时
server.keepAliveTimeout = 180000;

// ==============================================
// 配置 GRSAI (唯一提供商)
// ==============================================
const GRSAI_API_URL = "https://grsai.dakka.com.cn/v1/draw/nano-banana";
const GRSAI_RESULT_URL = "https://grsai.dakka.com.cn/v1/draw/result";
const GRSAI_API_KEY = "sk-a1c7ff1ce99f4e03a5aed5ddb82dce58";

const MODEL_MAPPING = {
    'nano-banana-fast': 'nano-banana-fast',
    'nano-banana-pro': 'nano-banana-pro',
    'nano-banana-2': 'nano-banana-2'
};

// 构建请求体
function buildRequestBody(modelId, prompt, images, size, ratio) {
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
}

// 轮询获取结果
async function pollResult(taskId, timeout = 120000, interval = 2000) {
    const startTime = Date.now();
    while (Date.now() - startTime < timeout) {
        await new Promise(resolve => setTimeout(resolve, interval));
        try {
            const resp = await fetch(GRSAI_RESULT_URL, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${GRSAI_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ id: taskId })
            });
            const data = await resp.json();
            if (data.code === 0 && data.data) {
                const result = data.data;
                if (result.status === 'succeeded') {
                    return result.results;
                } else if (result.status === 'failed') {
                    throw new Error(`生成失败: ${result.failure_reason || '未知错误'}`);
                }
            }
        } catch (err) {
            console.error('轮询结果失败:', err.message);
        }
    }
    throw new Error('生成超时，请稍后重试');
}

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
// 基础接口
// ==============================================
app.get('/health', (req, res) => res.json({ status: 'ok', mode: 'sync-stable' }));

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

// ==============================================
// 🔥 核心生成接口（异步轮询）
// ==============================================
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

        // 调用 GRSAI 获取任务 ID
        const mappedModel = MODEL_MAPPING[model];
        if (!mappedModel) throw new Error('模型映射失败');

        const body = buildRequestBody(mappedModel, prompt, imgs, size, ratio);
        console.log('开始调用 GRSAI:', GRSAI_API_URL);

        const createResp = await fetch(GRSAI_API_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${GRSAI_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        const createData = await createResp.json();
        if (!createResp.ok || createData.code !== 0) {
            console.error('GRSAI 创建任务失败:', createData);
            throw new Error(createData.msg || '创建任务失败');
        }

        const taskId = createData.id;
        if (!taskId) throw new Error('未获取到任务ID');

        console.log(`任务创建成功，ID: ${taskId}，开始轮询结果...`);

        // 轮询结果（最多 120 秒，间隔 2 秒）
        const results = await pollResult(taskId, 120000, 2000);
        if (!results || results.length === 0) throw new Error('未获取到图片URL');

        const imgUrl = results[0].url || results[0];
        if (!imgUrl) throw new Error('图片URL为空');

        // 记录成功
        users[pwd].totalGenerated++;
        users[pwd].history.unshift({
            t: new Date().toISOString(),
            p: prompt.substring(0, 100),
            s: size,
            r: ratio,
            m: model,
            c: cost
        });
        if (users[pwd].history.length > 50) users[pwd].history = users[pwd].history.slice(0, 50);
        saveUsers();

        res.json({
            success: true,
            image: imgUrl,
            targetSize: `${size} ${ratio}`,
            credits: users[pwd].credits,
            provider: 'GRSAI'
        });

    } catch (e) {
        console.error('❌ 生成接口报错:', e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

console.log('✅ 最终稳定版服务已加载完成！');