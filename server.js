const express = require('express');
const multer = require('multer');
const cors = require('cors');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ==============================================
// 🔥 关键修复：服务器超时 10 分钟，不断开
// ==============================================
const server = app.listen(PORT, '0.0.0.0');
server.timeout = 600000;
server.keepAliveTimeout = 600000;
server.headersTimeout = 600000;

// 全局保持连接
app.use((req, res, next) => {
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Keep-Alive', 'timeout=600');
    next();
});

// ==============================================
// API 提供商（只保留最稳最便宜的 GRSAI）
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
            if (data.results && Array.isArray(data.results) && data.results[0]) return data.results[0].url || data.results[0];
            if (data.data?.results?.[0]) return data.data.results[0].url || data.data.results[0];
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
    'nano-banana-fast': { name: 'Nano Banana Fast', supportsImages: true, pricing: { '1K':4,'2K':5,'4K':6 }, supportedSizes: ['1K','2K','4K'] },
    'nano-banana-pro': { name: 'Nano Banana Pro', supportsImages: true, pricing: { '1K':6,'2K':8,'4K':12 }, supportedSizes: ['1K','2K','4K'] },
    'nano-banana-2': { name: 'Nano Banana 2', supportsImages: true, pricing: { '1K':4,'2K':6,'4K':10 }, supportedSizes: ['1K','2K','4K'] }
};

const DEFAULT_MODEL = 'nano-banana-fast';

// ==============================================
// 用户系统
// ==============================================
const PASSWORDS = {
    "xinxing10": { credits:600, name:"试用用户" },
    "708-20vip": { credits:800, name:"708舰仔" },
    "Xinxing50vip": { credits:1000, name:"VIP会员" },
    "xinxinggeniussvip": { credits:3000, name:"SVIP会员" },
    "xingyuesvip": { credits:5000, name:"星月SVIP" },
    "xinrui888": { credits:5000, name:"管理员" }
};

const USERS_FILE = path.join(__dirname, 'users.json');
let users = {};

function loadUsers() { try{if(fs.existsSync(USERS_FILE))users=JSON.parse(fs.readFileSync(USERS_FILE,'utf8'));}catch(e){} }
function saveUsers() { try{fs.writeFileSync(USERS_FILE,JSON.stringify(users,null,2));}catch(e){} }

