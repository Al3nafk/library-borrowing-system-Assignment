# Library Borrowing System

A microservices library system built with Node.js, Docker Compose, MySQL, MongoDB and Redis.
Members register, browse the book catalogue, pick books into a borrow basket and check them out
as a loan with a due date. Returning a loan puts the copies back on the shelf and charges a late
fee if it is overdue.

XDCS2054N Introduction to Cloud Computing, Domain Migration assignment.

## Architecture

```
                         ┌──────────────────────┐
   client ──► :8000 ──►  │     api-gateway      │
                         └──┬────────┬───────┬──┘
           /api/auth        │        │       │  /api/basket
           /api/members     │        │       │  /api/loans
                 ┌──────────▼──┐ ┌───▼──────────┐ ┌──▼────────────┐
                 │member-service│ │ book-service │ │ loan-service  │
                 │    :3001     │ │    :3002     │ │    :3003      │
                 └──────┬───────┘ └──────┬───────┘ └──┬─────────┬──┘
                        │  MySQL         │  MySQL     │ MongoDB │ Redis
                        ▼  members       ▼  books     ▼ loans   ▼ basket:member{id}
```

| Service | Port | Data store | Owns |
|---|---|---|---|
| api-gateway | 8000 (only public port) | none | Routes requests by URL path |
| member-service | 3001 | MySQL `members` | Register, login (bcrypt), member profile and loan limit |
| book-service | 3002 | MySQL `books` | Catalogue, search, genres, available copies |
| loan-service | 3003 | Redis + MongoDB `loans` | Borrow basket (Redis, 30 min TTL), loans and returns (MongoDB) |

Services never read each other's tables. loan-service calls member-service to check the member
and their loan limit, and calls book-service to take or return a copy.

## Setup (on the VM)

1. Clone the repository:
   ```bash
   git clone https://github.com/Al3nafk/library-borrowing-system-Assignment ~/library-app
   cd ~/library-app
   ```
2. Create the environment file and set real passwords:
   ```bash
   cp .env.example .env
   nano .env
   ```
3. Start everything:
   ```bash
   docker compose up -d --build
   ```
4. Check that all six containers are running and healthy:
   ```bash
   docker compose ps
   curl http://localhost:8000/health
   ```

> **Port 8000 is shared with the CloudEats lab.** Only one of the two can run at a time. Stop the
> lab first (`cd ~/cloudeats-app && docker compose down`, without `-v`, so the lab data is kept).
>
> MySQL only runs `database/init.sql` on an empty volume. If the tables are missing, reset this
> project's volumes from `~/library-app`: `docker compose down -v` then `docker compose up -d --build`.

## Try it

```bash
# 1. Register a member (membership_type: student = 5 books, staff = 10, public = 3)
curl -X POST http://localhost:8000/api/auth/register -H "Content-Type: application/json" \
  -d '{"email":"aina@example.com","password":"password123","full_name":"Aina Rahman","membership_type":"student"}'

# 2. Log in
curl -X POST http://localhost:8000/api/auth/login -H "Content-Type: application/json" \
  -d '{"email":"aina@example.com","password":"password123"}'

# 3. Browse and search the catalogue
curl http://localhost:8000/api/books
curl "http://localhost:8000/api/books?q=orwell"
curl http://localhost:8000/api/books/genre/Fiction

# 4. Put books in the borrow basket (Redis)
curl -X POST http://localhost:8000/api/basket/1/books -H "Content-Type: application/json" -d '{"bookId":7}'
curl -X POST http://localhost:8000/api/basket/1/books -H "Content-Type: application/json" -d '{"bookId":1}'
curl http://localhost:8000/api/basket/1

# 5. Check out the basket as a loan (MongoDB). Copies go down in MySQL.
curl -X POST http://localhost:8000/api/loans -H "Content-Type: application/json" -d '{"memberId":1}'
curl http://localhost:8000/api/books/7

# 6. See the member's loans, then return one (use the loanId from step 5)
curl http://localhost:8000/api/loans/member/1
curl -X PATCH http://localhost:8000/api/loans/<loanId>/return
```

## API

| Method | Path | Service | What it does |
|---|---|---|---|
| POST | `/api/auth/register` | member | Create a membership (bcrypt-hashed password) |
| POST | `/api/auth/login` | member | Log in |
| GET | `/api/members/:id` | member | Member profile and `max_loans` |
| GET | `/api/books` | book | Whole catalogue, or search with `?q=` |
| GET | `/api/books/genre/:genre` | book | Books in one genre |
| GET | `/api/books/:id` | book | One book |
| PATCH | `/api/books/:id/copies` | book | `{change:-1}` borrow / `{change:1}` return (internal, used by loan-service) |
| GET | `/api/basket/:memberId` | loan | Current borrow basket |
| POST | `/api/basket/:memberId/books` | loan | Add `{bookId}` to the basket |
| DELETE | `/api/basket/:memberId/books/:bookId` | loan | Remove a book from the basket |
| POST | `/api/loans` | loan | Check out the basket as a loan, due in 14 days |
| GET | `/api/loans/member/:memberId` | loan | A member's loans, with `isOverdue` |
| PATCH | `/api/loans/:loanId/return` | loan | Return a loan and work out the late fee |
| GET | `/health` | all | Health check |

## Data models

**MySQL `members`**: `id`, `email` (unique), `password_hash`, `full_name`, `phone`,
`membership_type` (ENUM student/staff/public), `max_loans`, `joined_at`.

**MySQL `books`**: `id`, `isbn` (unique), `title`, `author`, `genre`, `publisher`,
`published_year`, `total_copies`, `available_copies`, `shelf_location`, `created_at`.
A CHECK constraint keeps `available_copies` between 0 and `total_copies`.

**Redis `basket:member{id}`**: `{ books: [{ bookId, isbn, title, author }] }`, expires after
`BASKET_TTL` seconds (default 1800).

**MongoDB `library_db.loans`**:
```json
{
  "memberId": 1,
  "memberName": "Aina Rahman",
  "books": [{ "bookId": 7, "isbn": "9780451524935", "title": "1984", "author": "George Orwell" }],
  "borrowedAt": "2026-11-03T10:00:00Z",
  "dueDate": "2026-11-17T10:00:00Z",
  "status": "borrowed",
  "returnedAt": null,
  "lateFee": 0,
  "statusHistory": [{ "status": "borrowed", "at": "2026-11-03T10:00:00Z" }]
}
```

## Loan rules (set in `.env`)

| Variable | Default | Meaning |
|---|---|---|
| `BASKET_TTL` | 1800 | Seconds before an unused basket expires |
| `LOAN_DAYS` | 14 | Loan period |
| `LATE_FEE_PER_DAY` | 0.50 | RM per book per day late |

## Tests and CI/CD

- Unit tests (Jest) for book review rating validation: `cd services/book-service && npm test`
- Husky runs the tests before every commit.
- GitHub Actions (`.github/workflows/ci.yml`) runs the tests on every push and pull request, then
  redeploys to the VM's self-hosted runner from `~/library-app` on pushes to `main`.

## Security

- Passwords are hashed with bcrypt and never returned. Wrong email and wrong password give the
  same error.
- All credentials come from `.env`, which is git-ignored. `.env.example` holds placeholders only.
- Only the gateway publishes a port. MySQL, MongoDB, Redis and the services are reachable only
  on the private `library-network`.
