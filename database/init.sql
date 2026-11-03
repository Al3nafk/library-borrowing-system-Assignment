-- Use the database created by Docker Compose environment variables
USE library_db;

-- ===== MEMBERS (owned by member-service) =====
-- Library members who can log in and borrow books.
-- max_loans depends on membership type: student 5, staff 10, public 3.
CREATE TABLE IF NOT EXISTS members (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  email           VARCHAR(255) NOT NULL UNIQUE,
  password_hash   VARCHAR(255) NOT NULL,
  full_name       VARCHAR(255) NOT NULL,
  phone           VARCHAR(20),
  membership_type ENUM('student', 'staff', 'public') NOT NULL DEFAULT 'student',
  max_loans       TINYINT NOT NULL DEFAULT 5,
  joined_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ===== BOOKS (owned by book-service) =====
-- One row per title. available_copies goes down when a copy is borrowed
-- and back up when it is returned. The CHECK stops it going below 0
-- or above total_copies.
CREATE TABLE IF NOT EXISTS books (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  isbn             VARCHAR(17)  NOT NULL UNIQUE,
  title            VARCHAR(255) NOT NULL,
  author           VARCHAR(255) NOT NULL,
  genre            VARCHAR(100) NOT NULL,
  publisher        VARCHAR(255),
  published_year   SMALLINT,
  total_copies     TINYINT NOT NULL DEFAULT 1,
  available_copies TINYINT NOT NULL DEFAULT 1,
  shelf_location   VARCHAR(20),
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_copies CHECK (available_copies BETWEEN 0 AND total_copies),
  INDEX idx_genre (genre),
  INDEX idx_title (title)
);

-- Seed sample books (only insert if the ids are not there yet)
INSERT IGNORE INTO books (id, isbn, title, author, genre, publisher, published_year, total_copies, available_copies, shelf_location) VALUES
  (1, '9780132350884', 'Clean Code',                              'Robert C. Martin',  'Computing', 'Prentice Hall',   2008, 3, 3, 'C-101'),
  (2, '9780135957059', 'The Pragmatic Programmer',                'David Thomas, Andrew Hunt', 'Computing', 'Addison-Wesley', 2019, 2, 2, 'C-102'),
  (3, '9781449373320', 'Designing Data-Intensive Applications',   'Martin Kleppmann',  'Computing', 'O''Reilly Media', 2017, 2, 2, 'C-103'),
  (4, '9780735211292', 'Atomic Habits',                           'James Clear',       'Self-Help', 'Avery',           2018, 4, 4, 'S-201'),
  (5, '9780062316097', 'Sapiens: A Brief History of Humankind',   'Yuval Noah Harari', 'History',   'Harper',          2015, 2, 2, 'H-301'),
  (6, '9780547928227', 'The Hobbit',                              'J.R.R. Tolkien',    'Fiction',   'Mariner Books',   2012, 3, 3, 'F-401'),
  (7, '9780451524935', '1984',                                    'George Orwell',     'Fiction',   'Signet Classics', 1961, 2, 2, 'F-402'),
  (8, '9780061120084', 'To Kill a Mockingbird',                   'Harper Lee',        'Fiction',   'Harper Perennial', 2006, 1, 1, 'F-403');
