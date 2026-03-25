const express = require('express');
const cors = require('cors');
const app = express();

// 中间件
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// ========== 测试路由 ==========
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

// ========== 图片生成 API ==========
app.post('/api/generate', async (req, res) => {
    const { apiKey, prompt, input } = req.body;
    const activeKey = apiKey || process.env.GEMINI_API_KEY;
    
    console.log('收到生成请求');
    console.log('提示词:', prompt);
    
    if (!activeKey) {
        return res.status(400).json({ 
            success: false, 
            error: '请配置 Gemini API Key' 
        });
    }
    
    if (!prompt) {
        return res.status(400).json({ 
            success: false, 
            error: '请输入画面描述' 
        });
    }
    
    try {
        // 动态导入 Gemini SDK
        const { GoogleGenerativeAI } = require('@google/generative-ai');
        const client = new GoogleGenerativeAI(activeKey);
        const MODEL_NAME = "gemini-2.5-flash-image";
        const geminiModel = client.getGenerativeModel({ model: MODEL_NAME });
        
        // 构建提示词
        let fullPrompt = prompt;
        if (input?.resolution === '4K') fullPrompt = `[4K超清] ${fullPrompt}`;
        if (input?.resolution === '2K') fullPrompt = `[2K高清] ${fullPrompt}`;
        
        // 构建请求内容
        const contents = [];
        
        // 添加参考图
        if (input?.image_input && input.image_input.length > 0) {
            for (let i = 0; i < Math.min(input.image_input.length, 3); i++) {
                const base64Data = input.image_input[i].split(',')[1];
                if (base64Data) {
                    contents.push({
                        role: 'user',
                        parts: [{
                            inlineData: {
                                mimeType: 'image/png',
                                data: base64Data
                            }
                        }]
                    });
                }
            }
        }
        
        contents.push({ role: 'user', parts: [{ text: fullPrompt }] });
        
        // 调用 API
        console.log('调用 Gemini API...');
        const result = await geminiModel.generateContent({
            contents: contents,
            generationConfig: { temperature: 0.7, maxOutputTokens: 8192 }
        });
        
        // 提取图片
        let imageUrl = null;
        const parts = result.response.candidates?.[0]?.content?.parts || [];
        
        for (const part of parts) {
            if (part.inlineData?.data) {
                imageUrl = `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`;
                break;
            }
        }
        
        if (imageUrl) {
            console.log('✅ 生成成功');
            res.json({ success: true, imageUrl });
        } else {
            res.json({ success: false, error: '模型未返回图片数据' });
        }
        
    } catch (error) {
        console.error('❌ 错误:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// 启动服务器
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`✅ Gemini API: ${process.env.GEMINI_API_KEY ? '已配置' : '未配置'}`);
});