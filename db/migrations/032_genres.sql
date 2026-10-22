-- A genre for every book (from the catalogues it is rarely known, so the local model
-- guesses it from the title, authors and description), for browsing and filtering.
ALTER TABLE books ADD COLUMN genre text, ADD COLUMN genre_at timestamptz;
CREATE INDEX books_genre_todo_idx ON books (created_at) WHERE genre_at IS NULL;
-- Readers can correct the genre and the language like any other detail.
ALTER TABLE book_fixes DROP CONSTRAINT book_fixes_field_check;
ALTER TABLE book_fixes ADD CONSTRAINT book_fixes_field_check CHECK (field IN ('title', 'authors', 'publisher', 'year', 'description', 'cover_text', 'genre', 'language'));
