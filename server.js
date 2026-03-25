const express = require('express');
const cors = require('cors');
const app = express();

// 中间件
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// ========== 健康检查（Zeabur 需要） ==========
app.get('/', (req, res) => {
    res.send('Nano Banana Pro is running!');
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        geminiConfigured: !!process.env.GEMINI_API_KEY
    });
});

// ========== 其他 API 路由 ==========
// ... 你的 /api/generate 和 /api/balance 代码 ...

// 启动服务器
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
    🍌 Nano Banana Pro - n1n.ai 版本
    =================================
    服务端口: ${PORT}
    
    ✅ n1n.ai API: ${process.env.GEMINI_API_KEY ? '已配置' : '未配置'}
    `);
});