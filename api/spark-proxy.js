const crypto = require('crypto'); // 可能不再需要，取决于新鉴权方式
// --- 移除这行: const fetch = require('node-fetch'); ---

// --- 从环境变量读取敏感信息 ---
const APPID = process.env.SPARK_APPID; // 可能仍需要
const API_SECRET = process.env.SPARK_API_SECRET; // 用于新鉴权
const API_KEY = process.env.SPARK_API_KEY;       // 用于新鉴权

// --- Spark API 地址 (兼容 OpenAI 格式) ---
const SPARK_API_URL = "https://spark-api-open.xf-yun.com/v1/chat/completions";
// --- 确认 Lite 版或其他模型在新 API 中的标识符 ---
const MODEL_NAME = "lite"; // 请根据官方文档确认正确的模型名称

// --- 移除旧的 getAuthorizationUrl 函数 ---
// function getAuthorizationUrl() { ... } // 删除此函数

// --- Vercel Serverless Function 主体 ---
module.exports = async (req, res) => {
    // --- 使用动态 import() 导入 node-fetch ---
    const fetch = (await import('node-fetch')).default;

    // --- 设置 CORS 响应头 ---
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); // 允许 Authorization 头

    // --- 处理 OPTIONS 预检请求 ---
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // --- 处理 POST 请求 ---
    if (req.method === 'POST') {
        // 检查必要的环境变量是否设置 (根据新鉴权方式调整)
        if (!API_KEY || !API_SECRET || !APPID) { // APPID 可能仍需要，取决于具体实现
            console.error("Server Error: Spark environment variables not configured.");
            return res.status(500).json({ error: "服务器内部错误：API凭证未配置" });
        }

        try {
            const { content, title } = req.body; // 从请求体获取内容和标题

            if (!content) {
                return res.status(400).json({ error: "请求体缺少 'content' 字段" });
            }

            // --- 构造符合 OpenAI 格式的请求体 ---
            const requestData = {
                model: MODEL_NAME, // 使用正确的模型名称
                messages: [
                    { role: "system", content: "你是一个有用的助手，请根据用户提供的文章标题和内容生成一段简洁的摘要。" },
                    { role: "user", content: `文章标题：${title || '无标题'}\n文章内容：${content}` }
                ],
                temperature: 0.5,
                max_tokens: 200
                // 根据需要添加其他参数，如 stream: false
            };

            // --- 构造请求头 (!!! 重要：根据讯飞官方文档修改鉴权方式 !!!) ---
            const headers = {
                'Content-Type': 'application/json',
                // --- 这里需要添加正确的 Authorization Header ---
                // 示例 1 (假设是 Bearer Token, token 如何生成需查文档):
                // 'Authorization': `Bearer ${generateSparkToken(API_KEY, API_SECRET)}`,
                // 示例 2 (假设直接用 Key/Secret, 具体 Header 名称需查文档):
                // 'Authorization': `Key ${API_KEY}`,
                // 'X-Spark-Secret': API_SECRET, // Header 名称仅为示例
                // --- 请务必参考讯飞官方文档获取准确的鉴权 Header ---
                'Authorization': `Bearer ${API_KEY}:${API_SECRET}` // 这是一个常见的但不一定正确的示例，请验证！
            };


            // --- 发送请求到 Spark API ---
            const sparkResponse = await fetch(SPARK_API_URL, { // 直接使用 API URL，不再需要 authUrl
                method: 'POST',
                headers: headers, // 使用新的 Headers
                body: JSON.stringify(requestData) // 使用新的 Request Body
            });

            // 检查 fetch 是否成功
            if (!sparkResponse) {
                console.error("Proxy Error: Failed to fetch Spark API.");
                return res.status(500).json({ error: '代理服务器未能连接到 Spark API' });
            }

            const sparkData = await sparkResponse.json();

            // --- 处理 Spark API 的响应 (OpenAI 兼容格式) ---
            if (sparkResponse.ok && sparkData.choices && sparkData.choices.length > 0 && sparkData.choices[0].message) {
                const assistantMessage = sparkData.choices[0].message;
                if (assistantMessage.role === 'assistant' && assistantMessage.content) {
                    const summary = assistantMessage.content.trim();
                    return res.status(200).json({ summary: summary });
                } else {
                    console.error("Spark response parsing error (unexpected message role or content):", sparkData);
                    return res.status(500).json({ error: "未能从 Spark 获取有效摘要内容" });
                }
            } else if (sparkData.error) { // OpenAI 兼容 API 通常用 error 字段报告错误
                console.error("Spark API Error:", sparkData.error.message);
                return res.status(sparkResponse.status || 500).json({ error: `Spark API 错误: ${sparkData.error.message} (Code: ${sparkData.error.code || 'N/A'})` });
            } else if (!sparkResponse.ok) { // 处理其他 HTTP 错误
                 console.error("Spark request failed:", sparkResponse.status, sparkData);
                 // 尝试从响应体获取更详细的错误信息
                 let errorMessage = `获取摘要失败，状态码: ${sparkResponse.status}`;
                 if (sparkData && typeof sparkData === 'object') {
                     errorMessage += ` - ${JSON.stringify(sparkData)}`;
                 } else if (typeof sparkData === 'string') {
                     errorMessage += ` - ${sparkData}`;
                 }
                 return res.status(sparkResponse.status).json({ error: errorMessage });
            }
             else {
                console.error("Spark request failed or unexpected format:", sparkResponse.status, sparkData);
                return res.status(sparkResponse.status || 500).json({ error: `获取摘要失败，状态码: ${sparkResponse.status}, 响应格式未知` });
            }

        } catch (error) {
            console.error("Proxy Error:", error);
            // 检查是否是 JSON 解析错误
            if (error instanceof SyntaxError) {
                 console.error("Failed to parse Spark API response as JSON.");
                 // 可以尝试获取原始文本响应
                 // const rawResponse = await sparkResponse.text(); // 需要在 try 块内重新获取或传递
                 // console.error("Raw response:", rawResponse);
                 return res.status(500).json({ error: '代理服务器错误：无法解析 Spark API 响应' });
            }
            return res.status(500).json({ error: '代理服务器内部错误', details: error.message });
        }
    } else {
        // 如果不是 POST 或 OPTIONS 请求
        res.setHeader('Allow', ['POST', 'OPTIONS']);
        return res.status(405).end(`Method ${req.method} Not Allowed`);
    }
};

// --- 如果需要生成 Token，可能需要类似这样的辅助函数 (具体实现需查文档) ---
// function generateSparkToken(apiKey, apiSecret) {
//     // ... 根据讯飞文档实现 Token 生成逻辑 ...
//     return "generated_token_string";
// }