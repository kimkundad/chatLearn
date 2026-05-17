require('dotenv').config();
const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const admin = require('firebase-admin');
const serviceAccount = require('./learnsbuy-376d2-firebase-adminsdk-fbsvc-032bb1dcde.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
});

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: '*', 
        methods: ['GET', 'POST']
    }
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));


// 🔥 เชื่อมต่อฐานข้อมูล MySQL บน DigitalOcean
const db = mysql.createPool({
    connectionLimit: 10, // ✅ กำหนดจำนวน connection pool
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    waitForConnections: true,
    queueLimit: 0
});

// ✅ ตรวจสอบว่าการเชื่อมต่อฐานข้อมูลทำงานได้
db.getConnection((err, connection) => {
    if (err) {
        console.error('❌ Database Connection Failed:', err);
    } else {
        console.log('✅ MySQL Connected Successfully!');
        connection.release();
    }
});


// ✅ ฟังก์ชัน Handle Disconnect & Reconnect
function handleDisconnect() {
    db.getConnection((err, connection) => {
        if (err) {
            console.error('❌ Database Connection Lost:', err);
            setTimeout(handleDisconnect, 2000); // 🔄 ลองเชื่อมต่อใหม่ทุก 2 วินาที
        } else {
            console.log('✅ MySQL Reconnected!');
            connection.release();
        }
    });
}

// ✅ เรียกใช้การตรวจสอบเมื่อเซิร์ฟเวอร์เริ่มทำงาน
handleDisconnect();


// ✅ สร้าง table fcm_tokens ถ้ายังไม่มี
db.query(`
    CREATE TABLE IF NOT EXISTS fcm_tokens (
        user_id INT PRIMARY KEY,
        token VARCHAR(512) NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
`, (err) => {
    if (err) console.error('❌ fcm_tokens table error:', err);
    else console.log('✅ fcm_tokens table ready');
});

// ✅ บันทึก FCM token
app.post('/save-fcm-token', (req, res) => {
    const { user_id, fcm_token } = req.body;
    if (!user_id || !fcm_token) return res.status(400).json({ error: 'user_id and fcm_token required' });

    db.query(
        'INSERT INTO fcm_tokens (user_id, token) VALUES (?, ?) ON DUPLICATE KEY UPDATE token = ?, updated_at = NOW()',
        [user_id, fcm_token, fcm_token],
        (err) => {
            if (err) return res.status(500).json({ error: err });
            console.log(`✅ FCM token saved for user ${user_id}`);
            res.json({ success: true });
        }
    );
});

// ── ส่ง FCM notification ──────────────────────────────────────────────────
async function sendFcmToUser(userId, title, body) {
    return new Promise((resolve) => {
        db.query('SELECT token FROM fcm_tokens WHERE user_id = ?', [userId], async (err, rows) => {
            if (err || !rows.length) return resolve();
            try {
                await admin.messaging().send({
                    token: rows[0].token,
                    notification: { title, body },
                    android: {
                        priority: 'high',
                        notification: { sound: 'default', channelId: 'chat_channel' },
                    },
                });
                console.log(`✅ FCM sent to user ${userId}`);
            } catch (e) {
                console.error(`❌ FCM error for user ${userId}:`, e.message);
            }
            resolve();
        });
    });
}

