const express = require('express');
const cors = require('cors');
const app = express();

// 中间件
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// ========== 配置 ==========
// 直接在这里写入你的 API Key
const GEMINI_API_KEY = "sk-ZNx9WcSMJt3b7ayDknbi2PKFI9UsUNx3VVfXlapCgDZiNo61";

// n1n.ai API 地址
const N1N_API_URL = "https://api.n1n.ai/v1";

// 模型配置
const MODEL_NAME = "gemini-2.5-flash-image";

console.log('✅ API Key 已硬编码配置');
console.log(`🔑 Key 前缀: ${GEMINI_API_KEY.substring(0, 15)}...`);

// ========== 健康检查 ==========
app.get('/', (req, res) => {
    res.send('Nano Banana Pro is running!');
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        geminiConfigured: !!GEMINI_API_KEY,
        apiType: GEMINI_API_KEY?.startsWith('sk-') ? 'n1n.ai' : 'unknown'
    });
});

// ========== 图片生成 API ==========
app.post('/api/generate', async (req, res) => {
    const { prompt, input, model } = req.body;
    // 直接使用硬编码的 Key，忽略前端传来的
    const activeKey = GEMINI_API_KEY;
    
    console.log('📥 收到生成请求');
    console.log('提示词:', prompt?.substring(0, 100));
    console.log('模型:', model || MODEL_NAME);
    console.log('分辨率:', input?.resolution);
    console.log('参考图数量:', input?.image_input?.length || 0);
    
    if (!activeKey) {
        return res.status(400).json({ 
            success: false, 
            error: 'API Key 未配置' 
        });
    }
    
    if (!prompt) {
        return res.status(400).json({ 
            success: false, 
            error: '请输入画面描述' 
        });
    }
    
    try {
        // 构建完整的提示词
        let fullPrompt = prompt;
        
        if (input?.resolution === '4K') {
            fullPrompt = `[超高分辨率4K，极致细节] ${fullPrompt}`;
        } else if (input?.resolution === '2K') {
            fullPrompt = `[高清2K分辨率，精细细节] ${fullPrompt}`;
        } else if (input?.resolution === '1K') {
            fullPrompt = `[标准1K分辨率] ${fullPrompt}`;
        }
        
        if (input?.aspect_ratio) {
            const ratioMap = {
                '1:1': '正方形1:1',
                '4:3': '横版4:3',
                '3:4': '竖版3:4',
                '16:9': '宽屏16:9',
                '9:16': '竖屏9:16',
                '3:2': '横版3:2',
                '2:3': '竖版2:3'
            };
            fullPrompt = `[${ratioMap[input.aspect_ratio] || input.aspect_ratio}比例] ${fullPrompt}`;
        }
        
        if (input?.image_input && input.image_input.length > 0) {
            if (input.image_input.length === 1) {
                fullPrompt = `参考上传的图片风格，${fullPrompt}`;
            } else {
                fullPrompt = `结合 ${input.image_input.length} 张参考图的特点进行创作，${fullPrompt}`;
            }
        }
        
        console.log('📤 发送请求到 n1n.ai API...');
        
        // 构建消息
        const messages = [];
        const userContent = [];
        
        userContent.push({
            type: "text",
            text: fullPrompt
        });
        
        if (input?.image_input && input.image_input.length > 0) {
            const maxImages = Math.min(input.image_input.length, 3);
            console.log(`🖼️ 包含 ${maxImages} 张参考图`);
            
            for (let i = 0; i < maxImages; i++) {
                userContent.push({
                    type: "image_url",
                    image_url: {
                        url: input.image_input[i]
                    }
                });
            }
        }
        
        messages.push({
            role: "user",
            content: userContent
        });
        
        const requestBody = {
            model: model || MODEL_NAME,
            messages: messages,
            max_tokens: 8192,
            temperature: 0.7
        };
        
        console.log('请求体大小:', JSON.stringify(requestBody).length, 'bytes');
        
        const response = await fetch(`${N1N_API_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${activeKey}`
            },
            body: JSON.stringify(requestBody)
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error('API 错误响应:', errorText);
            
            let errorMessage = `API 请求失败: ${response.status}`;
            try {
                const errorData = JSON.parse(errorText);
                errorMessage = errorData.error?.message || errorData.message || errorMessage;
            } catch(e) {}
            
            throw new Error(errorMessage);
        }
        
        const data = await response.json();
        console.log('✅ API 响应成功');
        
        let imageUrl = null;
        const content = data.choices?.[0]?.message?.content;
        
        if (content) {
            if (content.startsWith('data:image')) {
                imageUrl = content;
                console.log('✅ 提取到 base64 图片');
            } else {
                const markdownMatch = content.match(/!\[.*?\]\((.*?)\)/);
                if (markdownMatch) {
                    imageUrl = markdownMatch[1];
                    console.log('✅ 提取到 Markdown 图片链接');
                } else {
                    const urlMatch = content.match(/https?:\/\/[^\s]+\.(png|jpg|jpeg|gif|webp)/i);
                    if (urlMatch) {
                        imageUrl = urlMatch[0];
                        console.log('✅ 提取到直接图片 URL');
                    }
                }
            }
        }
        
        if (imageUrl) {
            console.log('🎉 图片生成成功！');
            res.json({ success: true, imageUrl: imageUrl });
        } else {
            console.log('⚠️ 未找到图片，返回文本:', content?.substring(0, 200));
            res.json({ 
                success: false, 
                error: '模型未返回图片数据，请检查提示词是否适合生成图片',
                debugText: content?.substring(0, 500)
            });
        }
        
    } catch (error) {
        console.error('❌ 生成错误:', error);
        
        let errorMessage = error.message;
        if (error.message.includes('quota')) {
            errorMessage = 'API 配额已用完，请检查 n1n.ai 账户余额';
        } else if (error.message.includes('auth') || error.message.includes('401')) {
            errorMessage = 'API Key 无效，请检查 n1n.ai 的 API Key 是否正确';
        } else if (error.message.includes('429')) {
            errorMessage = '请求过于频繁，请稍后重试';
        }
        
        res.status(500).json({ 
            success: false, 
            error: errorMessage,
            details: error.message
        });
    }
});

// ========== 查询 API 状态 ==========
app.post('/api/balance', async (req, res) => {
    const activeKey = GEMINI_API_KEY;
    
    if (!activeKey) {
        return res.json({ success: false, balance: null, message: '未配置 API Key' });
    }
    
    try {
        const response = await fetch(`${N1N_API_URL}/models`, {
            headers: {
                'Authorization': `Bearer ${activeKey}`
            }
        });
        
        if (response.ok) {
            res.json({ 
                success: true, 
                balance: null,
                message: '✅ n1n.ai API Key 有效，按量计费模式（1元≈1美元）'
            });
        } else {
            res.json({ 
                success: false, 
                balance: null, 
                message: 'API Key 无效'
            });
        }
    } catch (error) {
        res.json({ success: false, balance: null, message: error.message });
    }
});

// ========== 启动服务器 ==========
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`
    🍌 Nano Banana Pro - n1n.ai 硬编码版
    =================================
    服务端口: ${PORT}
    
    ✅ n1n.ai API: 已硬编码配置
    🔑 API Key 前缀: ${GEMINI_API_KEY.substring(0, 15)}...
    📊 计费模式: 按量计费（1元 ≈ 1美元）
    
    🌐 健康检查: http://localhost:${PORT}/health
    📱 前端页面: http://localhost:${PORT}
    
    💡 提示: API Key 已写入代码，无需在网页填写
    `);
});