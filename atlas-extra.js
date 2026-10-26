import crypto from 'node:crypto';

function cleanText(value, label, required = false, max = 2000) {
  const text = value == null ? '' : String(value).trim();
  if (required && !text) throw new Error(`${label} é obrigatório.`);
  if (text.length > max) throw new Error(`${label} é muito longo.`);
  return text;
}

function workoutDays(value) {
  const days = [...new Set((Array.isArray(value) ? value : []).map(Number))].sort((a, b) => a - b);
  if (!days.length || days.some((item) => !Number.isInteger(item) || item < 0 || item > 6)) {
    throw new Error('Selecione pelo menos um dia válido da semana.');
  }
  return days;
}

async function getProfiles(pool, user) {
  await pool.query(
    `INSERT INTO atlas_user_profiles (id, user_id, profile)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, profile) DO NOTHING`,
    [crypto.randomUUID(), user.id, user.role]
  );
  const { rows } = await pool.query(
    'SELECT profile FROM atlas_user_profiles WHERE user_id = $1 ORDER BY profile',
    [user.id]
  );
  return rows.map((row) => row.profile);
}

async function linkedPair(pool, user, otherUserId) {
  const trainerId = user.role === 'trainer' ? user.id : String(otherUserId || '');
  const studentId = user.role === 'student' ? user.id : String(otherUserId || '');
  if (!trainerId || !studentId) return null;
  const { rows } = await pool.query(
    `SELECT ts.trainer_id AS "trainerId", ts.student_id AS "studentId",
            t.name AS "trainerName", s.name AS "studentName"
     FROM atlas_trainer_students ts
     JOIN atlas_users t ON t.id = ts.trainer_id
     JOIN atlas_users s ON s.id = ts.student_id
     WHERE ts.trainer_id = $1 AND ts.student_id = $2`,
    [trainerId, studentId]
  );
  return rows[0] || null;
}

async function progressForStudent(pool, studentId, trainerId = null) {
  const params = [studentId];
  let trainerClause = '';
  if (trainerId) {
    params.push(trainerId);
    trainerClause = ` AND w.trainer_id = $${params.length}`;
  }

  const { rows: sessions } = await pool.query(
    `SELECT ws.id, ws.workout_id AS "workoutId", w.name AS "workoutName",
            w.trainer_id AS "trainerId", ws.started_at AS "startedAt",
            ws.completed_at AS "completedAt", ws.notes,
            COALESCE(SUM(sl.weight * sl.reps), 0)::float8 AS volume,
            COALESCE(MAX(sl.weight), 0)::float8 AS "maxWeight",
            COUNT(sl.id)::int AS "setCount"
     FROM atlas_workout_sessions ws
     JOIN atlas_workouts w ON w.id = ws.workout_id
     LEFT JOIN atlas_set_logs sl ON sl.session_id = ws.id AND sl.completed = TRUE
     WHERE ws.student_id = $1 AND ws.completed_at IS NOT NULL${trainerClause}
     GROUP BY ws.id, w.id
     ORDER BY ws.completed_at ASC`,
    params
  );

  const { rows: exercises } = await pool.query(
    `SELECT e.name,
            COALESCE(MAX(sl.weight), 0)::float8 AS "maxWeight",
            COALESCE(SUM(sl.weight * sl.reps), 0)::float8 AS volume,
            COUNT(DISTINCT ws.id)::int AS sessions
     FROM atlas_set_logs sl
     JOIN atlas_workout_sessions ws ON ws.id = sl.session_id
     JOIN atlas_workouts w ON w.id = ws.workout_id
     JOIN atlas_workout_exercises e ON e.id = sl.exercise_id
     WHERE ws.student_id = $1 AND ws.completed_at IS NOT NULL
       AND sl.completed = TRUE${trainerClause}
     GROUP BY e.name
     ORDER BY "maxWeight" DESC, volume DESC`,
    params
  );

  const { rows: annotations } = await pool.query(
    `SELECT sl.id, ws.id AS "sessionId", ws.completed_at AS "completedAt",
            w.name AS "workoutName", e.name AS "exerciseName",
            sl.set_number AS "setNumber", sl.notes
     FROM atlas_set_logs sl
     JOIN atlas_workout_sessions ws ON ws.id = sl.session_id
     JOIN atlas_workouts w ON w.id = ws.workout_id
     JOIN atlas_workout_exercises e ON e.id = sl.exercise_id
     WHERE ws.student_id = $1
       AND ws.completed_at IS NOT NULL
       AND sl.completed = TRUE
       AND BTRIM(COALESCE(sl.notes, '')) <> ''${trainerClause}
     ORDER BY ws.completed_at DESC, e.position, sl.set_number
     LIMIT 100`,
    params
  );

  const totalVolume = sessions.reduce((sum, item) => sum + Number(item.volume || 0), 0);
  const maxWeight = sessions.reduce((max, item) => Math.max(max, Number(item.maxWeight || 0)), 0);
  const last30Cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const workoutsLast30Days = sessions.filter(
    (item) => new Date(item.completedAt).getTime() >= last30Cutoff
  ).length;

  return {
    summary: {
      completedWorkouts: sessions.length,
      workoutsLast30Days,
      totalVolume,
      maxWeight,
    },
    sessions,
    exercises,
    annotations,
  };
}

function startOfToday(date = new Date()) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

function occurrenceDateForWorkout(workout, now = new Date()) {
  const days = Array.isArray(workout.scheduled_days)
    ? workout.scheduled_days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    : [];
  if (!days.length) return null;

  const today = startOfToday(now);
  const todayDow = today.getDay();
  const pastOrToday = days.filter((day) => day <= todayDow);
  const targetDow = pastOrToday.length ? Math.max(...pastOrToday) : Math.max(...days);
  const delta = pastOrToday.length ? todayDow - targetDow : todayDow + 7 - targetDow;
  const occurrence = new Date(today);
  occurrence.setDate(today.getDate() - delta);
  return occurrence;
}

function statusForWorkout(workout, latestSession) {
  if (latestSession?.startedAt && !latestSession?.completedAt) return 'Pendente';

  const occurrence = occurrenceDateForWorkout(workout);
  if (!occurrence) return latestSession?.completedAt ? 'Realizado' : 'Pendente';

  const completedAt = latestSession?.completedAt ? new Date(latestSession.completedAt) : null;
  if (completedAt && completedAt >= occurrence) return 'Realizado';

  const today = startOfToday();
  const days = Array.isArray(workout.scheduled_days) ? workout.scheduled_days.map(Number) : [];
  if (days.includes(today.getDay())) return 'Pendente';
  return occurrence < today ? 'Não Realizado' : 'Pendente';
}

