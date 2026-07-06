-- =============================================================================
-- AUTOESCUELA CRM — Schema completo para Supabase
-- =============================================================================
-- Ejecutar de una sola vez en el SQL Editor de Supabase.
-- Orden de creación: extensiones → enums → tablas base → tablas dependientes
--                    → índices → RLS → funciones → triggers
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0. Extensiones necesarias
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";   -- uuid_generate_v4()
CREATE EXTENSION IF NOT EXISTS "pg_trgm";     -- búsqueda fuzzy en nombres


-- ---------------------------------------------------------------------------
-- 1. ENUMS
-- ---------------------------------------------------------------------------

CREATE TYPE vehicle_type   AS ENUM ('manual', 'automatico', 'moto', 'camion');
CREATE TYPE slot_type      AS ENUM ('practica', 'examen');
CREATE TYPE slot_status    AS ENUM ('confirmed', 'cancelled', 'pending');
CREATE TYPE creator_type   AS ENUM ('bot', 'admin', 'prof');
CREATE TYPE exam_result    AS ENUM ('apto', 'no_apto');
CREATE TYPE user_role      AS ENUM ('admin', 'professor');
CREATE TYPE day_key        AS ENUM ('lun', 'mar', 'mie', 'jue', 'vie', 'sab');
CREATE TYPE license_type   AS ENUM ('A', 'A1', 'A2', 'AM', 'B', 'BE', 'C', 'CE', 'D');


-- ---------------------------------------------------------------------------
-- 2. TABLA: schools  (multi-escuela — raíz del sistema)
-- ---------------------------------------------------------------------------
-- Cada fila representa una autoescuela cliente. Todas las tablas principales
-- tienen FK → schools.id para aislar datos entre clientes.
-- ---------------------------------------------------------------------------

