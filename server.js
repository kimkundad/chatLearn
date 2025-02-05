require('dotenv').config();
const express = require('express');
const mysql = require('mysql2'); // ✅ ใช้ mysql2 แทน
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

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
app.use(express.urlencoded({ extended: true })); // ✅ รองรับ Form Data

// 🔥 เชื่อมต่อฐานข้อมูล MySQL บน DigitalOcean
const db = mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    ssl: { rejectUnauthorized: false } // ✅ ใช้ SSL ในการเชื่อมต่อ
});

// 🔥 ตรวจสอบการเชื่อมต่อ
db.connect(err => {
    if (err) {
        console.error('❌ MySQL Connection Failed:', err);
    } else {
        console.log('✅ MySQL Connected to DigitalOcean!');
    }
});

// 🔥 API สร้างห้องแชทใหม่หากยังไม่มี
// ✅ API สร้างห้องแชทใหม่หากยังไม่มี
app.post('/create-room', async (req, res) => {
    const { student_id, teacher_id } = req.body;
    console.log('📩 Received request:', req.body);

    if (!student_id || !teacher_id) {
        console.log("❌ Missing student_id or teacher_id");
        return res.status(400).json({ error: "❌ student_id and teacher_id are required" });
    }

    try {
        const [existingRooms] = await db.promise().query(
            "SELECT id FROM chat_rooms WHERE student_id = ? AND teacher_id = ?",
            [student_id, teacher_id]
        );

        if (existingRooms.length > 0) {
            console.log("✅ Room already exists:", existingRooms[0].id);
            return res.json({ room_id: existingRooms[0].id });
        }

        // ✅ สร้างห้องใหม่
        const [result] = await db.promise().query(
            "INSERT INTO chat_rooms (student_id, teacher_id) VALUES (?, ?)",
            [student_id, teacher_id]
        );

        console.log("✅ Room created with ID:", result.insertId);
        res.json({ room_id: result.insertId });

    } catch (err) {
        console.error("❌ Database Error:", err);
        res.status(500).json({ error: err });
    }
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

// ✅ API ดึงรายชื่อนักเรียนที่เคยแชท (ยกเว้นคุณครู)
app.get('/students-chats', (req, res) => {
    const sql = `
        SELECT 
            cr.student_id, 
            m.message, 
            m.name, 
            m.avatar, 
            m.created_at, 
            m.is_read,  -- ✅ เพิ่ม is_read
            cr.id AS room_id, 
            cr.teacher_id
        FROM chat_rooms cr
        JOIN messages m 
            ON cr.id = m.room_id
            AND m.created_at = (
                SELECT MAX(created_at) 
                FROM messages 
                WHERE messages.room_id = cr.id 
                AND messages.sender_id != 1
            )
        ORDER BY m.is_read ASC, m.created_at DESC`;

    db.query(sql, (err, results) => {
        if (err) {
            console.error("❌ Error fetching student chats:", err);
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



// 🔥 API ส่งข้อความ
app.post('/send-message', (req, res) => {
    const { room_id, sender_id, message, name, avatar } = req.body;
    const sql = "INSERT INTO messages (room_id, sender_id, message, name, avatar) VALUES (?, ?, ?, ?, ?)";

    db.query(sql, [room_id, sender_id, message, name, avatar], (err, result) => {
        if (err) {
            console.error('❌ Error saving message:', err);
            return res.status(500).json({ error: 'Failed to save message' });
        }

        console.log('✅ Message saved to DB');

        // ✅ ให้เซิร์ฟเวอร์ส่งข้อความไปยัง Socket.io
        const messageData = { room_id, sender_id, message, name, avatar };
        io.to(room_id).emit('receiveMessage', messageData);

        res.json({ success: 'Message sent successfully' });
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

// 🔥 เปิดเซิร์ฟเวอร์
server.listen(3006, () => {
    console.log('🚀 Server running on port 3001');
});