// ✅ API สร้างห้องแชทใหม่หากยังไม่มี
app.post('/create-room', (req, res) => {
    const { student_id, teacher_id } = req.body;
    console.log('📩 Received request:', req.body);

    if (!student_id || !teacher_id) {
        console.log("❌ Missing student_id or teacher_id");
        return res.status(400).json({ error: "❌ student_id and teacher_id are required" });
    }

    db.getConnection((err, connection) => {
        if (err) {
            console.error("❌ Database Connection Failed:", err);
            return res.status(500).json({ error: "Database connection failed" });
        }

        connection.query(
            "SELECT id FROM chat_rooms WHERE student_id = ? AND teacher_id = ?",
            [student_id, teacher_id],
            (err, results) => {
                if (err) {
                    console.error("❌ Database Error:", err);
                    connection.release();
                    return res.status(500).json({ error: err });
                }

                if (results.length > 0) {
                    console.log("✅ Room already exists:", results[0].id);
                    connection.release();
                    return res.json({ room_id: results[0].id });
                }

                connection.query(
                    "INSERT INTO chat_rooms (student_id, teacher_id) VALUES (?, ?)",
                    [student_id, teacher_id],
                    (err, result) => {
                        connection.release();
                        if (err) {
                            console.error("❌ Database Error:", err);
                            return res.status(500).json({ error: err });
                        }
                        console.log("✅ Room created with ID:", result.insertId);
                        res.json({ room_id: result.insertId });
                    }
                );
            }
        );
    });
});



// 🔥 API ดึงประวัติแชทตามห้อง
app.get('/messages/:room_id', (req, res) => {
    const room_id = req.params.room_id;
    const sql = "SELECT * FROM messages WHERE room_id = ? ORDER BY created_at ASC";

    db.query(sql, [room_id], (err, results) => {
        if (err) return res.status(500).json({ error: err });
        res.json(results);
    });
});

// ✅ API ดึงรายชื่อนักเรียนที่เคยแชท (สำหรับครู id=1)
app.get('/students-chats', (req, res) => {
    const sql = `
        SELECT
            cr.id            AS room_id,
            cr.student_id,
            lm.message,
            lm.message_type,
            lm.media_url,
            lm.name,
            lm.avatar,
            lm.created_at,
            lm.sender_id     AS last_sender_id,
            COALESCE(uc.unread_count, 0) AS unread_count
        FROM chat_rooms cr
        JOIN messages lm
            ON lm.id = (
                SELECT id FROM messages
                WHERE room_id = cr.id
                ORDER BY created_at DESC
                LIMIT 1
            )
        LEFT JOIN (
            SELECT room_id, COUNT(*) AS unread_count
            FROM messages
            WHERE sender_id != 1 AND is_read = 0
            GROUP BY room_id
        ) uc ON uc.room_id = cr.id
        ORDER BY lm.created_at DESC`;

    db.query(sql, (err, results) => {
        if (err) {
            console.error('❌ Error fetching student chats:', err);
            return res.status(500).json({ error: 'Failed to fetch student chats' });
        }
        res.json(results);
    });
});




app.post('/mark-as-read', (req, res) => {
    const { room_id, teacher_id } = req.body;

    if (!room_id || !teacher_id) {
        return res.status(400).json({ error: "room_id และ teacher_id ต้องไม่ว่าง" });
    }

    const sql = `
        UPDATE messages 
        SET is_read = TRUE 
        WHERE room_id = ? AND sender_id != ? AND is_read = FALSE
    `;

    db.query(sql, [room_id, teacher_id], (err, result) => {
        if (err) {
            console.error("❌ Error updating read status:", err);
            return res.status(500).json({ error: "เกิดข้อผิดพลาดในการอัปเดตสถานะการอ่าน" });
        }

        console.log(`✅ Updated ${result.affectedRows} messages to read`);
        res.json({ success: true, updated: result.affectedRows });
    });
});