async function workoutPayload(pool, workout) {
  const { rows: exercises } = await pool.query(
    `SELECT id, exercise_id AS "exerciseId", name, sets, reps,
            suggested_weight::float8 AS "suggestedWeight",
            rest_seconds AS "restSeconds", notes, video_url AS "videoUrl", position
     FROM atlas_workout_exercises
     WHERE workout_id = $1
     ORDER BY position`,
    [workout.id]
  );

  const { rows: sessions } = await pool.query(
    `SELECT id, started_at AS "startedAt", completed_at AS "completedAt", notes
     FROM atlas_workout_sessions
     WHERE workout_id = $1 AND student_id = $2
     ORDER BY started_at DESC
     LIMIT 1`,
    [workout.id, workout.student_id]
  );

  const latestSession = sessions[0] || null;
  return {
    id: workout.id,
    trainerId: workout.trainer_id,
    studentId: workout.student_id,
    trainerName: workout.trainer_name,
    trainerAvatarUrl: workout.trainer_avatar_url || null,
    studentName: workout.student_name,
    name: workout.name,
    model: workout.model,
    description: workout.description || '',
    intensity: workout.intensity || 'Moderada',
    estimatedMinutes: Number(workout.estimated_minutes || 0),
    scheduledTime: workout.scheduled_time || '',
    templateId: workout.template_id || null,
    notes: workout.notes,
    scheduledDays: workout.scheduled_days || [],
    createdAt: workout.created_at,
    exercises,
    latestSession,
    status: statusForWorkout(workout, latestSession),
  };
}

export async function ensureAtlasExtraSchema(pool) {
  await pool.query(`
    ALTER TABLE atlas_users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
    ALTER TABLE atlas_sessions ADD COLUMN IF NOT EXISTS active_role TEXT;
    ALTER TABLE atlas_workouts ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
    ALTER TABLE atlas_workouts ADD COLUMN IF NOT EXISTS intensity TEXT NOT NULL DEFAULT 'Moderada';
    ALTER TABLE atlas_workouts ADD COLUMN IF NOT EXISTS estimated_minutes INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE atlas_workouts ADD COLUMN IF NOT EXISTS scheduled_time TEXT NOT NULL DEFAULT '';
    ALTER TABLE atlas_workouts ADD COLUMN IF NOT EXISTS template_id UUID;
    ALTER TABLE atlas_workout_exercises ADD COLUMN IF NOT EXISTS exercise_id UUID;
    ALTER TABLE atlas_workout_exercises ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';
    ALTER TABLE atlas_workout_exercises ADD COLUMN IF NOT EXISTS video_url TEXT;

    CREATE TABLE IF NOT EXISTS atlas_user_profiles (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES atlas_users(id) ON DELETE CASCADE,
      profile TEXT NOT NULL CHECK (profile IN ('trainer', 'student')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, profile)
    );

    CREATE TABLE IF NOT EXISTS atlas_exercises (
      id UUID PRIMARY KEY,
      owner_id UUID REFERENCES atlas_users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      muscle_groups TEXT[] NOT NULL DEFAULT '{}',
      intensity TEXT NOT NULL DEFAULT 'Moderada',
      description TEXT NOT NULL DEFAULT '',
      video_url TEXT,
      video_data BYTEA,
      video_mime TEXT,
      video_filename TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS atlas_workout_templates (
      id UUID PRIMARY KEY,
      trainer_id UUID NOT NULL REFERENCES atlas_users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      intensity TEXT NOT NULL DEFAULT 'Moderada',
      notes TEXT NOT NULL DEFAULT '',
      estimated_minutes INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS atlas_template_exercises (
      id UUID PRIMARY KEY,
      template_id UUID NOT NULL REFERENCES atlas_workout_templates(id) ON DELETE CASCADE,
      exercise_id UUID REFERENCES atlas_exercises(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      sets SMALLINT NOT NULL CHECK (sets > 0),
      reps SMALLINT NOT NULL CHECK (reps > 0),
      suggested_weight NUMERIC(8,2) NOT NULL DEFAULT 0 CHECK (suggested_weight >= 0),
      rest_seconds INTEGER NOT NULL DEFAULT 0 CHECK (rest_seconds >= 0),
      video_url TEXT,
      notes TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS atlas_messages (
      id UUID PRIMARY KEY,
      trainer_id UUID NOT NULL REFERENCES atlas_users(id) ON DELETE CASCADE,
      student_id UUID NOT NULL REFERENCES atlas_users(id) ON DELETE CASCADE,
      sender_id UUID NOT NULL REFERENCES atlas_users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      read_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS atlas_notifications (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES atlas_users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      reference_id UUID,
      occurrence_key TEXT NOT NULL DEFAULT '',
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_atlas_notification_unique
      ON atlas_notifications(user_id, type, reference_id, occurrence_key);
    CREATE INDEX IF NOT EXISTS idx_atlas_profiles_user ON atlas_user_profiles(user_id);
    CREATE INDEX IF NOT EXISTS idx_atlas_exercises_owner_name ON atlas_exercises(owner_id, name);
    CREATE INDEX IF NOT EXISTS idx_atlas_templates_trainer ON atlas_workout_templates(trainer_id);
    CREATE INDEX IF NOT EXISTS idx_atlas_messages_pair_time ON atlas_messages(trainer_id, student_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_atlas_notifications_user_time ON atlas_notifications(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_atlas_set_logs_session_extra ON atlas_set_logs(session_id);
  `);

  const { rows: users } = await pool.query('SELECT id, role FROM atlas_users');
  for (const user of users) {
    await pool.query(
      `INSERT INTO atlas_user_profiles (id, user_id, profile)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, profile) DO NOTHING`,
      [crypto.randomUUID(), user.id, user.role]
    );
  }
}

