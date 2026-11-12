-- =====================================================================
-- PRAN NÒT - sql/09_semesters.sql
-- Tablo semès + champ semester_id sou kou yo
-- =====================================================================

-- Tablo semès
CREATE TABLE IF NOT EXISTS pran_not_semesters (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES auth.users NOT NULL,
  name        text NOT NULL,
  year_label  text,
  status      text NOT NULL DEFAULT 'active', -- active | closed
  started_at  date,
  ended_at    date,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

ALTER TABLE pran_not_semesters ENABLE ROW LEVEL SECURITY;

CREATE POLICY sem_owner ON pran_not_semesters
  FOR ALL USING (auth.uid() = user_id);

-- Lyen semès sou kou
ALTER TABLE pran_not_courses
  ADD COLUMN IF NOT EXISTS semester_id uuid REFERENCES pran_not_semesters;

-- Endèks
CREATE INDEX IF NOT EXISTS idx_semesters_user    ON pran_not_semesters(user_id);
CREATE INDEX IF NOT EXISTS idx_courses_semester  ON pran_not_courses(semester_id);
