# Reflection: CloudEats to Library Borrowing System

*DRAFT. Rewrite this in your own words before submitting. You will be asked to explain these decisions in the Week 9 Q&A.*

## Why I chose this domain

I chose a library borrowing system because it has the same shape as food ordering but different
rules, so it tested whether I understood the architecture rather than just renaming words. A
member browses a catalogue, picks items and checks them out, which maps onto users, menu and
orders. But a library adds things a restaurant does not have: items come back, stock is limited
to a few physical copies, there is a due date, and members have borrowing limits. I also use a
library on campus, so I know how the process works from the borrower's side.

## What I changed in the data models and why

The `users` table became `members`, and I added `membership_type` (an ENUM of student, staff and
public) and `max_loans`, because a library limits how many books each type of member can hold.

`menu_items` became `books`. Price and badge were removed because borrowing is free. I added
`isbn` with a UNIQUE constraint, because the ISBN identifies a title, plus `author`, `publisher`,
`published_year` and `shelf_location`. The most important change is `total_copies` and
`available_copies`. A restaurant can cook another plate, but a library only owns a fixed number
of copies. I added a CHECK constraint so `available_copies` can never go below zero or above the
total.

The Redis cart became a borrow basket (`basket:member{id}`). It no longer stores quantity or
price, because a member borrows one copy of a title. I shortened the TTL to 30 minutes, so books
are not held in abandoned baskets.

MongoDB `orders` became `loans`. A loan has `borrowedAt`, `dueDate`, `returnedAt`, `lateFee` and
a status that goes from borrowed to returned. MongoDB still suits this well, because one loan can
hold one book or five, and the status history is an array that grows.

## Challenges

The biggest challenge was stock. In CloudEats an order never changed the menu, but here every
loan must reduce `available_copies`, and the loan service is not allowed to touch the books
table directly. I added a `PATCH /api/books/:id/copies` endpoint to the book service. Its UPDATE
only succeeds if a copy is left, so two members cannot take the last copy at the same time. If
one book in a basket runs out halfway through a checkout, the loan service puts back the copies
it already took.

I also found that the original `init.sql` never created the users table. It only worked on my VM
because I had created that table by hand during the labs. A fresh `docker compose up` would have
failed on registration, so the new `init.sql` creates both tables. Because MySQL only runs
`init.sql` on an empty volume, I also had to remove the old volumes with
`docker compose down -v` before the new schema appeared.

Finally, I had to make sure no food references were left. I renamed the folders, services,
containers, network, database, environment variables and CI job, then searched the whole
repository to confirm nothing remained.
