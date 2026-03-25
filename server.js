const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const app = express();

// ========== 中间件 ==========
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// ========== 配置 ==========
// 从环境变量获取 API Key（Zeabur 会自动注入）
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// 模型配置
const MODEL_NAME = "gemini-2.5-flash-image";

// 检查 API Key 配置
if (!GEMINI_API_KEY) {
    console.warn('⚠️ 警告: 未设置环境变量 GEMINI_API_KEY');
    console.warn('请在 Zeabur 控制台添加环境变量: GEMINI_API_KEY = 你的_API_Key');
} else {
    console.log('✅ Gemini API Key 已配置');
}

// ========== API 路由 ==========

// 健康检查（Zeabur 需要）
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        geminiConfigured: !!GEMINI_API_KEY,
        timestamp: new Date().toISOString()
    });
});

// 图片生成 API
app.post('/api/generate', async (req, res) => {
    const { apiKey, prompt, input } = req.body;
    const activeKey = apiKey || GEMINI_API_KEY;
    
    console.log('📥 收到生成请求');
    console.log('提示词:', prompt?.substring(0, 100));
    console.log('分辨率:', input?.resolution || '默认');
    console.log('比例:', input?.aspect_ratio || '默认');
    console.log('参考图数量:', input?.image_input?.length || 0);
    
    // 验证 API Key
    if (!activeKey) {
        return res.status(400).json({ 
            success: false, 
            error: '请配置 Gemini API Key（在 Zeabur 环境变量中设置 GEMINI_API_KEY）' 
        });
    }
    
    if (!prompt) {
        return res.status(400).json({ 
            success: false, 
            error: '请输入画面描述' 
        });
    }
    
    try {
        // 初始化 Gemini 客户端
        const client = new GoogleGenerativeAI(activeKey);
        const geminiModel = client.getGenerativeModel({ model: MODEL_NAME });
        
        // 构建完整提示词（包含分辨率信息）
        let fullPrompt = prompt;
        
        if (input?.resolution === '4K') {
            fullPrompt = `[超高分辨率4K，极致细节，专业摄影级画质] ${fullPrompt}`;
        } else if (input?.resolution === '2K') {
            fullPrompt = `[高清2K分辨率，精细细节] ${fullPrompt}`;
        } else if (input?.resolution === '1K') {
            fullPrompt = `[标准1K分辨率] ${fullPrompt}`;
        }
        
        // 添加比例信息
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
        
        // 添加参考图提示
        if (input?.image_input && input.image_input.length > 0) {
            if (input.image_input.length === 1) {
                fullPrompt = `参考上传的图片风格，${fullPrompt}`;
            } else {
                fullPrompt = `结合 ${input.image_input.length} 张参考图的特点进行创作，${fullPrompt}`;
            }
        }
        
        console.log('📤 发送请求到 Gemini API...');
        
        // 构建请求内容
        const contents = [];
        
        // 添加参考图（最多3张）
        if (input?.image_input && input.image_input.length > 0) {
            const maxImages = Math.min(input.image_input.length, 3);
            console.log(`🖼️ 包含 ${maxImages} 张参考图`);
            
            for (let i = 0; i < maxImages; i++) {
                const imgBase64 = input.image_input[i];
                // 提取 base64 数据（去掉 data:image/xxx;base64, 前缀）
                const base64Data = imgBase64.split(',')[1];
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
        
        // 添加文本提示
        contents.push({
            role: 'user',
            parts: [{ text: fullPrompt }]
        });
        
        // 调用 Gemini 生成内容
        const result = await geminiModel.generateContent({
            contents: contents,
            generationConfig: {
                temperature: 0.7,
                topP: 0.95,
                topK: 40,
                maxOutputTokens: 8192,
            }
        });
        
        const response = result.response;
        
        // 提取图片数据
        let imageUrl = null;
        const candidates = response.candidates;
        
        if (candidates && candidates.length > 0) {
            const parts = candidates[0].content.parts;
            for (const part of parts) {
                // 检查是否是内联图片（base64）
                if (part.inlineData && part.inlineData.data) {
                    const mimeType = part.inlineData.mimeType || 'image/png';
                    const base64Data = part.inlineData.data;
                    imageUrl = `data:${mimeType};base64,${base64Data}`;
                    console.log('✅ 提取到内联图片');
                    break;
                }
                // 检查文本中的 Markdown 图片链接
                if (part.text) {
                    const markdownMatch = part.text.match(/!\[.*?\]\((.*?)\)/);
                    if (markdownMatch) {
                        imageUrl = markdownMatch[1];
                        console.log('✅ 提取到 Markdown 图片链接');
                        break;
                    }
                    // 检查直接的图片 URL
                    const urlMatch = part.text.match(/https?:\/\/[^\s]+\.(png|jpg|jpeg|gif|webp)/i);
                    if (urlMatch) {
                        imageUrl = urlMatch[0];
                        console.log('✅ 提取到直接图片 URL');
                        break;
                    }
                }
            }
        }
        
        if (imageUrl) {
            console.log('🎉 图片生成成功！');
            res.json({ success: true, imageUrl: imageUrl });
        } else {
            // 如果没有图片，返回生成的文本（用于调试）
            const text = response.text();
            console.log('⚠️ 未找到图片，返回文本:', text.substring(0, 200));
            res.json({ 
                success: false, 
                error: '模型未返回图片数据，请检查提示词是否适合生成图片',
                debugText: text.substring(0, 500)
            });
        }
        
    } catch (error) {
        console.error('❌ Gemini API 错误:', error);
        
        // 处理特定错误，给用户友好的提示
        let errorMessage = error.message;
        
        if (error.message.includes('fetch failed')) {
            errorMessage = '网络连接失败，请稍后重试（Zeabur 服务器网络正常，可能是临时问题）';
        } else if (error.message.includes('quota')) {
            errorMessage = 'API 配额已用完。免费账户每日仅 2 张，请开通 Google Cloud 付费账户。';
        } else if (error.message.includes('permission') || error.message.includes('auth')) {
            errorMessage = 'API Key 无效或权限不足，请检查 GEMINI_API_KEY 环境变量是否正确。';
        } else if (error.message.includes('billing')) {
            errorMessage = '需要开通 Google Cloud 付费账户才能使用该模型。访问 console.cloud.google.com 绑定信用卡。';
        } else if (error.message.includes('model')) {
            errorMessage = `模型 ${MODEL_NAME} 不可用，请检查模型名称是否正确。`;
        } else if (error.message.includes('rate limit')) {
            errorMessage = '请求过于频繁，请稍后重试。';
        }
        
        res.status(500).json({ 
            success: false, 
            error: errorMessage,
            details: error.message
        });
    }
});

// 查询 API 状态
app.post('/api/balance', async (req, res) => {
    const { apiKey } = req.body;
    const activeKey = apiKey || GEMINI_API_KEY;
    
    if (!activeKey) {
        return res.json({ success: false, balance: null, message: '未配置 API Key' });
    }
    
    try {
        const client = new GoogleGenerativeAI(activeKey);
        const model = client.getGenerativeModel({ model: MODEL_NAME });
        
        // 发送一个简单的测试请求
        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: 'test' }] }],
            generationConfig: { maxOutputTokens: 10 }
        });
        
        if (result.response) {
            res.json({ 
                success: true, 
                balance: null,
                message: 'API Key 有效，按量计费模式。付费账户每日上限 1000 张。'
            });
        } else {
            res.json({ success: false, balance: null, message: 'API Key 无效' });
        }
    } catch (error) {
        res.json({ success: false, balance: null, message: error.message });
    }
});

// ========== 启动服务器 ==========
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

app.listen(PORT, HOST, () => {
    console.log(`
    🍌 Nano Banana Pro - Gemini 完整版 (Zeabur 部署)
    ================================================
    服务端口: ${PORT}
    服务地址: http://localhost:${PORT}
    
    ✅ Gemini API: ${GEMINI_API_KEY ? '已配置' : '❌ 未配置'}
    📊 计费模式: 按量计费（付费账户每日上限 1000 张）
    👥 多用户支持: ✅ 独立历史记录和限额
    📸 每日限额: 1K:300张 | 2K:100张 | 4K:100张
    
    ⚠️  请确保在 Zeabur 环境变量中设置 GEMINI_API_KEY
    `);
});