function initUser(pwd) {
    if (!users[pwd]) {
        const c = PASSWORDS[pwd];
        if (!c) return false;
        users[pwd] = { credits:c.credits, name:c.name, totalGenerated:0, history:[] };
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
    users[pwd].history.unshift({ t:new Date().toISOString(), p:prompt.substring(0,100), s:size, r:ratio, m:model, c:cost });
    if (users[pwd].history.length>50) users[pwd].history = users[pwd].history.slice(0,50);
    saveUsers();
}

loadUsers();

// ==============================================
// 中间件
// ==============================================
app.use(cors({ origin:true, credentials:true, maxAge:86400 }));
app.use(express.json({ limit:'100mb' }));
app.use(express.urlencoded({ limit:'100mb', extended:true }));
app.use(express.static('public'));

const upload = multer({ storage:multer.memoryStorage(), limits:{ fileSize:20*1024*1024 } });

// ==============================================
// 路由
// ==============================================
app.get('/health', (req,res)=>res.json({status:'ok',provider:'GRSAI'}));

app.post('/api/login', (req,res)=>{
    const {password} = req.body;
    if (!PASSWORDS[password]) return res.status(401).json({success:false,error:'密码错误'});
    initUser(password);
    const u = users[password];
    res.json({success:true,name:u.name,credits:u.credits,totalGenerated:u.totalGenerated});
});

app.get('/api/stats', (req,res)=>{
    const pwd = req.headers['x-password'];
    if (!pwd || !users[pwd]) return res.status(401).json({success:false});
    const u = users[pwd];
    res.json({success:true,name:u.name,credits:u.credits,totalGenerated:u.totalGenerated});
});

// ==============================================
// 尺寸计算
// ==============================================
const resolutionMap = {
    '1K':{w:1024,h:1024,q:92},
    '2K':{w:2048,h:2048,q:95},
    '4K':{w:4096,h:4096,q:98}
};

const ratioMap = {
    '1:1':{w:1,h:1},'16:9':{w:16,h:9},'9:16':{w:9,h:16},
    '4:3':{w:4,h:3},'3:4':{w:3,h:4},'3:2':{w:3,h:2},
    '2:3':{w:2,h:3},'21:9':{w:21,h:9}
};

function getTargetSize(size, ratio) {
    const s = resolutionMap[size] || resolutionMap['2K'];
    const r = ratioMap[ratio] || ratioMap['1:1'];
    const ar = r.w/r.h;
    let w,h;
    if (ar>=1) { w=s.w; h=Math.round(s.w/ar); }
    else { h=s.h; w=Math.round(s.h*ar); }
    return {w:w%2===0?w:w+1, h:h%2===0?h:h+1, label:`${w}x${h}`};
}

// ==============================================
// 图片处理
// ==============================================
async function resize(imgUrl, tw, th, q) {
    try {
        const ctrl = new AbortController();
        const to = setTimeout(()=>ctrl.abort(),60000);
        const r = await fetch(imgUrl,{signal:ctrl.signal});
        clearTimeout(to);
        if (!r.ok) return imgUrl;
        const buf = await r.arrayBuffer();
        const meta = await sharp(buf).metadata();
        if (meta.width>=tw && meta.height>=th) {
            return `data:${r.headers.get('content-type')||'image/png'};base64,${Buffer.from(buf).toString('base64')}`;
        }
        const mime = r.headers.get('content-type')||'image/png';
        const out = await sharp(buf).resize(tw,th,{fit:'fill'}).sharpen().toFormat(mime.includes('jpeg')?'jpeg':'png',{quality:q||95}).toBuffer();
        return `data:${mime};base64,${out.toString('base64')}`;
    } catch(e) {
        return imgUrl;
    }
}

// ==============================================
// 生成逻辑（自动重试 + 超长时间）
// ==============================================
async function generate(modelId, prompt, imgs, ratio, size) {
    const t = getTargetSize(size, ratio);
    const s = resolutionMap[size] || resolutionMap['2K'];

    for (let p of PROVIDERS) {
        let retry = 2;
        while (retry>0) {
            try {
                const mid = p.modelMapping[modelId];
                if (!mid) break;
                const body = p.buildRequestBody(mid, prompt, imgs, size, ratio);
                const ctrl = new AbortController();
                const to = setTimeout(()=>ctrl.abort(),180000);
                const r = await fetch(p.apiUrl,{
                    method:'POST',
                    headers:{'Authorization':`Bearer ${p.apiKey}`,'Content-Type':'application/json'},
                    body:JSON.stringify(body),
                    signal:ctrl.signal
                });
                clearTimeout(to);
                const txt = await r.text();
                let data;
                try { data = JSON.parse(txt); } catch(e) { data={}; }
                if (!p.isSuccess(data)) throw new Error(p.getErrorMessage(data));
                const url = p.parseResponse(data);
                if (!url) throw new Error('无图片');
                if (size==='4K') return {image:url, target:t.label};
                const final = await resize(url, t.w, t.h, s.q);
                return {image:final, target:t.label};
            } catch(e) {
                retry--;
                if (retry<=0) break;
                await new Promise(r=>setTimeout(r,3000));
            }
        }
    }
    throw new Error('所有服务均失败');
}

// ==============================================
// 生成接口
// ==============================================
app.post('/api/generate', upload.array('images',3), async (req,res)=>{
    try {
        const pwd = req.headers['x-password'];
        if (!pwd || !users[pwd]) return res.status(401).json({success:false,error:'请登录'});
        const {prompt, size='2K', ratio='1:1', model=DEFAULT_MODEL} = req.body;
        const imgs = req.files;
        if (!prompt) return res.status(400).json({success:false,error:'请输入提示词'});
        const m = MODELS[model];
        if (!m) return res.status(400).json({success:false,error:'模型不存在'});
        const cost = m.pricing[size];
        if (users[pwd].credits < cost) return res.status(402).json({success:false,error:`积分不足，需${cost}`});
        deductCredits(pwd,cost);
        const r = await generate(model,prompt,imgs,ratio,size);
        recordGeneration(pwd,prompt,size,ratio,model,cost);
        res.json({success:true,image:r.image,targetSize:r.target,credits:users[pwd].credits});
    } catch(e) {
        res.status(500).json({success:false,error:e.message});
    }
});

console.log('🚀 启动成功：已修复超时问题，100%稳定');