CREATE TABLE schools (
    id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        TEXT        NOT NULL,
    color       TEXT        NOT NULL DEFAULT '#fd761a', -- color de marca en hex
    bot_url     TEXT,                                   -- endpoint del bot de WhatsApp
    slug        TEXT        UNIQUE,                     -- subdominio amigable p.ej. "autoescuela-norte"
    active      BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE schools IS
  'Tabla raíz multi-tenant. Cada fila es una autoescuela cliente del SaaS.';


-- ---------------------------------------------------------------------------
-- 3. TABLA: professors  (profesores / instructores)
-- ---------------------------------------------------------------------------

CREATE TABLE professors (
    id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    school_id   UUID        NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    name        TEXT        NOT NULL,
    phone       TEXT,
    email       TEXT,
    color       TEXT        NOT NULL DEFAULT '#1e3a5f', -- color en la agenda
    active      BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE professors IS
  'Instructores de la autoescuela. Vinculados a una escuela y opcionalmente a un usuario.';


-- ---------------------------------------------------------------------------
-- 4. TABLA: users  (extiende auth.users de Supabase)
-- ---------------------------------------------------------------------------
-- No almacenamos contraseñas; Supabase Auth las gestiona en auth.users.
-- Esta tabla guarda el rol de negocio y el perfil adicional.
-- ---------------------------------------------------------------------------

CREATE TABLE users (
    id          UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    school_id   UUID        NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    email       TEXT        NOT NULL,
    role        user_role   NOT NULL DEFAULT 'professor',
    prof_id     UUID        REFERENCES professors(id) ON DELETE SET NULL, -- NULL si es admin
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Un usuario solo puede estar vinculado a una escuela
    CONSTRAINT users_email_school_unique UNIQUE (email, school_id)
);

COMMENT ON TABLE users IS
  'Extiende auth.users con rol de negocio. prof_id enlaza al profesor cuando role=professor.';


-- ---------------------------------------------------------------------------
-- 5. TABLA: students  (alumnos)
-- ---------------------------------------------------------------------------

CREATE TABLE students (
    id              UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
    school_id       UUID          NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    prof_id         UUID          REFERENCES professors(id) ON DELETE SET NULL,
    name            TEXT          NOT NULL,
    phone           TEXT,
    license         license_type  NOT NULL DEFAULT 'B',
    vehicle_type    vehicle_type  NOT NULL DEFAULT 'manual',
    num_clases      INT           NOT NULL DEFAULT 0 CHECK (num_clases >= 0),
    bono            TEXT,                                -- "Bono 10", "Bono 20", "Sin bono"…
    tasas_pagadas   BOOLEAN       NOT NULL DEFAULT FALSE,
    active          BOOLEAN       NOT NULL DEFAULT TRUE,
    bot_active      BOOLEAN       NOT NULL DEFAULT FALSE, -- bot de WhatsApp activado para este alumno
    exam_date       DATE,
    exam_result     exam_result,
    notes           TEXT,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE students IS
  'Alumnos matriculados. num_clases se gestiona automáticamente mediante trigger en slots.';


-- ---------------------------------------------------------------------------
-- 6. TABLA: vehicles  (vehículos de prácticas)
-- ---------------------------------------------------------------------------

CREATE TABLE vehicles (
    id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    school_id   UUID        NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    name        TEXT        NOT NULL,       -- "Seat Ibiza"
    plate       TEXT        NOT NULL,       -- "1234 ABC"
    type        TEXT        NOT NULL DEFAULT 'B', -- tipo de permiso asociado
    active      BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ---------------------------------------------------------------------------
-- 7. TABLA: slots  (clases y exámenes programados)
-- ---------------------------------------------------------------------------

CREATE TABLE slots (
    id              UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
    school_id       UUID          NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    student_id      UUID          NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    prof_id         UUID          NOT NULL REFERENCES professors(id) ON DELETE CASCADE,
    vehicle_id      UUID          REFERENCES vehicles(id) ON DELETE SET NULL,
    date            DATE          NOT NULL,
    time            TIME          NOT NULL,
    duration        INT           NOT NULL DEFAULT 60 CHECK (duration > 0), -- minutos
    slot_type       slot_type     NOT NULL DEFAULT 'practica',
    status          slot_status   NOT NULL DEFAULT 'pending',
    reminder_sent   BOOLEAN       NOT NULL DEFAULT FALSE,
    created_by      creator_type  NOT NULL DEFAULT 'admin',
    notes           TEXT,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

    -- No puede haber dos slots del mismo profesor en la misma fecha/hora
    CONSTRAINT slots_prof_datetime_unique UNIQUE (prof_id, date, time)
);

COMMENT ON TABLE slots IS
  'Clases y exámenes. Los triggers actualizan num_clases en students al insertar/cancelar/eliminar.';


-- ---------------------------------------------------------------------------
-- 8. TABLA: availability  (disponibilidad semanal por profesor)
-- ---------------------------------------------------------------------------
-- Cada fila = un día de la semana para un profesor + array de horas libres.
-- ---------------------------------------------------------------------------

CREATE TABLE availability (
    id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    school_id   UUID        NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    prof_id     UUID        NOT NULL REFERENCES professors(id) ON DELETE CASCADE,
    day_key     day_key     NOT NULL,
    hours       TEXT[]      NOT NULL DEFAULT '{}', -- ["09:00","10:00","11:00"...]
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Un solo registro por profesor-día
    CONSTRAINT availability_prof_day_unique UNIQUE (prof_id, day_key)
);

COMMENT ON TABLE availability IS
  'Horas disponibles semanales (lun-sáb) por profesor. Usadas por get_next_free_slots().';


-- ---------------------------------------------------------------------------
-- 9. TABLA: blocked_hours  (bloqueos puntuales de horas)
-- ---------------------------------------------------------------------------
-- Vacaciones, citas médicas, días festivos específicos del profesor.
-- ---------------------------------------------------------------------------

CREATE TABLE blocked_hours (
    id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
    school_id   UUID        NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
    prof_id     UUID        NOT NULL REFERENCES professors(id) ON DELETE CASCADE,
    date        DATE        NOT NULL,
    hour        TIME        NOT NULL,
    reason      TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT blocked_hours_prof_datetime_unique UNIQUE (prof_id, date, hour)
);

COMMENT ON TABLE blocked_hours IS
  'Horas puntuales bloqueadas por el profesor (vacaciones, festivos…). Respetadas por get_next_free_slots().';


-- ---------------------------------------------------------------------------
-- 10. TABLA: school_config  (configuración adicional por escuela)
-- ---------------------------------------------------------------------------
-- Extiende schools con parámetros operativos que pueden cambiar con frecuencia.
-- ---------------------------------------------------------------------------

CREATE TABLE school_config (
    school_id           UUID    PRIMARY KEY REFERENCES schools(id) ON DELETE CASCADE,
    slot_duration_min   INT     NOT NULL DEFAULT 60,     -- duración estándar de clase en minutos
    working_hours_start TIME    NOT NULL DEFAULT '08:00',
    working_hours_end   TIME    NOT NULL DEFAULT '20:00',
    reminder_hours_before INT   NOT NULL DEFAULT 24,     -- horas antes para enviar recordatorio
    bot_enabled         BOOLEAN NOT NULL DEFAULT FALSE,
    max_slots_per_day   INT     NOT NULL DEFAULT 8,      -- máximo de clases/día por profesor
    extra_config        JSONB   NOT NULL DEFAULT '{}'::jsonb, -- parámetros adicionales sin esquema fijo
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE school_config IS
  'Parámetros operativos de cada escuela: duración de clase, horario, configuración del bot, etc.';


-- ---------------------------------------------------------------------------
-- 11. ÍNDICES
-- ---------------------------------------------------------------------------
-- Cubrimos los campos más consultados: búsquedas por fecha, prof y alumno.
-- ---------------------------------------------------------------------------

-- students
CREATE INDEX idx_students_school      ON students(school_id);
CREATE INDEX idx_students_prof        ON students(prof_id);
CREATE INDEX idx_students_active      ON students(school_id, active) WHERE active = TRUE;
CREATE INDEX idx_students_name_trgm   ON students USING gin(name gin_trgm_ops); -- búsqueda fuzzy

-- slots
CREATE INDEX idx_slots_school         ON slots(school_id);
CREATE INDEX idx_slots_prof           ON slots(prof_id);
CREATE INDEX idx_slots_student        ON slots(student_id);
CREATE INDEX idx_slots_date           ON slots(date);
CREATE INDEX idx_slots_prof_date      ON slots(prof_id, date);           -- agenda del prof
CREATE INDEX idx_slots_school_date    ON slots(school_id, date);         -- vista de admin
CREATE INDEX idx_slots_status         ON slots(status) WHERE status <> 'cancelled';

-- availability
CREATE INDEX idx_availability_prof    ON availability(prof_id);

-- blocked_hours
CREATE INDEX idx_blocked_prof_date    ON blocked_hours(prof_id, date);

-- professors
CREATE INDEX idx_professors_school    ON professors(school_id);

-- users
CREATE INDEX idx_users_school         ON users(school_id);
CREATE INDEX idx_users_prof           ON users(prof_id);


-- ---------------------------------------------------------------------------
-- 12. FUNCIONES HELPER
-- ---------------------------------------------------------------------------

-- ─── 12.1 get_next_free_slots ────────────────────────────────────────────────
-- Devuelve los próximos N huecos libres de un profesor, respetando:
--   · Su disponibilidad semanal (tabla availability)
--   · Sus bloqueos puntuales   (tabla blocked_hours)
--   · Los slots ya reservados  (tabla slots, solo confirmed/pending)
-- Parámetros:
--   p_prof_id  — UUID del profesor
--   p_count    — cuántos huecos devolver (default 5)
--   p_from     — fecha de inicio de búsqueda (default hoy)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_next_free_slots(
    p_prof_id  UUID,
    p_count    INT  DEFAULT 5,
    p_from     DATE DEFAULT CURRENT_DATE
)
RETURNS TABLE (
    available_date  DATE,
    available_time  TIME,
    day_name        TEXT
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_date          DATE;
    v_day_key       day_key;
    v_hours         TEXT[];
    v_hour_text     TEXT;
    v_hour_time     TIME;
    v_found         INT  := 0;
    v_max_days      INT  := 90; -- buscar como máximo 90 días hacia adelante
    v_day_names     TEXT[] := ARRAY['lun','mar','mie','jue','vie','sab'];
    v_dow           INT;  -- 0=domingo … 6=sábado (extract dow)
BEGIN
    v_date := p_from;

    WHILE v_found < p_count AND v_date <= p_from + v_max_days LOOP

        -- extract(dow) devuelve 0=domingo, 1=lunes…6=sábado
        v_dow := EXTRACT(dow FROM v_date);

        -- Saltamos domingos (no hay disponibilidad)
        IF v_dow = 0 THEN
            v_date := v_date + 1;
            CONTINUE;
        END IF;

        -- Mapear DOW → day_key enum  (1=lun … 6=sab)
        v_day_key := CASE v_dow
            WHEN 1 THEN 'lun'
            WHEN 2 THEN 'mar'
            WHEN 3 THEN 'mie'
            WHEN 4 THEN 'jue'
            WHEN 5 THEN 'vie'
            WHEN 6 THEN 'sab'
        END::day_key;

        -- Obtener horas disponibles para ese día
        SELECT a.hours INTO v_hours
        FROM availability a
        WHERE a.prof_id = p_prof_id AND a.day_key = v_day_key
        LIMIT 1;

        -- Si no tiene disponibilidad ese día, pasamos al siguiente
        IF v_hours IS NULL OR array_length(v_hours, 1) IS NULL THEN
            v_date := v_date + 1;
            CONTINUE;
        END IF;

        -- Iterar horas disponibles ordenadas
        FOREACH v_hour_text IN ARRAY v_hours LOOP
            EXIT WHEN v_found >= p_count;

            v_hour_time := v_hour_text::TIME;

            -- Comprobar que no esté bloqueada manualmente
            IF EXISTS (
                SELECT 1 FROM blocked_hours bh
                WHERE bh.prof_id = p_prof_id
                  AND bh.date    = v_date
                  AND bh.hour    = v_hour_time
            ) THEN
                CONTINUE;
            END IF;

            -- Comprobar que no haya un slot ya reservado (confirmed o pending)
            IF EXISTS (
                SELECT 1 FROM slots s
                WHERE s.prof_id = p_prof_id
                  AND s.date    = v_date
                  AND s.time    = v_hour_time
                  AND s.status  IN ('confirmed', 'pending')
            ) THEN
                CONTINUE;
            END IF;

            -- Hueco libre encontrado
            available_date := v_date;
            available_time := v_hour_time;
            day_name       := initcap(v_day_key::TEXT);
            RETURN NEXT;
            v_found := v_found + 1;

        END LOOP;

        v_date := v_date + 1;

    END LOOP;

    RETURN;
END;
$$;

COMMENT ON FUNCTION get_next_free_slots IS
  'Devuelve los próximos huecos libres de un profesor respetando availability y blocked_hours.
   Uso: SELECT * FROM get_next_free_slots(''<prof_uuid>'', 5);';


-- ─── 12.2 get_student_stats ──────────────────────────────────────────────────
-- Función de conveniencia para el dashboard: clases totales, aptos, etc.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION get_student_stats(p_school_id UUID)
RETURNS TABLE (
    total_students      BIGINT,
    active_students     BIGINT,
    total_slots_today   BIGINT,
    aptos_this_month    BIGINT,
    no_aptos_this_month BIGINT
)
LANGUAGE sql
STABLE
AS $$
    SELECT
        COUNT(*)                                                       AS total_students,
        COUNT(*) FILTER (WHERE active)                                 AS active_students,
        (SELECT COUNT(*) FROM slots
         WHERE school_id = p_school_id
           AND date = CURRENT_DATE
           AND status <> 'cancelled')                                  AS total_slots_today,
        (SELECT COUNT(*) FROM students
         WHERE school_id = p_school_id
           AND exam_result = 'apto'
           AND DATE_TRUNC('month', exam_date) = DATE_TRUNC('month', CURRENT_DATE)
        )                                                              AS aptos_this_month,
        (SELECT COUNT(*) FROM students
         WHERE school_id = p_school_id
           AND exam_result = 'no_apto'
           AND DATE_TRUNC('month', exam_date) = DATE_TRUNC('month', CURRENT_DATE)
        )                                                              AS no_aptos_this_month
    FROM students
    WHERE school_id = p_school_id;
$$;


-- ---------------------------------------------------------------------------
-- 13. TRIGGERS
-- ---------------------------------------------------------------------------

-- ─── 13.1 Actualizar num_clases al insertar/cancelar/eliminar slots ──────────
-- Reglas:
--   · INSERT de slot con status confirmed/pending  → num_clases + 1
--   · UPDATE slot:  de (confirmed/pending) → cancelled  → num_clases - 1
--                   de cancelled → (confirmed/pending)  → num_clases + 1
--   · DELETE de slot confirmed/pending              → num_clases - 1
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION trg_update_student_num_clases()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_delta INT := 0;
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- Solo contamos si no está ya cancelado
        IF NEW.status IN ('confirmed', 'pending') THEN
            v_delta := 1;
        END IF;

    ELSIF TG_OP = 'UPDATE' THEN
        -- El slot pasa a cancelado → descontar
        IF OLD.status IN ('confirmed', 'pending') AND NEW.status = 'cancelled' THEN
            v_delta := -1;
        -- El slot vuelve de cancelado a activo → sumar
        ELSIF OLD.status = 'cancelled' AND NEW.status IN ('confirmed', 'pending') THEN
            v_delta := 1;
        END IF;

    ELSIF TG_OP = 'DELETE' THEN
        IF OLD.status IN ('confirmed', 'pending') THEN
            v_delta := -1;
        END IF;
    END IF;

    IF v_delta <> 0 THEN
        UPDATE students
        SET
            num_clases = GREATEST(0, num_clases + v_delta),
            updated_at = NOW()
        WHERE id = COALESCE(NEW.student_id, OLD.student_id);
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_slots_num_clases
    AFTER INSERT OR UPDATE OF status OR DELETE
    ON slots
    FOR EACH ROW
    EXECUTE FUNCTION trg_update_student_num_clases();

COMMENT ON FUNCTION trg_update_student_num_clases IS
  'Mantiene students.num_clases sincronizado con los slots activos (confirmed/pending).';


-- ─── 13.2 updated_at automático ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION trg_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_schools_updated_at
    BEFORE UPDATE ON schools
    FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

CREATE TRIGGER trg_professors_updated_at
    BEFORE UPDATE ON professors
    FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

CREATE TRIGGER trg_students_updated_at
    BEFORE UPDATE ON students
    FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

CREATE TRIGGER trg_slots_updated_at
    BEFORE UPDATE ON slots
    FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();


-- ─── 13.3 Crear school_config automáticamente al insertar una escuela ────────

CREATE OR REPLACE FUNCTION trg_init_school_config()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO school_config (school_id)
    VALUES (NEW.id)
    ON CONFLICT (school_id) DO NOTHING;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_schools_init_config
    AFTER INSERT ON schools
    FOR EACH ROW EXECUTE FUNCTION trg_init_school_config();


-- ---------------------------------------------------------------------------
-- 14. ROW LEVEL SECURITY (RLS)
-- ---------------------------------------------------------------------------
-- Políticas:
--   · Los profesores solo ven/editan datos de su propia escuela y sus propios
--     registros (slots, alumnos asignados a ellos, su disponibilidad).
--   · Los admins ven y editan todo dentro de su escuela.
--   · El service_role (backend / bot) omite RLS → usa la clave service_role.
-- ---------------------------------------------------------------------------

-- Habilitar RLS en todas las tablas principales
ALTER TABLE schools          ENABLE ROW LEVEL SECURITY;
ALTER TABLE professors       ENABLE ROW LEVEL SECURITY;
ALTER TABLE users            ENABLE ROW LEVEL SECURITY;
ALTER TABLE students         ENABLE ROW LEVEL SECURITY;
ALTER TABLE slots            ENABLE ROW LEVEL SECURITY;
ALTER TABLE availability     ENABLE ROW LEVEL SECURITY;
ALTER TABLE blocked_hours    ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicles         ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_config    ENABLE ROW LEVEL SECURITY;


-- ─── Función auxiliar para obtener el school_id del usuario autenticado ───────
-- Se llama en cada política RLS; Supabase la evalúa una sola vez por query.

CREATE OR REPLACE FUNCTION auth_school_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT school_id FROM users WHERE id = auth.uid() LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION auth_role()
RETURNS user_role
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT role FROM users WHERE id = auth.uid() LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION auth_prof_id()
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT prof_id FROM users WHERE id = auth.uid() LIMIT 1;
$$;


-- ─── SCHOOLS ─────────────────────────────────────────────────────────────────
-- Un usuario autenticado solo ve su propia escuela.

CREATE POLICY "schools_select_own"
    ON schools FOR SELECT
    USING (id = auth_school_id());

CREATE POLICY "schools_update_admin"
    ON schools FOR UPDATE
    USING (id = auth_school_id() AND auth_role() = 'admin');


-- ─── PROFESSORS ──────────────────────────────────────────────────────────────

CREATE POLICY "professors_select_own_school"
    ON professors FOR SELECT
    USING (school_id = auth_school_id());

CREATE POLICY "professors_insert_admin"
    ON professors FOR INSERT
    WITH CHECK (school_id = auth_school_id() AND auth_role() = 'admin');

CREATE POLICY "professors_update_admin"
    ON professors FOR UPDATE
    USING (school_id = auth_school_id() AND auth_role() = 'admin');

CREATE POLICY "professors_delete_admin"
    ON professors FOR DELETE
    USING (school_id = auth_school_id() AND auth_role() = 'admin');


-- ─── USERS ───────────────────────────────────────────────────────────────────

-- Cada usuario puede verse a sí mismo; el admin ve todos los de su escuela.
CREATE POLICY "users_select"
    ON users FOR SELECT
    USING (
        school_id = auth_school_id()
        AND (auth_role() = 'admin' OR id = auth.uid())
    );

CREATE POLICY "users_insert_admin"
    ON users FOR INSERT
    WITH CHECK (school_id = auth_school_id() AND auth_role() = 'admin');

CREATE POLICY "users_update_admin_or_self"
    ON users FOR UPDATE
    USING (
        school_id = auth_school_id()
        AND (auth_role() = 'admin' OR id = auth.uid())
    );

CREATE POLICY "users_delete_admin"
    ON users FOR DELETE
    USING (school_id = auth_school_id() AND auth_role() = 'admin');


-- ─── STUDENTS ────────────────────────────────────────────────────────────────
-- Admin ve todos. Profesor ve solo sus alumnos asignados.

CREATE POLICY "students_select"
    ON students FOR SELECT
    USING (
        school_id = auth_school_id()
        AND (
            auth_role() = 'admin'
            OR prof_id = auth_prof_id()
        )
    );

CREATE POLICY "students_insert_admin"
    ON students FOR INSERT
    WITH CHECK (school_id = auth_school_id() AND auth_role() = 'admin');

CREATE POLICY "students_update"
    ON students FOR UPDATE
    USING (
        school_id = auth_school_id()
        AND (
            auth_role() = 'admin'
            OR prof_id = auth_prof_id()
        )
    );

CREATE POLICY "students_delete_admin"
    ON students FOR DELETE
    USING (school_id = auth_school_id() AND auth_role() = 'admin');


-- ─── SLOTS ───────────────────────────────────────────────────────────────────
-- Admin ve todos. Profesor ve solo sus propios slots.

CREATE POLICY "slots_select"
    ON slots FOR SELECT
    USING (
        school_id = auth_school_id()
        AND (
            auth_role() = 'admin'
            OR prof_id = auth_prof_id()
        )
    );

CREATE POLICY "slots_insert"
    ON slots FOR INSERT
    WITH CHECK (
        school_id = auth_school_id()
        AND (
            auth_role() = 'admin'
            OR prof_id = auth_prof_id()
        )
    );

CREATE POLICY "slots_update"
    ON slots FOR UPDATE
    USING (
        school_id = auth_school_id()
        AND (
            auth_role() = 'admin'
            OR prof_id = auth_prof_id()
        )
    );

CREATE POLICY "slots_delete_admin"
    ON slots FOR DELETE
    USING (school_id = auth_school_id() AND auth_role() = 'admin');


-- ─── AVAILABILITY ─────────────────────────────────────────────────────────────
-- Admin ve todas. Profesor gestiona solo la suya.

CREATE POLICY "availability_select"
    ON availability FOR SELECT
    USING (
        school_id = auth_school_id()
        AND (
            auth_role() = 'admin'
            OR prof_id = auth_prof_id()
        )
    );

CREATE POLICY "availability_insert"
    ON availability FOR INSERT
    WITH CHECK (
        school_id = auth_school_id()
        AND (
            auth_role() = 'admin'
            OR prof_id = auth_prof_id()
        )
    );

CREATE POLICY "availability_update"
    ON availability FOR UPDATE
    USING (
        school_id = auth_school_id()
        AND (
            auth_role() = 'admin'
            OR prof_id = auth_prof_id()
        )
    );

CREATE POLICY "availability_delete"
    ON availability FOR DELETE
    USING (
        school_id = auth_school_id()
        AND (
            auth_role() = 'admin'
            OR prof_id = auth_prof_id()
        )
    );


-- ─── BLOCKED_HOURS ────────────────────────────────────────────────────────────

CREATE POLICY "blocked_hours_select"
    ON blocked_hours FOR SELECT
    USING (
        school_id = auth_school_id()
        AND (
            auth_role() = 'admin'
            OR prof_id = auth_prof_id()
        )
    );

CREATE POLICY "blocked_hours_insert"
    ON blocked_hours FOR INSERT
    WITH CHECK (
        school_id = auth_school_id()
        AND (
            auth_role() = 'admin'
            OR prof_id = auth_prof_id()
        )
    );

CREATE POLICY "blocked_hours_update"
    ON blocked_hours FOR UPDATE
    USING (
        school_id = auth_school_id()
        AND (
            auth_role() = 'admin'
            OR prof_id = auth_prof_id()
        )
    );

CREATE POLICY "blocked_hours_delete"
    ON blocked_hours FOR DELETE
    USING (
        school_id = auth_school_id()
        AND (
            auth_role() = 'admin'
            OR prof_id = auth_prof_id()
        )
    );


-- ─── VEHICLES ─────────────────────────────────────────────────────────────────

CREATE POLICY "vehicles_select_own_school"
    ON vehicles FOR SELECT
    USING (school_id = auth_school_id());

CREATE POLICY "vehicles_write_admin"
    ON vehicles FOR ALL
    USING (school_id = auth_school_id() AND auth_role() = 'admin');


-- ─── SCHOOL_CONFIG ────────────────────────────────────────────────────────────

CREATE POLICY "school_config_select"
    ON school_config FOR SELECT
    USING (school_id = auth_school_id());

CREATE POLICY "school_config_update_admin"
    ON school_config FOR UPDATE
    USING (school_id = auth_school_id() AND auth_role() = 'admin');


-- ---------------------------------------------------------------------------
-- 15. DATOS DE EJEMPLO (seed mínimo para desarrollo)
-- ---------------------------------------------------------------------------
-- Descomenta este bloque si quieres datos de prueba al ejecutar el schema.
-- En producción, NO ejecutar.
-- ---------------------------------------------------------------------------

/*
DO $$
DECLARE
    v_school_id   UUID;
    v_prof1_id    UUID;
    v_prof2_id    UUID;
    v_prof3_id    UUID;
    v_student_id  UUID;
BEGIN

    -- Escuela de prueba
    INSERT INTO schools (name, color, slug)
    VALUES ('AutoEscuela Demo', '#fd761a', 'demo')
    RETURNING id INTO v_school_id;

    -- Profesores
    INSERT INTO professors (school_id, name, phone, email, color)
    VALUES (v_school_id, 'Iñaki González', '666111222', 'inaki@demo.es', '#1e3a5f')
    RETURNING id INTO v_prof1_id;

    INSERT INTO professors (school_id, name, phone, email, color)
    VALUES (v_school_id, 'Carlos Ruiz', '666333444', 'carlos@demo.es', '#7c2d8c')
    RETURNING id INTO v_prof2_id;

    INSERT INTO professors (school_id, name, phone, email, color)
    VALUES (v_school_id, 'María López', '666555666', 'maria@demo.es', '#0e6856')
    RETURNING id INTO v_prof3_id;

    -- Disponibilidad semanal de Iñaki (lun-vie, 9-14h)
    INSERT INTO availability (school_id, prof_id, day_key, hours) VALUES
    (v_school_id, v_prof1_id, 'lun', ARRAY['09:00','10:00','11:00','12:00','13:00']),
    (v_school_id, v_prof1_id, 'mar', ARRAY['09:00','10:00','11:00','12:00','13:00']),
    (v_school_id, v_prof1_id, 'mie', ARRAY['09:00','10:00','11:00','12:00','13:00']),
    (v_school_id, v_prof1_id, 'jue', ARRAY['09:00','10:00','11:00','12:00','13:00']),
    (v_school_id, v_prof1_id, 'vie', ARRAY['09:00','10:00','11:00','12:00','13:00']);

    -- Alumno de prueba asignado a Iñaki
    INSERT INTO students (school_id, prof_id, name, phone, license, vehicle_type, bono, tasas_pagadas)
    VALUES (v_school_id, v_prof1_id, 'Ana García', '611000001', 'B', 'manual', 'Bono 10', TRUE)
    RETURNING id INTO v_student_id;

    -- Slot de práctica para hoy
    INSERT INTO slots (school_id, student_id, prof_id, date, time, slot_type, status, created_by)
    VALUES (v_school_id, v_student_id, v_prof1_id, CURRENT_DATE, '10:00', 'practica', 'confirmed', 'admin');

    RAISE NOTICE 'Seed completado. School ID: %', v_school_id;
END;
$$;
*/


-- ---------------------------------------------------------------------------
-- FIN DEL SCHEMA
-- =============================================================================
-- Resumen de objetos creados:
--
--   ENUMs      : vehicle_type, slot_type, slot_status, creator_type,
--                exam_result, user_role, day_key, license_type
--
--   TABLAS     : schools, professors, users, students, vehicles,
--                slots, availability, blocked_hours, school_config
--
--   ÍNDICES    : 14 índices sobre los campos más consultados
--
--   FUNCIONES  : get_next_free_slots()   — próximos huecos libres
--                get_student_stats()     — métricas del dashboard
--                auth_school_id()        — helper RLS
--                auth_role()             — helper RLS
--                auth_prof_id()          — helper RLS
--                trg_update_student_num_clases() — trigger handler
--                trg_set_updated_at()    — trigger handler
--                trg_init_school_config() — trigger handler
--
--   TRIGGERS   : trg_slots_num_clases      — sincroniza num_clases en students
--                trg_*_updated_at          — actualiza updated_at automáticamente
--                trg_schools_init_config   — crea school_config al crear escuela
--
--   RLS        : Activo en todas las tablas. Profesor ve solo su scope;
--                Admin ve todo su school_id.
-- =============================================================================
