const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const redis   = require('redis');
const cors    = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const BASKET_TTL         = parseInt(process.env.BASKET_TTL || '1800', 10);   // 30 min
const LOAN_DAYS          = parseInt(process.env.LOAN_DAYS || '14', 10);
const LATE_FEE_PER_DAY   = parseFloat(process.env.LATE_FEE_PER_DAY || '0.50'); // RM per book per day
const MEMBER_SERVICE_URL = process.env.MEMBER_SERVICE_URL || 'http://member-service:3001';
const BOOK_SERVICE_URL   = process.env.BOOK_SERVICE_URL   || 'http://book-service:3002';
const DAY_MS = 24 * 60 * 60 * 1000;

app.get('/health', (req, res) =>
  res.json({ status: 'ok', service: 'loan-service', port: 3003 })
);

// MongoDB connection (loans), retries until Mongo is ready
const MONGO_URL = process.env.MONGO_URL || 'mongodb://mongo:27017';
const mongoClient = new MongoClient(MONGO_URL);
let loansDb = null;

async function connectMongo() {
  for (let i = 1; i <= 20; i++) {
    try {
      await mongoClient.connect();
      loansDb = mongoClient.db(process.env.MONGO_DB || 'library_db');
      console.log('[loan-service] MongoDB connected');
      return;
    } catch (err) {
      console.log(`[loan-service] MongoDB not ready (attempt ${i}): ${err.message}`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  console.error('[loan-service] MongoDB connection failed');
}
connectMongo();

// Redis connection (borrow basket)
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const redisClient = redis.createClient({ url: REDIS_URL });
redisClient.on('error', err => console.error('[loan-service] Redis error:', err.message));
redisClient.connect().then(() => console.log('[loan-service] Redis connected'));

// ===== Helpers =====
const basketKey = (memberId) => `basket:member${memberId}`;

async function readBasket(memberId) {
  const raw = await redisClient.get(basketKey(memberId));
  return raw ? JSON.parse(raw) : { books: [] };
}

// Cross-service call: ask book-service for one book
async function fetchBook(bookId) {
  const res = await fetch(`${BOOK_SERVICE_URL}/api/books/${bookId}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('Book Service error');
  return res.json();
}

// Cross-service call: borrow (-1) or return (+1) one copy
async function changeCopies(bookId, change) {
  const res = await fetch(`${BOOK_SERVICE_URL}/api/books/${bookId}/copies`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ change })
  });
  return res.ok;
}

// Number of books this member has out right now
async function booksOnLoan(memberId) {
  const active = await loansDb.collection('loans')
    .find({ memberId: Number(memberId), status: 'borrowed' })
    .toArray();
  return active.reduce((sum, loan) => sum + loan.books.length, 0);
}

// Adds isOverdue / daysOverdue so the client can show late loans
function withOverdue(loan) {
  const late = loan.status === 'borrowed' && new Date() > loan.dueDate;
  return {
    ...loan,
    isOverdue: late,
    daysOverdue: late ? Math.ceil((Date.now() - loan.dueDate) / DAY_MS) : 0
  };
}

// ===== Basket (Redis) =====

// GET /api/basket/:memberId
app.get('/api/basket/:memberId', async (req, res) => {
  try {
    res.json(await readBasket(req.params.memberId));
  } catch (err) {
    console.error('Get basket error:', err.message);
    res.status(500).json({ error: 'Failed to fetch basket' });
  }
});

// POST /api/basket/:memberId/books   body: { bookId }
app.post('/api/basket/:memberId/books', async (req, res) => {
  const { bookId } = req.body;
  if (!bookId) {
    return res.status(400).json({ error: 'bookId is required' });
  }

  try {
    const book = await fetchBook(bookId);
    if (!book) {
      return res.status(404).json({ error: 'Book not found' });
    }
    if (book.available_copies < 1) {
      return res.status(409).json({ error: `"${book.title}" has no copies on the shelf` });
    }

    const key = basketKey(req.params.memberId);
    const basket = await readBasket(req.params.memberId);

    // A member borrows one copy of a title, not several
    if (basket.books.some(b => b.bookId === book.id)) {
      return res.status(409).json({ error: `"${book.title}" is already in your basket` });
    }

    basket.books.push({ bookId: book.id, isbn: book.isbn, title: book.title, author: book.author });
    await redisClient.set(key, JSON.stringify(basket), { EX: BASKET_TTL });
    res.status(201).json(basket);
  } catch (err) {
    console.error('Add to basket error:', err.message);
    res.status(500).json({ error: 'Failed to update basket' });
  }
});

// DELETE /api/basket/:memberId/books/:bookId
app.delete('/api/basket/:memberId/books/:bookId', async (req, res) => {
  try {
    const key = basketKey(req.params.memberId);
    const basket = await readBasket(req.params.memberId);
    basket.books = basket.books.filter(b => b.bookId !== Number(req.params.bookId));
    await redisClient.set(key, JSON.stringify(basket), { EX: BASKET_TTL });
    res.json(basket);
  } catch (err) {
    console.error('Remove from basket error:', err.message);
    res.status(500).json({ error: 'Failed to update basket' });
  }
});

// ===== Loans (MongoDB) =====

// POST /api/loans   body: { memberId }
// Checks out every book in the member's Redis basket.
app.post('/api/loans', async (req, res) => {
  const { memberId } = req.body;

  if (!memberId) {
    return res.status(400).json({ error: 'memberId is required' });
  }
  if (!loansDb) {
    return res.status(503).json({ error: 'Loan database not ready' });
  }

  // Cross-service call: verify the member exists in Member Service
  let member;
  try {
    const memberRes = await fetch(`${MEMBER_SERVICE_URL}/api/members/${memberId}`);
    if (!memberRes.ok) {
      return res.status(404).json({
        error: 'Member not found',
        hint: 'Loan Service checked Member Service'
      });
    }
    member = await memberRes.json();
  } catch (err) {
    return res.status(503).json({ error: 'Member Service unreachable' });
  }

  try {
    const { books } = await readBasket(memberId);
    if (!books.length) {
      return res.status(400).json({ error: 'Basket is empty' });
    }

    // Loan limit: books already out + books being borrowed now
    const current = await booksOnLoan(memberId);
    if (current + books.length > member.max_loans) {
      return res.status(409).json({
        error: `Loan limit reached: ${member.membership_type} members may borrow ${member.max_loans} books`,
        onLoan: current,
        requested: books.length
      });
    }

    // Take one copy of each book. If any book has run out, put back
    // the copies already taken so the catalogue stays correct.
    const taken = [];
    for (const book of books) {
      if (await changeCopies(book.bookId, -1)) {
        taken.push(book);
      } else {
        for (const t of taken) await changeCopies(t.bookId, 1);
        return res.status(409).json({ error: `"${book.title}" is no longer available` });
      }
    }

    const now = new Date();
    const loan = {
      memberId: Number(memberId),
      memberName: member.full_name,
      books,
      borrowedAt: now,
      dueDate: new Date(now.getTime() + LOAN_DAYS * DAY_MS),
      status: 'borrowed',
      returnedAt: null,
      lateFee: 0,
      statusHistory: [{ status: 'borrowed', at: now }]
    };

    const result = await loansDb.collection('loans').insertOne(loan);
    await redisClient.del(basketKey(memberId));

    res.status(201).json({
      message: 'Books checked out',
      loanId: result.insertedId,
      dueDate: loan.dueDate,
      books: books.map(b => b.title)
    });
  } catch (err) {
    console.error('Create loan error:', err.message);
    res.status(500).json({ error: 'Failed to create loan' });
  }
});

// GET /api/loans/member/:memberId
app.get('/api/loans/member/:memberId', async (req, res) => {
  if (!loansDb) {
    return res.status(503).json({ error: 'Loan database not ready' });
  }
  try {
    const loans = await loansDb.collection('loans')
      .find({ memberId: Number(req.params.memberId) })
      .sort({ borrowedAt: -1 })
      .toArray();
    res.json(loans.map(withOverdue));
  } catch (err) {
    console.error('Get loans error:', err.message);
    res.status(500).json({ error: 'Failed to fetch loans' });
  }
});

// PATCH /api/loans/:loanId/return
// Marks the loan returned, puts the copies back and works out any late fee.
app.patch('/api/loans/:loanId/return', async (req, res) => {
  if (!loansDb) {
    return res.status(503).json({ error: 'Loan database not ready' });
  }
  if (!ObjectId.isValid(req.params.loanId)) {
    return res.status(400).json({ error: 'Invalid loan id' });
  }

  try {
    const loans = loansDb.collection('loans');
    const _id = new ObjectId(req.params.loanId);
    const loan = await loans.findOne({ _id });
    if (!loan) {
      return res.status(404).json({ error: 'Loan not found' });
    }
    if (loan.status === 'returned') {
      return res.status(409).json({ error: 'Loan already returned' });
    }

    const now = new Date();
    const daysLate = Math.max(0, Math.ceil((now - loan.dueDate) / DAY_MS));
    const lateFee = Math.round(daysLate * LATE_FEE_PER_DAY * loan.books.length * 100) / 100;

    for (const book of loan.books) await changeCopies(book.bookId, 1);

    await loans.updateOne({ _id }, {
      $set:  { status: 'returned', returnedAt: now, lateFee },
      $push: { statusHistory: { status: 'returned', at: now } }
    });

    res.json({ message: 'Books returned', loanId: _id, daysLate, lateFee });
  } catch (err) {
    console.error('Return loan error:', err.message);
    res.status(500).json({ error: 'Failed to return loan' });
  }
});

const PORT = process.env.PORT || 3003;
app.listen(PORT, () =>
  console.log(`[loan-service] Running on http://localhost:${PORT}`)
);