// 🔥 API ส่งข้อความ / รูปภาพ / เสียง
// text  : { room_id, sender_id, message, name, avatar }
// image : { room_id, sender_id, message_type:'image', media_url, name, avatar }
// audio : { room_id, sender_id, message_type:'audio', media_url, duration, name, avatar }
app.post('/send-message', (req, res) => {
    const {
        room_id, sender_id,
        message      = null,
        message_type = 'text',
        media_url    = null,
        duration     = null,
        name, avatar,
    } = req.body;

    if (!room_id || !sender_id) {
        return res.status(400).json({ error: 'room_id และ sender_id จำเป็น' });
    }
    if (message_type === 'text' && !message) {
        return res.status(400).json({ error: 'message จำเป็นสำหรับ type=text' });
    }
    if ((message_type === 'image' || message_type === 'audio') && !media_url) {
        return res.status(400).json({ error: 'media_url จำเป็นสำหรับ type=image/audio' });
    }

    const sql = `INSERT INTO messages
        (room_id, sender_id, message, message_type, media_url, duration, name, avatar)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

    db.query(sql, [room_id, sender_id, message, message_type, media_url, duration || null, name || null, avatar || null], (err, result) => {
        if (err) {
            console.error('❌ Error saving message:', err);
            return res.status(500).json({ error: 'Failed to save message' });
        }

        const messageData = {
            id: result.insertId,
            room_id: parseInt(room_id),
            sender_id: parseInt(sender_id),
            message,
            message_type,
            media_url: media_url || null,
            duration: duration ? parseInt(duration) : null,
            name: name || null,
            avatar: avatar || null,
        };
        io.to(room_id).emit('receiveMessage', messageData);
        res.json({ success: true, ...messageData });

        // ส่ง FCM ให้ผู้รับอีกฝั่ง
        db.query('SELECT student_id, teacher_id FROM chat_rooms WHERE id = ?', [room_id], async (err2, rooms) => {
            if (err2 || !rooms.length) return;
            const { student_id, teacher_id } = rooms[0];
            const recipientId = parseInt(sender_id) === teacher_id ? student_id : teacher_id;
            const notifBody = message_type === 'text'
                ? (message || '')
                : message_type === 'image' ? '📷 รูปภาพ'
                : message_type === 'audio' ? '🎙️ ข้อความเสียง'
                : 'ข้อความใหม่';
            await sendFcmToUser(recipientId, name || 'ข้อความใหม่', notifBody);
        });
    });
});


// 🔥 Socket.io สำหรับ Real-time Chat
io.on('connection', socket => {
    console.log(`🔥 New client connected: ${socket.id}`);

    // ผู้ใช้เข้าร่วมห้องแชท
    socket.on('joinRoom', (room_id) => {
        socket.join(room_id);
        console.log(`👤 User joined room: ${room_id}`);
    });

    // รับข้อความและบันทึกลง MySQL
    socket.on('sendMessage', (messageData) => {
        console.log('📩 Message received:', messageData);

        const { room_id, sender_id, message, name, avatar } = messageData;
        const sql = "INSERT INTO messages (room_id, sender_id, message, name) VALUES (?, ?, ?, ?, ?)";

        db.query(sql, [room_id, sender_id, message, name, avatar], (err, result) => {
            if (err) {
                console.error('❌ Error saving message:', err);
                return;
            }
            console.log('✅ Message saved to DB');
        });

        // 🔥 ส่งข้อความกลับไปที่ห้องแชทนั้น
        io.to(room_id).emit('receiveMessage', messageData);
    });

    socket.on('disconnect', () => {
        console.log(`❌ Client disconnected: ${socket.id}`);
    });
});

// ── แจ้งเตือนอนุมัติคำสั่งซื้อ (เรียกจาก Laravel admin) ──────────────────────
app.post('/notify-approved', async (req, res) => {
    const { user_id, title, body } = req.body;
    if (!user_id) return res.json({ status: 400, message: 'user_id required' });
    try {
        await sendFcmToUser(
            user_id,
            title  || 'คำสั่งซื้อได้รับการอนุมัติ ✅',
            body   || 'คอร์สเรียนพร้อมให้เข้าเรียนแล้ว'
        );
        res.json({ status: 200, message: 'ok' });
    } catch (e) {
        res.json({ status: 500, message: e.message });
    }
});

// 🔥 เปิดเซิร์ฟเวอร์
server.listen(3006, () => {
    console.log('🚀 Server running on port 3001');
});
