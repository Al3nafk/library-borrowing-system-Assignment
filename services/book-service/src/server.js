const express = require('express');
const mysql   = require('mysql2/promise');
const cors    = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) =>
  res.json({ status: 'ok', service: 'book-service', port: 3002 })
);

const db = mysql.createPool({
  host:     process.env.DB_HOST || 'db',
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// GET /api/books           -> whole catalogue
// GET /api/books?q=orwell  -> search title, author or ISBN
app.get('/api/books', async (req, res) => {
  try {
    const { q } = req.query;
    let rows;
    if (q) {
      const like = `%${q}%`;
      [rows] = await db.query(
        'SELECT * FROM books WHERE title LIKE ? OR author LIKE ? OR isbn LIKE ? ORDER BY title',
        [like, like, like]
      );
    } else {
      [rows] = await db.query('SELECT * FROM books ORDER BY genre, title');
    }
    res.json(rows);
  } catch (err) {
    console.error('Catalogue error:', err.message);
    res.status(500).json({ error: 'Failed to fetch books' });
  }
});

// GET /api/books/genre/:genre
app.get('/api/books/genre/:genre', async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT * FROM books WHERE genre = ? ORDER BY title',
      [req.params.genre]
    );
    res.json(rows);
  } catch (err) {
    console.error('Genre error:', err.message);
    res.status(500).json({ error: 'Failed to fetch genre' });
  }
});

// GET /api/books/:id
app.get('/api/books/:id', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM books WHERE id = ?', [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Book not found' });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('Book error:', err.message);
    res.status(500).json({ error: 'Failed to fetch book' });
  }
});

// PATCH /api/books/:id/copies   body: { change: -1 | 1 }
// Called by loan-service: -1 when a copy is borrowed, +1 when it is returned.
// The WHERE clause makes the update atomic, so two members can never take
// the last copy at the same time, and copies never go below 0 or above total.
app.patch('/api/books/:id/copies', async (req, res) => {
  const change = Number(req.body.change);
  if (change !== -1 && change !== 1) {
    return res.status(400).json({ error: 'change must be -1 (borrow) or 1 (return)' });
  }

  try {
    const [result] = await db.query(
      `UPDATE books SET available_copies = available_copies + ?
       WHERE id = ? AND available_copies + ? BETWEEN 0 AND total_copies`,
      [change, req.params.id, change]
    );
    if (result.affectedRows === 0) {
      return res.status(409).json({
        error: change === -1 ? 'No copies available' : 'All copies are already on the shelf'
      });
    }
    const [rows] = await db.query(
      'SELECT id, title, available_copies, total_copies FROM books WHERE id = ?',
      [req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('Update copies error:', err.message);
    res.status(500).json({ error: 'Failed to update copies' });
  }
});

// ===== RATING VALIDATION (for book reviews) =====
function validateRating(rating) {
  if (rating === undefined || rating === null) {
    return { valid: false, error: 'Rating is required' };
  }
  if (typeof rating !== 'number') {
    return { valid: false, error: 'Rating must be a number' };
  }
  if (!Number.isInteger(rating)) {
    return { valid: false, error: 'Rating must be a whole number' };
  }
  if (rating < 1 || rating > 5) {
    return { valid: false, error: 'Rating must be between 1 and 5' };
  }
  return { valid: true };
}

// ===== START SERVER (skip during tests) =====
// Jest sets NODE_ENV=test automatically, only start listening otherwise
const PORT = process.env.PORT || 3002;
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () =>
    console.log(`[book-service] Running on http://localhost:${PORT}`)
  );
}

// ===== EXPORT FOR TESTING =====
// Only exports when Jest sets NODE_ENV=test
// Production server is unaffected
if (process.env.NODE_ENV === 'test') {
  module.exports = { validateRating };
}
