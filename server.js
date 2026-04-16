require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 7890;

// ─── Database ────────────────────────────────────────────────────────────────
// Database pool - handles both Neon (Railway) and local
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('neon.tech')
    ? { rejectUnauthorized: false }
    : process.env.DATABASE_URL && process.env.DATABASE_URL.includes('supabase')
    ? { rejectUnauthorized: false }
    : false
});

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));
// Trust Railway's proxy (required for HTTPS cookies on Railway)
app.set('trust proxy', 1);
app.use(session({
  secret: process.env.SESSION_SECRET || 'urban_hairplaza_secret_key_2025',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // HTTPS on Railway, HTTP locally
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));
app.use(express.static(path.join(__dirname)));

// ─── DB Init ─────────────────────────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS services (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      price INTEGER DEFAULT 0,
      duration INTEGER DEFAULT 0,
      "desc" TEXT DEFAULT '',
      icon TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      type TEXT DEFAULT 'inshop',
      service TEXT NOT NULL,
      barber TEXT DEFAULT 'Best Available',
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      address TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      price INTEGER DEFAULT 0,
      duration INTEGER DEFAULT 0,
      advance_paid INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS enquiries (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT DEFAULT '',
      subject TEXT DEFAULT 'General Inquiry',
      message TEXT NOT NULL,
      status TEXT DEFAULT 'unread',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ
    );
  `);

  // Seed services
  const { rows } = await pool.query('SELECT COUNT(*) FROM services');
  if (parseInt(rows[0].count) === 0) {
    const services = [
      { id: genId(), type: 'inshop', name: 'Classic Haircut', price: 150, duration: 30, desc: 'A timeless cut tailored to your face shape by our master barbers.', icon: '✂️' },
      { id: genId(), type: 'inshop', name: 'Beard Trim & Shape-Up', price: 200, duration: 20, desc: 'Precision beard grooming with straight-razor cleanup.', icon: '🪒' },
      { id: genId(), type: 'inshop', name: 'Royal Shave', price: 250, duration: 30, desc: 'Hot towel, pre-shave oil, and a complete straight-razor shave.', icon: '👑' },
      { id: genId(), type: 'inshop', name: 'Haircut + Beard Combo', price: 500, duration: 50, desc: 'The complete grooming experience — haircut and beard styling.', icon: '💈' },
      { id: genId(), type: 'inshop', name: 'Head Shave', price: 400, duration: 30, desc: 'Complete head shave with hot towel finish.', icon: '🪄' },
      { id: genId(), type: 'home', name: 'Classic Haircut (Home)', price: 250, duration: 30, desc: 'Our signature haircut brought to your doorstep.', icon: '✂️' },
      { id: genId(), type: 'home', name: 'Beard Trim (Home)', price: 350, duration: 20, desc: 'Professional beard trimming at your home.', icon: '🪒' },
      { id: genId(), type: 'home', name: 'Royal Shave (Home)', price: 400, duration: 30, desc: 'Luxury shaving experience at your home.', icon: '👑' },
      { id: genId(), type: 'home', name: 'Haircut + Beard Combo (Home)', price: 500, duration: 50, desc: 'Full grooming combo at home.', icon: '💈' },
      { id: genId(), type: 'home', name: 'Kids Haircut (Home)', price: 200, duration: 25, desc: 'Fun and comfortable haircuts for kids at home.', icon: '🧒' },
    ];
    for (const s of services) {
      await pool.query(
        'INSERT INTO services (id, type, name, price, duration, "desc", icon) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [s.id, s.type, s.name, s.price, s.duration, s.desc, s.icon]
      );
    }
    console.log('✅ Services seeded');
  }
  console.log('✅ Database ready');
}

function genId() { return uuidv4().replace(/-/g, '').substring(0, 8).toUpperCase(); }

// ─── Helpers ─────────────────────────────────────────────────────────────────
async function sendWhatsApp(msg) {
  if (!process.env.WHATSAPP_APIKEY) return;
  try {
    await axios.get('https://api.callmebot.com/whatsapp.php', {
      params: { phone: process.env.WHATSAPP_PHONE, text: msg, apikey: process.env.WHATSAPP_APIKEY }
    });
  } catch (e) { console.error('WhatsApp error:', e.message); }
}

async function sendSMS(to, msg) {
  if (!process.env.TWILIO_ACCOUNT_SID) return;
  try {
    const phone = to.replace(/\D/g, '');
    const e164 = phone.length === 10 ? '+91' + phone : '+' + phone;
    const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
      new URLSearchParams({ To: e164, From: process.env.TWILIO_PHONE_NUMBER, Body: msg }),
      { headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
  } catch (e) { console.error('SMS error:', e.message); }
}

// ─── Admin Middleware ─────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  res.status(401).json({ error: 'Unauthorized' });
}
function requireUser(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/services
app.get('/api/services', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM services ORDER BY type, name');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/available-slots?date=YYYY-MM-DD
app.get('/api/available-slots', async (req, res) => {
  try {
    const { date } = req.query;
    const { rows } = await pool.query(
      `SELECT time, COUNT(*) as cnt FROM bookings WHERE date=$1 AND status != 'cancelled' GROUP BY time HAVING COUNT(*) >= 3`,
      [date]
    );
    res.json({ bookedTimes: rows.map(r => r.time) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/bookings
app.post('/api/bookings', async (req, res) => {
  try {
    const { type, service, barber, date, time, name, phone, address, notes, price, duration } = req.body;
    const id = genId();
    await pool.query(
      `INSERT INTO bookings (id, type, service, barber, date, time, name, phone, address, notes, price, duration)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, type || 'inshop', service, barber || 'Best Available', date, time, name, phone, address || '', notes || '', parseInt(price) || 0, parseInt(duration) || 0]
    );
    // Link to user if logged in
    if (req.session.userId) {
      await pool.query('UPDATE bookings SET user_id=$1 WHERE id=$2', [req.session.userId, id]).catch(() => {});
    }
    const msg = `🔔 *NEW BOOKING – Urban Hairplaza*\n━━━━━━━━━━━━━━━━━━━━━\n👤 *Client:* ${name}\n📱 *Phone:* ${phone}\n✂️ *Service:* ${service}\n💈 *Barber:* ${barber || 'Best Available'}\n📅 *Date:* ${date}\n⏰ *Time:* ${time}\n🏷️ *Type:* ${type === 'home' ? '🏠 Home Visit' : '🏢 In-Shop'}\n💰 *Price:* ₹${price}\n━━━━━━━━━━━━━━━━━━━━━\n📌 Booking ID: ${id}`;
    sendWhatsApp(msg);
    sendSMS(phone, `Dear ${name}, your booking at Urban Hairplaza is received! Booking ID: #${id}. Service: ${service} on ${date} at ${time}. Total: ₹${price}. We will confirm your appointment shortly.`);
    res.json({ success: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/create-order
app.post('/api/create-order', async (req, res) => {
  try {
    const { advanceAmount, bookingDetails } = req.body;
    const orderId = 'UHP-' + genId();
    // Store pending booking
    const { type, service, barber, date, time, name, phone, address, notes, price, duration } = bookingDetails;
    const bookingId = genId();
    await pool.query(
      `INSERT INTO bookings (id, type, service, barber, date, time, name, phone, address, notes, price, duration, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'payment_pending')`,
      [bookingId, type || 'inshop', service, barber || 'Best Available', date, time, name, phone, address || '', notes || '', parseInt(price) || 0, parseInt(duration) || 0]
    );

    const cfRes = await axios.post(
      'https://api.cashfree.com/pg/orders',
      {
        order_id: orderId,
        order_amount: advanceAmount,
        order_currency: 'INR',
        customer_details: { customer_id: 'UHP' + bookingId, customer_phone: phone, customer_name: name },
        order_meta: { return_url: `${(process.env.CASHFREE_RETURN_URL || process.env.BASE_URL).replace("http://","https://")}/book.html?payment=success&order_id=${orderId}&booking_id=${bookingId}`, notify_url: undefined }
      },
      {
        headers: {
          'x-client-id': process.env.CASHFREE_APP_ID,
          'x-client-secret': process.env.CASHFREE_SECRET_KEY,
          'x-api-version': '2023-08-01',
          'Content-Type': 'application/json'
        }
      }
    );
    res.json({ paymentSessionId: cfRes.data.payment_session_id, orderId, bookingId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/verify-payment
app.post('/api/verify-payment', async (req, res) => {
  try {
    const { order_id, booking_id, advance_amount } = req.body;
    const cfRes = await axios.get(
      `https://api.cashfree.com/pg/orders/${order_id}`,
      { headers: { 'x-client-id': process.env.CASHFREE_APP_ID, 'x-client-secret': process.env.CASHFREE_SECRET_KEY, 'x-api-version': '2023-08-01' } }
    );
    const status = cfRes.data.order_status;
    if (status === 'PAID') {
      await pool.query(
        `UPDATE bookings SET status='pending', advance_paid=$1, updated_at=NOW() WHERE id=$2`,
        [parseInt(advance_amount) || 0, booking_id]
      );
      const { rows } = await pool.query('SELECT * FROM bookings WHERE id=$1', [booking_id]);
      if (rows[0]) {
        const b = rows[0];
        const msg = `💸 *PAYMENT RECEIVED – Urban Hairplaza*\n━━━━━━━━━━━━━━━━━━━━━\n👤 *Client:* ${b.name}\n✂️ *Service:* ${b.service}\n📅 *Date:* ${b.date}\n⏰ *Time:* ${b.time}\n💰 *Advance Paid:* ₹${b.advance_paid}\n📌 Booking ID: ${b.id}`;
        sendWhatsApp(msg);
        sendSMS(b.phone, `Hi ${b.name}, payment of ₹${b.advance_paid} received for booking #${b.id}. Your appointment is on ${b.date} at ${b.time}.`);
      }
      res.json({ success: true, status: 'PAID' });
    } else {
      res.json({ success: false, status });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/enquiries
app.post('/api/enquiries', async (req, res) => {
  try {
    const { name, phone, email, subject, message } = req.body;
    const id = genId();
    await pool.query(
      'INSERT INTO enquiries (id, name, phone, email, subject, message) VALUES ($1,$2,$3,$4,$5,$6)',
      [id, name, phone, email || '', subject || 'General Inquiry', message]
    );
    const msg = `📩 *NEW ENQUIRY – Urban Hairplaza*\n━━━━━━━━━━━━━━━━━━━━━\n👤 *Name:* ${name}\n📱 *Phone:* ${phone}\n📧 *Email:* ${email || 'N/A'}\n📌 *Subject:* ${subject || 'General Inquiry'}\n💬 *Message:* ${message}\n━━━━━━━━━━━━━━━━━━━━━\nID: ${id}`;
    sendWhatsApp(msg);
    res.json({ success: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/visualize
app.post('/api/visualize', async (req, res) => {
  try {
    const { imageBase64, style } = req.body;
    if (!process.env.OPENAI_API_KEY) return res.status(400).json({ error: 'OpenAI not configured' });
    // Step 1: GPT-4o analyze face
    const visionRes = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Analyze this person\'s face shape, skin tone, and facial features in 2-3 sentences max. Be objective and descriptive.' },
            { type: 'image_url', image_url: { url: imageBase64.startsWith('data:') ? imageBase64 : `data:image/jpeg;base64,${imageBase64}` } }
          ]
        }],
        max_tokens: 150
      },
      { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' } }
    );
    const faceDescription = visionRes.data.choices[0].message.content;
    // Step 2: DALL-E 3 generate
    const dalleRes = await axios.post(
      'https://api.openai.com/v1/images/generations',
      {
        model: 'dall-e-3',
        prompt: `A photorealistic, high-end studio portrait photograph of a person with exactly these facial features: '${faceDescription}'. They are now sporting a brand new, highly detailed '${style}' hairstyle. The lighting is premium barbershop lighting, front-facing view, perfect realism.`,
        n: 1,
        size: '1024x1024'
      },
      { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' } }
    );
    res.json({ imageUrl: dalleRes.data.data[0].url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/auth/send-otp
app.post('/api/auth/send-otp', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone || phone.length !== 10) return res.status(400).json({ error: 'Invalid phone number' });
    // Check cooldown
    if (req.session.otpCooldown && Date.now() < req.session.otpCooldown) {
      return res.status(429).json({ error: 'Please wait before requesting another OTP' });
    }
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    req.session.otp = otp;
    req.session.otpPhone = phone;
    req.session.otpExpires = Date.now() + 5 * 60 * 1000;
    req.session.otpCooldown = Date.now() + 60 * 1000;
    // Check if new user
    const { rows } = await pool.query('SELECT id, name FROM users WHERE phone=$1', [phone]);
    const isNew = rows.length === 0;
    // Send SMS
    await sendSMS(phone, `Your Urban Hairplaza OTP is: ${otp}. Valid for 5 minutes. Do not share with anyone.`);
    res.json({ success: true, isNew });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auth/verify-otp
app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { phone, otp, name } = req.body;
    if (!req.session.otp || req.session.otp !== otp) return res.status(400).json({ error: 'Invalid OTP' });
    if (Date.now() > req.session.otpExpires) return res.status(400).json({ error: 'OTP expired' });
    if (req.session.otpPhone !== phone) return res.status(400).json({ error: 'Phone mismatch' });
    let user;
    const { rows } = await pool.query('SELECT * FROM users WHERE phone=$1', [phone]);
    if (rows.length > 0) {
      user = rows[0];
    } else {
      if (!name) return res.status(400).json({ error: 'Name required for new users' });
      const id = 'USR-' + genId();
      await pool.query('INSERT INTO users (id, name, phone) VALUES ($1,$2,$3)', [id, name, phone]);
      user = { id, name, phone };
    }
    req.session.userId = user.id;
    req.session.userName = user.name;
    req.session.userPhone = user.phone;
    delete req.session.otp;
    delete req.session.otpPhone;
    delete req.session.otpExpires;
    res.json({ success: true, user: { id: user.id, name: user.name, phone: user.phone } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/auth/me
app.get('/api/auth/me', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [req.session.userId]);
    if (!rows[0]) return res.status(401).json({ error: 'User not found' });
    const stats = await pool.query(
      `SELECT COUNT(*) as total, SUM(CASE WHEN status='pending' OR status='confirmed' THEN 1 ELSE 0 END) as upcoming, SUM(price) as spent FROM bookings WHERE phone=$1`,
      [rows[0].phone]
    );
    res.json({ user: rows[0], stats: stats.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auth/logout
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// GET /api/user/bookings
app.get('/api/user/bookings', requireUser, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM bookings WHERE phone=$1 ORDER BY created_at DESC',
      [req.session.userPhone]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/admin/login
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

// POST /api/admin/logout
app.post('/api/admin/logout', (req, res) => {
  req.session.isAdmin = false;
  res.json({ success: true });
});

// GET /api/admin/me
app.get('/api/admin/me', requireAdmin, (req, res) => res.json({ ok: true }));

// GET /api/admin/stats
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  try {
    const b = await pool.query('SELECT status, SUM(advance_paid) as revenue, COUNT(*) as cnt FROM bookings GROUP BY status');
    const e = await pool.query('SELECT status, COUNT(*) as cnt FROM enquiries GROUP BY status');
    const stats = {
      bookings: { total: 0, pending: 0, confirmed: 0, cancelled: 0, payment_pending: 0, revenue: 0 },
      enquiries: { total: 0, unread: 0, read: 0, replied: 0 }
    };
    b.rows.forEach(r => {
      stats.bookings.total += parseInt(r.cnt);
      stats.bookings[r.status] = parseInt(r.cnt);
      stats.bookings.revenue += parseInt(r.revenue) || 0;
    });
    e.rows.forEach(r => {
      stats.enquiries.total += parseInt(r.cnt);
      stats.enquiries[r.status] = parseInt(r.cnt);
    });
    res.json(stats);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/bookings
app.get('/api/admin/bookings', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM bookings ORDER BY created_at DESC');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/admin/bookings/:id
app.patch('/api/admin/bookings/:id', requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    await pool.query('UPDATE bookings SET status=$1, updated_at=NOW() WHERE id=$2', [status, req.params.id]);
    const { rows } = await pool.query('SELECT * FROM bookings WHERE id=$1', [req.params.id]);
    const b = rows[0];
    if (b && status === 'confirmed') {
      sendSMS(b.phone, `Hi ${b.name}, GREAT NEWS! Your appointment at Urban Hairplaza is CONFIRMED. ID: #${b.id}. Service: ${b.service} on ${b.date} at ${b.time} with ${b.barber}. See you soon!`);
      sendWhatsApp(`✅ *BOOKING CONFIRMED – #${b.id}*\n👤 ${b.name} | ✂️ ${b.service} | 📅 ${b.date} ${b.time}`);
    } else if (b && status === 'cancelled') {
      sendSMS(b.phone, `Hi ${b.name}, your booking #${b.id} at Urban Hairplaza has been cancelled. Contact us at +91 6202 692 426 for rescheduling.`);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/admin/bookings/:id
app.delete('/api/admin/bookings/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM bookings WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/enquiries
app.get('/api/admin/enquiries', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM enquiries ORDER BY created_at DESC');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/admin/enquiries/:id
app.patch('/api/admin/enquiries/:id', requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    await pool.query('UPDATE enquiries SET status=$1, updated_at=NOW() WHERE id=$2', [status, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/admin/enquiries/:id
app.delete('/api/admin/enquiries/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM enquiries WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/services
app.post('/api/admin/services', requireAdmin, async (req, res) => {
  try {
    const { type, name, price, duration, desc, icon } = req.body;
    const id = genId();
    await pool.query(
      'INSERT INTO services (id, type, name, price, duration, "desc", icon) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, type, name, parseInt(price) || 0, parseInt(duration) || 0, desc || '', icon || '✂️']
    );
    res.json({ success: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/admin/services/:id
app.put('/api/admin/services/:id', requireAdmin, async (req, res) => {
  try {
    const { type, name, price, duration, desc, icon } = req.body;
    await pool.query(
      'UPDATE services SET type=$1, name=$2, price=$3, duration=$4, "desc"=$5, icon=$6 WHERE id=$7',
      [type, name, parseInt(price) || 0, parseInt(duration) || 0, desc || '', icon || '✂️', req.params.id]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/admin/services/:id
app.delete('/api/admin/services/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM services WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Start ────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 Urban Hairplaza running on http://localhost:${PORT}`));
}).catch(err => {
  console.error('DB init failed:', err.message);
  process.exit(1);
});