export function registerAtlasExtraRoutes({ app, pool, atlasRequireAuth, atlasRole }) {
  app.get('/atlas-api/me', atlasRequireAuth, async (req, res, next) => {
    try {
      const profiles = await getProfiles(pool, req.atlasUser);
      const { rows } = await pool.query(
        'SELECT avatar_url AS "avatarUrl" FROM atlas_users WHERE id = $1',
        [req.atlasUser.id]
      );
      res.json({
        user: {
          ...req.atlasUser,
          avatarUrl: rows[0]?.avatarUrl || null,
          profiles,
        },
      });
    } catch (error) { next(error); }
  });

  app.get('/atlas-api/profiles', atlasRequireAuth, async (req, res, next) => {
    try {
      res.json({ active: req.atlasUser.role, profiles: await getProfiles(pool, req.atlasUser) });
    } catch (error) { next(error); }
  });

  app.post('/atlas-api/profiles', atlasRequireAuth, async (req, res, next) => {
    try {
      const profile = req.body?.profile === 'trainer'
        ? 'trainer'
        : req.body?.profile === 'student' ? 'student' : null;
      if (!profile) return res.status(400).json({ error: 'Perfil inválido.' });
      await getProfiles(pool, req.atlasUser);
      await pool.query(
        `INSERT INTO atlas_user_profiles (id, user_id, profile)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, profile) DO NOTHING`,
        [crypto.randomUUID(), req.atlasUser.id, profile]
      );
      res.status(201).json({ profiles: await getProfiles(pool, req.atlasUser) });
    } catch (error) { next(error); }
  });

  app.put('/atlas-api/profiles/active', atlasRequireAuth, async (req, res, next) => {
    try {
      const profile = req.body?.profile === 'trainer'
        ? 'trainer'
        : req.body?.profile === 'student' ? 'student' : null;
      if (!profile) return res.status(400).json({ error: 'Perfil inválido.' });
      const profiles = await getProfiles(pool, req.atlasUser);
      if (!profiles.includes(profile)) {
        return res.status(403).json({ error: 'Este perfil não está ativo na sua conta.' });
      }
      await pool.query(
        'UPDATE atlas_sessions SET active_role = $2 WHERE token_hash = $1',
        [req.atlasTokenHash, profile]
      );
      res.json({ user: { ...req.atlasUser, role: profile, profiles } });
    } catch (error) { next(error); }
  });

  app.patch('/atlas-api/me', atlasRequireAuth, async (req, res, next) => {
    try {
      const name = req.body?.name == null
        ? req.atlasUser.name
        : cleanText(req.body.name, 'Nome', true, 120);
      const avatarUrl = req.body?.avatarUrl == null
        ? null
        : cleanText(req.body.avatarUrl, 'Foto de perfil', false, 1600000) || null;
      const { rows } = await pool.query(
        `UPDATE atlas_users SET name = $2, avatar_url = COALESCE($3, avatar_url)
         WHERE id = $1
         RETURNING id, name, email, role, avatar_url AS "avatarUrl"`,
        [req.atlasUser.id, name, avatarUrl]
      );
      const profiles = await getProfiles(pool, { ...rows[0], role: req.atlasUser.role });
      res.json({ user: { ...rows[0], role: req.atlasUser.role, profiles } });
    } catch (error) { next(error); }
  });

  app.get('/atlas-api/trainer/students', atlasRequireAuth, atlasRole('trainer'), async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT u.id, u.name, u.email, u.avatar_url AS "avatarUrl",
                COALESCE(array_agg(a.day_of_week ORDER BY a.day_of_week)
                  FILTER (WHERE a.day_of_week IS NOT NULL), '{}') AS availability,
                COUNT(DISTINCT w.id)::int AS "workoutCount"
         FROM atlas_trainer_students ts
         JOIN atlas_users u ON u.id = ts.student_id
         LEFT JOIN atlas_availability a ON a.student_id = u.id
         LEFT JOIN atlas_workouts w ON w.student_id = u.id AND w.trainer_id = ts.trainer_id
         WHERE ts.trainer_id = $1
         GROUP BY u.id, u.name, u.email, u.avatar_url
         ORDER BY u.name`,
        [req.atlasUser.id]
      );
      res.json(rows);
    } catch (error) { next(error); }
  });

  app.get('/atlas-api/trainer/dashboard', atlasRequireAuth, atlasRole('trainer'), async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT u.id, u.name, u.email, u.avatar_url AS "avatarUrl",
                COUNT(DISTINCT w.id)::int AS "workoutCount",
                COUNT(DISTINCT ws.id) FILTER (WHERE ws.completed_at IS NOT NULL)::int AS "completedWorkouts",
                COALESCE(SUM(sl.weight * sl.reps) FILTER (WHERE ws.completed_at IS NOT NULL AND sl.completed = TRUE),0)::float8 AS "totalVolume",
                COALESCE(MAX(sl.weight) FILTER (WHERE ws.completed_at IS NOT NULL AND sl.completed = TRUE),0)::float8 AS "maxWeight",
                MAX(ws.completed_at) AS "lastCompletedAt"
         FROM atlas_trainer_students ts
         JOIN atlas_users u ON u.id = ts.student_id
         LEFT JOIN atlas_workouts w ON w.student_id = u.id AND w.trainer_id = ts.trainer_id
         LEFT JOIN atlas_workout_sessions ws ON ws.workout_id = w.id AND ws.student_id = u.id
         LEFT JOIN atlas_set_logs sl ON sl.session_id = ws.id
         WHERE ts.trainer_id = $1
         GROUP BY u.id, u.name, u.email, u.avatar_url
         ORDER BY u.name`,
        [req.atlasUser.id]
      );
      const now = Date.now();
      const attention = rows.filter((row) => {
        if (!row.workoutCount || !row.lastCompletedAt) return true;
        return now - new Date(row.lastCompletedAt).getTime() > 7 * 24 * 60 * 60 * 1000;
      });
      res.json({ students: rows, attention });
    } catch (error) { next(error); }
  });

  app.get('/atlas-api/sessions/:id', atlasRequireAuth, atlasRole('student'), async (req, res, next) => {
    try {
      const { rows: sessions } = await pool.query(
        `SELECT ws.id, ws.workout_id AS "workoutId", ws.started_at AS "startedAt",
                ws.completed_at AS "completedAt", ws.notes, w.name AS "workoutName"
         FROM atlas_workout_sessions ws
         JOIN atlas_workouts w ON w.id = ws.workout_id
         WHERE ws.id = $1 AND ws.student_id = $2`,
        [req.params.id, req.atlasUser.id]
      );
      if (!sessions[0]) return res.status(404).json({ error: 'Execução não encontrada.' });
      const { rows: exercises } = await pool.query(
        `SELECT e.id, e.exercise_id AS "exerciseId", e.name, e.sets, e.reps,
                e.suggested_weight::float8 AS "suggestedWeight",
                e.rest_seconds AS "restSeconds", e.notes,
                e.video_url AS "videoUrl", e.position
         FROM atlas_workout_exercises e
         WHERE e.workout_id = $1
         ORDER BY e.position`,
        [sessions[0].workoutId]
      );
      const { rows: logs } = await pool.query(
        `SELECT id, exercise_id AS "exerciseId", set_number AS "setNumber",
                reps, weight::float8 AS weight, completed, notes
         FROM atlas_set_logs
         WHERE session_id = $1
         ORDER BY exercise_id, set_number`,
        [req.params.id]
      );
      res.json({ ...sessions[0], exercises, logs });
    } catch (error) { next(error); }
  });

  app.get('/atlas-api/exercises', atlasRequireAuth, atlasRole('trainer'), async (req, res, next) => {
    try {
      const params = [req.atlasUser.id];
      const where = ['(e.owner_id IS NULL OR e.owner_id = $1)'];
      const filters = {
        name: String(req.query.name || '').trim(),
        category: String(req.query.category || '').trim(),
        muscle: String(req.query.muscle || '').trim(),
        intensity: String(req.query.intensity || '').trim(),
      };

      if (filters.name) {
        params.push(`%${filters.name}%`);
        where.push('e.name ILIKE $' + params.length);
      }
      if (filters.category) {
        params.push(filters.category);
        where.push('e.category ILIKE $' + params.length);
      }
      if (filters.muscle) {
        params.push(`%${filters.muscle}%`);
        where.push('EXISTS (SELECT 1 FROM unnest(e.muscle_groups) AS mg WHERE mg ILIKE $' + params.length + ')');
      }
      if (filters.intensity) {
        params.push(filters.intensity);
        where.push('e.intensity ILIKE $' + params.length);
      }

      const { rows } = await pool.query(
        `SELECT e.id, e.name, e.category, e.muscle_groups AS "muscleGroups",
                e.intensity, e.description, e.video_url AS "videoUrl",
                (e.video_data IS NOT NULL) AS "hasUploadedVideo",
                e.video_mime AS "videoMime", e.video_filename AS "videoFilename",
                e.owner_id AS "ownerId", e.created_at AS "createdAt"
         FROM atlas_exercises e
         WHERE ${where.join(' AND ')}
         ORDER BY e.name`,
        params
      );
      res.json(rows);
    } catch (error) { next(error); }
  });

  app.post('/atlas-api/exercises', atlasRequireAuth, atlasRole('trainer'), async (req, res, next) => {
    try {
      const name = cleanText(req.body?.name, 'Nome do exercício', true, 120);
      const category = cleanText(req.body?.category, 'Categoria', false, 80);
      const muscleGroups = Array.isArray(req.body?.muscleGroups)
        ? [...new Set(req.body.muscleGroups.map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 12)
        : [];
      const intensity = cleanText(req.body?.intensity, 'Intensidade', false, 40) || 'Moderada';
      const description = cleanText(req.body?.description, 'Descrição', false, 3000);
      const videoUrl = cleanText(req.body?.videoUrl, 'URL do vídeo', false, 1800) || null;

      let videoData = null;
      let videoMime = null;
      let videoFilename = null;
      const rawBase64 = String(req.body?.videoBase64 || '');
      if (rawBase64) {
        videoMime = String(req.body?.videoMime || '').trim();
        videoFilename = String(req.body?.videoFilename || 'video').slice(0, 180);
        if (!videoMime.startsWith('video/')) {
          return res.status(400).json({ error: 'O arquivo enviado precisa ser um vídeo.' });
        }
        const payload = rawBase64.includes(',') ? rawBase64.slice(rawBase64.indexOf(',') + 1) : rawBase64;
        videoData = Buffer.from(payload, 'base64');
        if (!videoData.length || videoData.length > 8 * 1024 * 1024) {
          return res.status(400).json({ error: 'O vídeo precisa ter no máximo 8 MB.' });
        }
      }

      const id = crypto.randomUUID();
      const { rows } = await pool.query(
        `INSERT INTO atlas_exercises
          (id, owner_id, name, category, muscle_groups, intensity, description,
           video_url, video_data, video_mime, video_filename)
         VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8, $9, $10, $11)
         RETURNING id, name, category, muscle_groups AS "muscleGroups",
                   intensity, description, video_url AS "videoUrl",
                   (video_data IS NOT NULL) AS "hasUploadedVideo",
                   video_mime AS "videoMime", video_filename AS "videoFilename"`,
        [id, req.atlasUser.id, name, category, muscleGroups, intensity, description,
         videoUrl, videoData, videoMime, videoFilename]
      );
      res.status(201).json(rows[0]);
    } catch (error) { next(error); }
  });

  app.patch('/atlas-api/exercises/:id', atlasRequireAuth, atlasRole('trainer'), async (req, res, next) => {
    try {
      const { rows: currentRows } = await pool.query(
        'SELECT * FROM atlas_exercises WHERE id = $1 AND owner_id = $2',
        [req.params.id, req.atlasUser.id]
      );
      const current = currentRows[0];
      if (!current) return res.status(404).json({ error: 'Exercício não encontrado.' });

      const name = req.body?.name == null ? current.name : cleanText(req.body.name, 'Nome do exercício', true, 120);
      const category = req.body?.category == null ? current.category : cleanText(req.body.category, 'Categoria', false, 80);
      const muscleGroups = req.body?.muscleGroups == null
        ? current.muscle_groups
        : [...new Set((Array.isArray(req.body.muscleGroups) ? req.body.muscleGroups : [])
          .map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 12);
      const intensity = req.body?.intensity == null
        ? current.intensity
        : cleanText(req.body.intensity, 'Intensidade', false, 40) || 'Moderada';
      const description = req.body?.description == null
        ? current.description
        : cleanText(req.body.description, 'Descrição', false, 3000);
      const videoUrl = req.body?.videoUrl == null
        ? current.video_url
        : cleanText(req.body.videoUrl, 'URL do vídeo', false, 1800) || null;

      const { rows } = await pool.query(
        `UPDATE atlas_exercises
         SET name = $3, category = $4, muscle_groups = $5::text[],
             intensity = $6, description = $7, video_url = $8, updated_at = NOW()
         WHERE id = $1 AND owner_id = $2
         RETURNING id, name, category, muscle_groups AS "muscleGroups",
                   intensity, description, video_url AS "videoUrl",
                   (video_data IS NOT NULL) AS "hasUploadedVideo"`,
        [req.params.id, req.atlasUser.id, name, category, muscleGroups,
         intensity, description, videoUrl]
      );
      res.json(rows[0]);
    } catch (error) { next(error); }
  });

  app.delete('/atlas-api/exercises/:id', atlasRequireAuth, atlasRole('trainer'), async (req, res, next) => {
    try {
      const result = await pool.query(
        'DELETE FROM atlas_exercises WHERE id = $1 AND owner_id = $2',
        [req.params.id, req.atlasUser.id]
      );
      if (!result.rowCount) return res.status(404).json({ error: 'Exercício não encontrado.' });
      res.status(204).end();
    } catch (error) { next(error); }
  });

  app.get('/atlas-api/exercises/:id/video', atlasRequireAuth, async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT e.video_data, e.video_mime, e.video_filename
         FROM atlas_exercises e
         WHERE e.id = $1
           AND (
             e.owner_id = $2
             OR EXISTS (
               SELECT 1
               FROM atlas_workout_exercises we
               JOIN atlas_workouts w ON w.id = we.workout_id
               WHERE we.exercise_id = e.id AND (w.trainer_id = $2 OR w.student_id = $2)
             )
           )`,
        [req.params.id, req.atlasUser.id]
      );
      const video = rows[0];
      if (!video?.video_data) return res.status(404).json({ error: 'Vídeo enviado não encontrado.' });
      res.setHeader('Content-Type', video.video_mime || 'video/mp4');
      res.setHeader('Content-Disposition', 'inline');
      res.send(video.video_data);
    } catch (error) { next(error); }
  });

  app.get('/atlas-api/templates', atlasRequireAuth, atlasRole('trainer'), async (req, res, next) => {
    try {
      const { rows: templates } = await pool.query(
        `SELECT id, name, description, intensity, notes,
                estimated_minutes AS "estimatedMinutes",
                created_at AS "createdAt", updated_at AS "updatedAt"
         FROM atlas_workout_templates
         WHERE trainer_id = $1
         ORDER BY updated_at DESC`,
        [req.atlasUser.id]
      );
      for (const template of templates) {
        const { rows: exercises } = await pool.query(
          `SELECT id, exercise_id AS "exerciseId", name, sets, reps,
                  suggested_weight::float8 AS "suggestedWeight",
                  rest_seconds AS "restSeconds", video_url AS "videoUrl",
                  notes, position
           FROM atlas_template_exercises
           WHERE template_id = $1
           ORDER BY position`,
          [template.id]
        );
        template.exercises = exercises;
      }
      res.json(templates);
    } catch (error) { next(error); }
  });

  app.post('/atlas-api/templates', atlasRequireAuth, atlasRole('trainer'), async (req, res, next) => {
    try {
      const name = cleanText(req.body?.name, 'Nome do template', true, 120);
      const description = cleanText(req.body?.description, 'Descrição', false, 2000);
      const intensity = cleanText(req.body?.intensity, 'Intensidade', false, 40) || 'Moderada';
      const notes = cleanText(req.body?.notes, 'Observações', false, 3000);
      const estimatedMinutes = Math.max(0, Math.min(600, Number.parseInt(req.body?.estimatedMinutes, 10) || 0));
      const exercises = Array.isArray(req.body?.exercises) ? req.body.exercises : [];
      if (!exercises.length) return res.status(400).json({ error: 'Adicione pelo menos um exercício ao template.' });

      const templateId = crypto.randomUUID();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO atlas_workout_templates
            (id, trainer_id, name, description, intensity, notes, estimated_minutes)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [templateId, req.atlasUser.id, name, description, intensity, notes, estimatedMinutes]
        );

        for (let index = 0; index < exercises.length; index += 1) {
          const exercise = exercises[index] || {};
          await client.query(
            `INSERT INTO atlas_template_exercises
              (id, template_id, exercise_id, name, sets, reps, suggested_weight,
               rest_seconds, video_url, notes, position)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              crypto.randomUUID(), templateId, exercise.exerciseId || null,
              cleanText(exercise.name, 'Exercício', true, 120),
              Math.max(1, Number.parseInt(exercise.sets, 10) || 1),
              Math.max(1, Number.parseInt(exercise.reps, 10) || 1),
              Math.max(0, Number(exercise.suggestedWeight) || 0),
              Math.max(0, Number.parseInt(exercise.restSeconds, 10) || 0),
              cleanText(exercise.videoUrl, 'Vídeo do exercício', false, 1800) || null,
              cleanText(exercise.notes, 'Observações do exercício', false, 1000),
              index,
            ]
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      res.status(201).json({ id: templateId, name });
    } catch (error) { next(error); }
  });

  app.patch('/atlas-api/templates/:id', atlasRequireAuth, atlasRole('trainer'), async (req, res, next) => {
    try {
      const { rows: currentRows } = await pool.query(
        'SELECT * FROM atlas_workout_templates WHERE id = $1 AND trainer_id = $2',
        [req.params.id, req.atlasUser.id]
      );
      const current = currentRows[0];
      if (!current) return res.status(404).json({ error: 'Template não encontrado.' });

      const name = req.body?.name == null ? current.name : cleanText(req.body.name, 'Nome', true, 120);
      const description = req.body?.description == null ? current.description : cleanText(req.body.description, 'Descrição', false, 2000);
      const intensity = req.body?.intensity == null ? current.intensity : cleanText(req.body.intensity, 'Intensidade', false, 40);
      const notes = req.body?.notes == null ? current.notes : cleanText(req.body.notes, 'Observações', false, 3000);
      const estimatedMinutes = req.body?.estimatedMinutes == null
        ? current.estimated_minutes
        : Math.max(0, Math.min(600, Number.parseInt(req.body.estimatedMinutes, 10) || 0));

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `UPDATE atlas_workout_templates
           SET name = $3, description = $4, intensity = $5, notes = $6,
               estimated_minutes = $7, updated_at = NOW()
           WHERE id = $1 AND trainer_id = $2`,
          [req.params.id, req.atlasUser.id, name, description, intensity, notes, estimatedMinutes]
        );

        if (Array.isArray(req.body?.exercises)) {
          await client.query('DELETE FROM atlas_template_exercises WHERE template_id = $1', [req.params.id]);
          for (let index = 0; index < req.body.exercises.length; index += 1) {
            const exercise = req.body.exercises[index] || {};
            await client.query(
              `INSERT INTO atlas_template_exercises
                (id, template_id, exercise_id, name, sets, reps, suggested_weight,
                 rest_seconds, video_url, notes, position)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
              [
                crypto.randomUUID(), req.params.id, exercise.exerciseId || null,
                cleanText(exercise.name, 'Exercício', true, 120),
                Math.max(1, Number.parseInt(exercise.sets, 10) || 1),
                Math.max(1, Number.parseInt(exercise.reps, 10) || 1),
                Math.max(0, Number(exercise.suggestedWeight) || 0),
                Math.max(0, Number.parseInt(exercise.restSeconds, 10) || 0),
                cleanText(exercise.videoUrl, 'Vídeo', false, 1800) || null,
                cleanText(exercise.notes, 'Observações', false, 1000),
                index,
              ]
            );
          }
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      res.json({ id: req.params.id, name, description, intensity, notes, estimatedMinutes });
    } catch (error) { next(error); }
  });

  app.delete('/atlas-api/templates/:id', atlasRequireAuth, atlasRole('trainer'), async (req, res, next) => {
    try {
      const result = await pool.query(
        'DELETE FROM atlas_workout_templates WHERE id = $1 AND trainer_id = $2',
        [req.params.id, req.atlasUser.id]
      );
      if (!result.rowCount) return res.status(404).json({ error: 'Template não encontrado.' });
      res.status(204).end();
    } catch (error) { next(error); }
  });

  app.post('/atlas-api/workouts', atlasRequireAuth, atlasRole('trainer'), async (req, res, next) => {
    try {
      const studentId = String(req.body?.studentId || '');
      const templateId = req.body?.templateId ? String(req.body.templateId) : null;
      let template = null;
      let templateExercises = [];

      if (templateId) {
        const { rows } = await pool.query(
          'SELECT * FROM atlas_workout_templates WHERE id = $1 AND trainer_id = $2',
          [templateId, req.atlasUser.id]
        );
        template = rows[0];
        if (!template) return res.status(404).json({ error: 'Template não encontrado.' });
        const result = await pool.query(
          `SELECT exercise_id AS "exerciseId", name, sets, reps,
                  suggested_weight::float8 AS "suggestedWeight",
                  rest_seconds AS "restSeconds", video_url AS "videoUrl", notes
           FROM atlas_template_exercises WHERE template_id = $1 ORDER BY position`,
          [templateId]
        );
        templateExercises = result.rows;
      }

      const name = cleanText(req.body?.name ?? template?.name, 'Nome do treino', true, 120);
      const model = cleanText(req.body?.model, 'Modelo', true, 30).toUpperCase();
      const description = cleanText(req.body?.description ?? template?.description, 'Descrição', false, 2000);
      const intensity = cleanText(req.body?.intensity ?? template?.intensity, 'Intensidade', false, 40) || 'Moderada';
      const notes = cleanText(req.body?.notes ?? template?.notes, 'Observações', false, 3000);
      const estimatedMinutes = Math.max(
        0, Math.min(600, Number.parseInt(req.body?.estimatedMinutes ?? template?.estimated_minutes, 10) || 0)
      );
      const scheduledTime = cleanText(req.body?.scheduledTime, 'Horário', false, 10);
      const scheduledDays = workoutDays(req.body?.scheduledDays);
      const exercises = Array.isArray(req.body?.exercises) && req.body.exercises.length
        ? req.body.exercises
        : templateExercises;
      if (!exercises.length) return res.status(400).json({ error: 'Adicione pelo menos um exercício.' });

      const linked = await pool.query(
        'SELECT 1 FROM atlas_trainer_students WHERE trainer_id = $1 AND student_id = $2',
        [req.atlasUser.id, studentId]
      );
      if (!linked.rowCount) return res.status(400).json({ error: 'Aluno não vinculado.' });

      const availabilityResult = await pool.query(
        'SELECT day_of_week FROM atlas_availability WHERE student_id = $1 ORDER BY day_of_week',
        [studentId]
      );
      const availability = availabilityResult.rows.map((item) => Number(item.day_of_week));
      if (!availability.length) return res.status(400).json({ error: 'O aluno ainda não informou a disponibilidade.' });
      if (scheduledDays.some((day) => !availability.includes(day))) {
        return res.status(400).json({ error: 'O treino só pode usar dias disponíveis do aluno.', availability });
      }

      const workoutId = crypto.randomUUID();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO atlas_workouts
            (id, trainer_id, student_id, name, model, description, intensity,
             estimated_minutes, scheduled_time, template_id, notes, scheduled_days)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::smallint[])`,
          [workoutId, req.atlasUser.id, studentId, name, model, description,
           intensity, estimatedMinutes, scheduledTime, templateId, notes, scheduledDays]
        );

        for (let index = 0; index < exercises.length; index += 1) {
          const exercise = exercises[index] || {};
          await client.query(
            `INSERT INTO atlas_workout_exercises
              (id, workout_id, exercise_id, name, sets, reps, suggested_weight,
               rest_seconds, notes, video_url, position)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              crypto.randomUUID(), workoutId, exercise.exerciseId || null,
              cleanText(exercise.name, 'Exercício', true, 120),
              Math.max(1, Number.parseInt(exercise.sets, 10) || 1),
              Math.max(1, Number.parseInt(exercise.reps, 10) || 1),
              Math.max(0, Number(exercise.suggestedWeight) || 0),
              Math.max(0, Number.parseInt(exercise.restSeconds, 10) || 0),
              cleanText(exercise.notes, 'Observações do exercício', false, 1000),
              cleanText(exercise.videoUrl, 'Vídeo', false, 1800) || null,
              index,
            ]
          );
        }

        await client.query(
          `INSERT INTO atlas_notifications
            (id, user_id, type, title, body, reference_id, occurrence_key)
           VALUES ($1, $2, 'workout_prescribed', 'Novo treino prescrito', $3, $4, '')
           ON CONFLICT (user_id, type, reference_id, occurrence_key) DO NOTHING`,
          [crypto.randomUUID(), studentId, name, workoutId]
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

      res.status(201).json({
        id: workoutId, name, model, description, intensity,
        estimatedMinutes, scheduledTime, templateId, scheduledDays,
      });
    } catch (error) { next(error); }
  });

  app.post('/atlas-api/workouts/:id/copy', atlasRequireAuth, atlasRole('trainer'), async (req, res, next) => {
    try {
      const targetStudentId = String(req.body?.studentId || '').trim();
      if (!targetStudentId) return res.status(400).json({ error: 'Selecione o aluno de destino.' });

      const { rows: sourceRows } = await pool.query(
        `SELECT *
         FROM atlas_workouts
         WHERE id = $1 AND trainer_id = $2`,
        [req.params.id, req.atlasUser.id]
      );
      const source = sourceRows[0];
      if (!source) return res.status(404).json({ error: 'Treino de origem não encontrado.' });
      if (source.student_id === targetStudentId) {
        return res.status(400).json({ error: 'Escolha um aluno diferente para exportar o treino.' });
      }

      const linked = await pool.query(
        'SELECT 1 FROM atlas_trainer_students WHERE trainer_id = $1 AND student_id = $2',
        [req.atlasUser.id, targetStudentId]
      );
      if (!linked.rowCount) return res.status(400).json({ error: 'O aluno de destino não está vinculado a você.' });

      const availabilityResult = await pool.query(
        'SELECT day_of_week FROM atlas_availability WHERE student_id = $1 ORDER BY day_of_week',
        [targetStudentId]
      );
      const availability = availabilityResult.rows.map((item) => Number(item.day_of_week));
      if (!availability.length) {
        return res.status(400).json({ error: 'O aluno de destino ainda não informou a disponibilidade.' });
      }

      const scheduledDays = req.body?.scheduledDays
        ? workoutDays(req.body.scheduledDays)
        : (source.scheduled_days || []).map(Number);
      if (!scheduledDays.length || scheduledDays.some((day) => !availability.includes(day))) {
        return res.status(400).json({
          error: 'Escolha somente dias disponíveis para o aluno de destino.',
          availability,
        });
      }

      const { rows: sourceExercises } = await pool.query(
        `SELECT exercise_id, name, sets, reps, suggested_weight, rest_seconds,
                notes, video_url, position
         FROM atlas_workout_exercises
         WHERE workout_id = $1
         ORDER BY position`,
        [source.id]
      );
      if (!sourceExercises.length) return res.status(400).json({ error: 'O treino de origem não possui exercícios.' });

      const copiedWorkoutId = crypto.randomUUID();
      const copiedName = cleanText(req.body?.name ?? source.name, 'Nome do treino', true, 120);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO atlas_workouts
            (id, trainer_id, student_id, name, model, description, intensity,
             estimated_minutes, scheduled_time, template_id, notes, scheduled_days)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::smallint[])`,
          [
            copiedWorkoutId, req.atlasUser.id, targetStudentId, copiedName, source.model,
            source.description || '', source.intensity || 'Moderada',
            Number(source.estimated_minutes || 0), source.scheduled_time || '',
            source.template_id || null, source.notes || '', scheduledDays,
          ]
        );

        for (const exercise of sourceExercises) {
          await client.query(
            `INSERT INTO atlas_workout_exercises
              (id, workout_id, exercise_id, name, sets, reps, suggested_weight,
               rest_seconds, notes, video_url, position)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              crypto.randomUUID(), copiedWorkoutId, exercise.exercise_id, exercise.name,
              exercise.sets, exercise.reps, exercise.suggested_weight,
              exercise.rest_seconds, exercise.notes || '', exercise.video_url || null,
              exercise.position,
            ]
          );
        }

        await client.query(
          `INSERT INTO atlas_notifications
            (id, user_id, type, title, body, reference_id, occurrence_key)
           VALUES ($1, $2, 'workout_prescribed', 'Novo treino prescrito', $3, $4, '')
           ON CONFLICT (user_id, type, reference_id, occurrence_key) DO NOTHING`,
          [crypto.randomUUID(), targetStudentId, copiedName, copiedWorkoutId]
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

      res.status(201).json({
        id: copiedWorkoutId,
        sourceWorkoutId: source.id,
        studentId: targetStudentId,
        name: copiedName,
        scheduledDays,
      });
    } catch (error) { next(error); }
  });

  app.get('/atlas-api/workouts', atlasRequireAuth, async (req, res, next) => {
    try {
      const ownerColumn = req.atlasUser.role === 'trainer' ? 'w.trainer_id' : 'w.student_id';
      const { rows: workouts } = await pool.query(
        `SELECT w.*, t.name AS trainer_name, t.avatar_url AS trainer_avatar_url,
                s.name AS student_name
         FROM atlas_workouts w
         JOIN atlas_users t ON t.id = w.trainer_id
         JOIN atlas_users s ON s.id = w.student_id
         WHERE ${ownerColumn} = $1
         ORDER BY w.created_at DESC`,
        [req.atlasUser.id]
      );
      const result = [];
      for (const workout of workouts) result.push(await workoutPayload(pool, workout));
      res.json(result);
    } catch (error) { next(error); }
  });

  app.get('/atlas-api/history', atlasRequireAuth, atlasRole('student'), async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT ws.id, ws.workout_id AS "workoutId", w.name AS "workoutName",
                w.model, t.name AS "trainerName",
                ws.started_at AS "startedAt", ws.completed_at AS "completedAt",
                ws.notes,
                COALESCE(SUM(sl.weight * sl.reps), 0)::float8 AS volume,
                COALESCE(MAX(sl.weight), 0)::float8 AS "maxWeight"
         FROM atlas_workout_sessions ws
         JOIN atlas_workouts w ON w.id = ws.workout_id
         JOIN atlas_users t ON t.id = w.trainer_id
         LEFT JOIN atlas_set_logs sl ON sl.session_id = ws.id AND sl.completed = TRUE
         WHERE ws.student_id = $1
         GROUP BY ws.id, w.id, t.id
         ORDER BY ws.started_at DESC`,
        [req.atlasUser.id]
      );
      res.json(rows);
    } catch (error) { next(error); }
  });

  app.get('/atlas-api/messages/contacts', atlasRequireAuth, async (req, res, next) => {
    try {
      const trainerMode = req.atlasUser.role === 'trainer';
      const linkedColumn = trainerMode ? 'ts.trainer_id' : 'ts.student_id';
      const contactJoin = trainerMode ? 'u.id = ts.student_id' : 'u.id = ts.trainer_id';
      const { rows } = await pool.query(
        `SELECT u.id, u.name, u.email, u.avatar_url AS "avatarUrl",
                lm.body AS "lastMessage", lm.created_at AS "lastMessageAt",
                COALESCE(unread.count, 0)::int AS "unreadCount"
         FROM atlas_trainer_students ts
         JOIN atlas_users u ON ${contactJoin}
         LEFT JOIN LATERAL (
           SELECT body, created_at FROM atlas_messages m
           WHERE m.trainer_id = ts.trainer_id AND m.student_id = ts.student_id
           ORDER BY created_at DESC LIMIT 1
         ) lm ON TRUE
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS count FROM atlas_messages m
           WHERE m.trainer_id = ts.trainer_id AND m.student_id = ts.student_id
             AND m.sender_id <> $1 AND m.read_at IS NULL
         ) unread ON TRUE
         WHERE ${linkedColumn} = $1
         ORDER BY COALESCE(lm.created_at, ts.linked_at) DESC`,
        [req.atlasUser.id]
      );
      res.json(rows);
    } catch (error) { next(error); }
  });

  app.get('/atlas-api/messages/:userId', atlasRequireAuth, async (req, res, next) => {
    try {
      const pair = await linkedPair(pool, req.atlasUser, req.params.userId);
      if (!pair) return res.status(404).json({ error: 'Contato não vinculado.' });
      await pool.query(
        `UPDATE atlas_messages SET read_at = NOW()
         WHERE trainer_id = $1 AND student_id = $2
           AND sender_id <> $3 AND read_at IS NULL`,
        [pair.trainerId, pair.studentId, req.atlasUser.id]
      );
      const { rows } = await pool.query(
        `SELECT id, sender_id AS "senderId", body, created_at AS "createdAt",
                read_at AS "readAt"
         FROM atlas_messages
         WHERE trainer_id = $1 AND student_id = $2
         ORDER BY created_at ASC LIMIT 300`,
        [pair.trainerId, pair.studentId]
      );
      res.json({ contact: pair, messages: rows });
    } catch (error) { next(error); }
  });

  app.post('/atlas-api/messages/:userId', atlasRequireAuth, async (req, res, next) => {
    try {
      const pair = await linkedPair(pool, req.atlasUser, req.params.userId);
      if (!pair) return res.status(404).json({ error: 'Contato não vinculado.' });
      const body = cleanText(req.body?.body, 'Mensagem', true, 2000);
      const id = crypto.randomUUID();
      const { rows } = await pool.query(
        `INSERT INTO atlas_messages
          (id, trainer_id, student_id, sender_id, body)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, sender_id AS "senderId", body, created_at AS "createdAt"`,
        [id, pair.trainerId, pair.studentId, req.atlasUser.id, body]
      );
      const recipientId = req.atlasUser.id === pair.trainerId ? pair.studentId : pair.trainerId;
      await pool.query(
        `INSERT INTO atlas_notifications
          (id, user_id, type, title, body, reference_id, occurrence_key)
         VALUES ($1, $2, 'message', 'Nova mensagem', $3, $4, $5)
         ON CONFLICT (user_id, type, reference_id, occurrence_key) DO NOTHING`,
        [crypto.randomUUID(), recipientId, body.slice(0, 180), id, id]
      );
      res.status(201).json(rows[0]);
    } catch (error) { next(error); }
  });

  app.get('/atlas-api/notifications', atlasRequireAuth, async (req, res, next) => {
    try {
      if (req.atlasUser.role === 'student') {
        const now = new Date();
        const dayOfWeek = now.getDay();
        const occurrenceKey = now.toISOString().slice(0, 10);
        const { rows: due } = await pool.query(
          'SELECT id, name, scheduled_time FROM atlas_workouts WHERE student_id = $1 AND $2 = ANY(scheduled_days)',
          [req.atlasUser.id, dayOfWeek]
        );
        for (const workout of due) {
          const body = workout.scheduled_time
            ? `${workout.name} · ${workout.scheduled_time}`
            : workout.name;
          await pool.query(
            `INSERT INTO atlas_notifications
              (id, user_id, type, title, body, reference_id, occurrence_key)
             VALUES ($1, $2, 'workout_reminder', 'Treino de hoje', $3, $4, $5)
             ON CONFLICT (user_id, type, reference_id, occurrence_key) DO NOTHING`,
            [crypto.randomUUID(), req.atlasUser.id, body, workout.id, occurrenceKey]
          );
        }
      }
      const { rows } = await pool.query(
        `SELECT id, type, title, body, reference_id AS "referenceId",
                read_at AS "readAt", created_at AS "createdAt"
         FROM atlas_notifications
         WHERE user_id = $1
         ORDER BY created_at DESC LIMIT 100`,
        [req.atlasUser.id]
      );
      res.json(rows);
    } catch (error) { next(error); }
  });

  app.post('/atlas-api/notifications/:id/read', atlasRequireAuth, async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `UPDATE atlas_notifications SET read_at = NOW()
         WHERE id = $1 AND user_id = $2
         RETURNING id, read_at AS "readAt"`,
        [req.params.id, req.atlasUser.id]
      );
      if (!rows[0]) return res.status(404).json({ error: 'Notificação não encontrada.' });
      res.json(rows[0]);
    } catch (error) { next(error); }
  });

  app.post('/atlas-api/notifications/read-all', atlasRequireAuth, async (req, res, next) => {
    try {
      await pool.query(
        'UPDATE atlas_notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL',
        [req.atlasUser.id]
      );
      res.json({ ok: true });
    } catch (error) { next(error); }
  });

  app.get('/atlas-api/progress/me', atlasRequireAuth, atlasRole('student'), async (req, res, next) => {
    try { res.json(await progressForStudent(pool, req.atlasUser.id)); }
    catch (error) { next(error); }
  });

  app.get('/atlas-api/trainer/students/:id/progress', atlasRequireAuth, atlasRole('trainer'), async (req, res, next) => {
    try {
      const pair = await linkedPair(pool, req.atlasUser, req.params.id);
      if (!pair) return res.status(404).json({ error: 'Aluno não vinculado.' });
      res.json(await progressForStudent(pool, req.params.id, req.atlasUser.id));
    } catch (error) { next(error); }
  });

  app.get('/atlas-api/trainer/students/:id/report', atlasRequireAuth, atlasRole('trainer'), async (req, res, next) => {
    try {
      const pair = await linkedPair(pool, req.atlasUser, req.params.id);
      if (!pair) return res.status(404).json({ error: 'Aluno não vinculado.' });
      const progress = await progressForStudent(pool, req.params.id, req.atlasUser.id);
      res.json({
        generatedAt: new Date().toISOString(),
        student: { id: pair.studentId, name: pair.studentName },
        trainer: { id: pair.trainerId, name: pair.trainerName },
        ...progress,
      });
    } catch (error) { next(error); }
  });
}
