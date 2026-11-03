const express = require('express');
const mysql   = require('mysql2/promise');
const bcrypt  = require('bcrypt');
const cors    = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const SALT_ROUNDS = 10;

// How many books each membership type may have on loan at once
const LOAN_LIMITS = { student: 5, staff: 10, public: 3 };

// Health check endpoint (required for Docker Compose)
app.get('/health', (req, res) =>
  res.json({ status: 'ok', service: 'member-service', port: 3001 })
);

// MySQL connection (members table only)
const db = mysql.createPool({
  host:     process.env.DB_HOST || 'db',
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  const { email, password, full_name, phone } = req.body;
  const membership_type = req.body.membership_type || 'student';

  if (!email || !password || !full_name) {
    return res.status(400).json({ error: 'Email, password, and full name are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (!LOAN_LIMITS[membership_type]) {
    return res.status(400).json({ error: 'membership_type must be student, staff or public' });
  }

  try {
    const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
    const [result] = await db.query(
      `INSERT INTO members (email, password_hash, full_name, phone, membership_type, max_loans)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [email, password_hash, full_name, phone || null, membership_type, LOAN_LIMITS[membership_type]]
    );
    res.status(201).json({
      message:   'Library membership created',
      memberId:  result.insertId,
      maxLoans:  LOAN_LIMITS[membership_type]
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Email already registered' });
    }
    console.error('Registration error:', err.message);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const [rows] = await db.query(
      'SELECT id, email, password_hash, full_name, membership_type FROM members WHERE email = ?',
      [email]
    );
    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const member = rows[0];
    const match = await bcrypt.compare(password, member.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    res.json({
      message:        'Login successful',
      memberId:       member.id,
      fullName:       member.full_name,
      email:          member.email,
      membershipType: member.membership_type
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/members/:id
// Used by loan-service to check the member exists and read their loan limit.
app.get('/api/members/:id', async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT id, email, full_name, phone, membership_type, max_loans, joined_at
       FROM members WHERE id = ?`,
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Member not found' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('Get member error:', err.message);
    res.status(500).json({ error: 'Failed to fetch member' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () =>
  console.log(`[member-service] Running on http://localhost:${PORT}`)
);
