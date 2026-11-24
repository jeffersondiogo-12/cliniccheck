const express = require('express');
const { randomUUID } = require('crypto');
const { query } = require('../config/database');
const { requireDoctorOrReceptionist } = require('../middleware/auth');
const gcal = require('../services/googleCalendarService');
const socketService = require('../services/socketService');
const { provisionarSessao, enviarLinkPorEmail } = require('../services/teleconsultationProvisioningService');

const router = express.Router();

async function hasColumn(tableName, columnName) {
  const found = await query(
    `SELECT 1
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
      LIMIT 1`,
    [tableName, columnName]
  );
  return found.rowCount > 0;
}

function buildGoogleCalendarLink({ title, description, startAt, endAt }) {
  const start = new Date(startAt || Date.now());
  const end = new Date(endAt || (start.getTime() + 30 * 60 * 1000));
  const fmt = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title || 'Consulta - Clinica Aline',
    details: description || '',
    dates: `${fmt(start)}/${fmt(end)}`,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function normalizeConsultationAt(value) {
  if (!value) return value;
  const raw = String(value).trim();
  if (!raw) return raw;
  if (/[+-]\d{2}:\d{2}$/.test(raw) || raw.endsWith('Z')) return raw;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw)) {
    return `${raw}:00-03:00`;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(raw)) {
    return `${raw}-03:00`;
  }
  return raw;
}

function normalizeDurationMin(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 30;
  if (parsed < 10) return 10;
  if (parsed > 240) return 240;
  return Math.round(parsed);
}

function normalizeDateTime(value) {
  if (!value) return null;
  return normalizeConsultationAt(value);
}

function normalizeColorHex(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
  return null;
}

function normalizeGuests(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((v) => String(v || '').trim().toLowerCase()).filter((v) => /.+@.+\..+/.test(v)))];
  }
  if (typeof value === 'string') {
    return [...new Set(value.split(',').map((v) => v.trim().toLowerCase()).filter((v) => /.+@.+\..+/.test(v)))];
  }
  return [];
}

function normalizeReminders(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',').map((v) => v.trim())
      : [];

  const parsed = raw
    .map((v) => Number(v?.minutes ?? v))
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 10080)
    .map((n) => Math.round(n));

  return [...new Set(parsed)].sort((a, b) => a - b);
}

function parseRecurrence(input) {
  const rec = input && typeof input === 'object' ? input : null;
  if (!rec || !rec.frequency) return null;

  const frequency = String(rec.frequency).toUpperCase();
  if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(frequency)) return null;

  const interval = Math.max(1, Math.min(12, Number(rec.interval || 1)));
  const endType = String(rec.endType || 'count').toLowerCase();
  const count = Math.max(1, Math.min(120, Number(rec.count || 1)));
  const until = rec.until ? normalizeConsultationAt(rec.until) : null;

  return {
    enabled: true,
    frequency,
    interval,
    endType: ['count', 'until'].includes(endType) ? endType : 'count',
    count,
    until,
  };
}

function addFrequency(baseDate, frequency, interval) {
  const d = new Date(baseDate.getTime());
  if (frequency === 'DAILY') d.setDate(d.getDate() + interval);
  if (frequency === 'WEEKLY') d.setDate(d.getDate() + (7 * interval));
  if (frequency === 'MONTHLY') d.setMonth(d.getMonth() + interval);
  return d;
}

function buildOccurrenceDates(startAt, recurrence) {
  const first = new Date(startAt);
  if (!recurrence?.enabled) return [first];

  const dates = [first];
  const maxCount = recurrence.endType === 'count' ? recurrence.count : 120;
  const untilDate = recurrence.endType === 'until' && recurrence.until ? new Date(recurrence.until) : null;

  while (dates.length < maxCount) {
    const next = addFrequency(dates[dates.length - 1], recurrence.frequency, recurrence.interval);
    if (untilDate && next > untilDate) break;
    dates.push(next);
  }
  return dates;
}

async function ensureConsultationAdvancedSchema() {
  await query(`ALTER TABLE consultations ADD COLUMN IF NOT EXISTS notes text`);
  await query(`ALTER TABLE consultations ADD COLUMN IF NOT EXISTS color_hex text`);
  await query(`ALTER TABLE consultations ADD COLUMN IF NOT EXISTS guests_json jsonb NOT NULL DEFAULT '[]'::jsonb`);
  await query(`ALTER TABLE consultations ADD COLUMN IF NOT EXISTS reminders_json jsonb NOT NULL DEFAULT '[]'::jsonb`);
  await query(`ALTER TABLE consultations ADD COLUMN IF NOT EXISTS series_id uuid`);
  await query(`ALTER TABLE consultations ADD COLUMN IF NOT EXISTS series_meta jsonb`);
  await query(`ALTER TABLE consultations ADD COLUMN IF NOT EXISTS occurrence_index integer`);
  await query(`ALTER TABLE consultations ADD COLUMN IF NOT EXISTS occurrence_count integer`);
  await query(`ALTER TABLE consultations ADD COLUMN IF NOT EXISTS is_exception boolean NOT NULL DEFAULT false`);
  await query(`ALTER TABLE consultations ADD COLUMN IF NOT EXISTS origin_series_id uuid`);
}

async function ensureDoctorUnavailabilitySchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS doctor_unavailability (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      clinic_id uuid NOT NULL,
      doctor_id uuid NOT NULL REFERENCES doctors(id) ON DELETE CASCADE,
      starts_at timestamptz NOT NULL,
      ends_at timestamptz NOT NULL,
      reason text,
      created_by_id uuid,
      created_by_role text,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT doctor_unavailability_time_check CHECK (ends_at > starts_at)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_doctor_unavailability_doctor_time ON doctor_unavailability(doctor_id, starts_at, ends_at)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_doctor_unavailability_clinic_time ON doctor_unavailability(clinic_id, starts_at, ends_at)`);
}

async function findDoctorUnavailabilityConflict({ clinicId, doctorId, startAt, endAt, excludeUnavailabilityId = null }) {
  const values = [doctorId, startAt, endAt, clinicId || null];
  let where = `active = true
    AND doctor_id = $1
    AND starts_at < $3::timestamptz
    AND ends_at > $2::timestamptz
    AND clinic_id = $4`;

  if (excludeUnavailabilityId) {
    values.push(excludeUnavailabilityId);
    where += ` AND id <> $${values.length}`;
  }

  const conflict = await query(
    `SELECT id, doctor_id, starts_at, ends_at, reason
       FROM doctor_unavailability
      WHERE ${where}
      ORDER BY starts_at ASC
      LIMIT 1`,
    values
  );

  return conflict.rows[0] || null;
}

async function findConsultationConflict({ clinicId, doctorId, consultationAt, durationMin, excludeConsultationId = null }) {
  const hasConsultClinicId = await hasColumn('consultations', 'clinic_id');
  const hasDurationColumn = await hasColumn('consultations', 'duration_min');

  const values = [doctorId, consultationAt, durationMin];
  let idx = values.length;

  let where = `c.doctor_id = $1
      AND c.consultation_at < ($2::timestamptz + ($3 * interval '1 minute'))
      AND (
        c.consultation_at
        + (
          ${hasDurationColumn ? "COALESCE(c.duration_min, 30)" : '30'}
          * interval '1 minute'
        )
      ) > $2::timestamptz`;

  if (hasConsultClinicId) {
    idx += 1;
    values.push(clinicId || null);
    where += ` AND c.clinic_id = $${idx}`;
  }

  if (excludeConsultationId) {
    idx += 1;
    values.push(excludeConsultationId);
    where += ` AND c.id <> $${idx}`;
  }

  const conflict = await query(
    `SELECT c.id, c.consultation_at, ${hasDurationColumn ? 'COALESCE(c.duration_min, 30)' : '30'} AS duration_min,
            p.name AS patient_name
       FROM consultations c
       LEFT JOIN patients p ON p.id = c.patient_id
      WHERE ${where}
      ORDER BY c.consultation_at ASC
      LIMIT 1`,
    values
  );

  return conflict.rows[0] || null;
}

router.get('/agenda/unavailability', requireDoctorOrReceptionist, async (req, res, next) => {
  try {
    await ensureDoctorUnavailabilitySchema();

    const clinicId = req.user?.clinicId || null;
    const { from, to, doctorId } = req.query;
    const values = [clinicId];
    const where = [`u.clinic_id = $1`, 'u.active = true'];

    if (req.user.role === 'DOCTOR') {
      values.push(req.user.id);
      where.push(`u.doctor_id = $${values.length}`);
    } else if (doctorId) {
      values.push(doctorId);
      where.push(`u.doctor_id = $${values.length}`);
    }

    if (from) {
      values.push(from);
      where.push(`u.ends_at >= $${values.length}::timestamptz`);
    }
    if (to) {
      values.push(to);
      where.push(`u.starts_at <= $${values.length}::timestamptz`);
    }

    if (req.user.role === 'RECEPTIONIST') {
      const scopeGuard = await getReceptionistClinicMemberId(req.user.id, clinicId);
      if (!scopeGuard) return res.json([]);
      values.push(scopeGuard);
      const scopeParam = values.length;
      where.push(`(
        EXISTS (
          SELECT 1 FROM receptionist_doctor_scope s
          WHERE s.clinic_member_id = $${scopeParam}
            AND s.active = true
            AND s.scope_type = 'ALL_DOCTORS'
        )
        OR EXISTS (
          SELECT 1 FROM receptionist_doctor_scope s
          WHERE s.clinic_member_id = $${scopeParam}
            AND s.active = true
            AND s.scope_type = 'ONE_DOCTOR'
            AND s.doctor_id = u.doctor_id
        )
      )`);
    }

    const rows = await query(
      `SELECT u.id, u.clinic_id, u.doctor_id, u.starts_at, u.ends_at, u.reason, u.created_by_id, u.created_by_role,
              d.name AS doctor_name, d.crm AS doctor_crm
         FROM doctor_unavailability u
         INNER JOIN doctors d ON d.id = u.doctor_id
        WHERE ${where.join(' AND ')}
        ORDER BY u.starts_at ASC`,
      values
    );

    return res.json(rows.rows);
  } catch (error) {
    return next(error);
  }
});

router.post('/agenda/unavailability', requireDoctorOrReceptionist, async (req, res, next) => {
  try {
    await ensureDoctorUnavailabilitySchema();

    const clinicId = req.user?.clinicId || null;
    const startsAt = normalizeDateTime(req.body?.startsAt);
    const endsAt = normalizeDateTime(req.body?.endsAt);
    const reason = String(req.body?.reason || '').trim() || null;
    const doctorIds = Array.isArray(req.body?.doctorIds)
      ? [...new Set(req.body.doctorIds.map((v) => String(v || '').trim()).filter(Boolean))]
      : [];

    if (!startsAt || !endsAt || doctorIds.length === 0) {
      return res.status(400).json({ error: 'startsAt, endsAt e doctorIds sao obrigatorios.' });
    }
    if (new Date(endsAt) <= new Date(startsAt)) {
      return res.status(400).json({ error: 'Fim da indisponibilidade deve ser maior que o inicio.' });
    }

    for (const selectedDoctorId of doctorIds) {
      const scopeCheck = await validateSchedulingDoctorScope(req, selectedDoctorId);
      if (!scopeCheck.ok) {
        return res.status(scopeCheck.status).json({ error: `Sem permissao para bloquear agenda do medico ${selectedDoctorId}.` });
      }

      const unavailableConflict = await findDoctorUnavailabilityConflict({
        clinicId,
        doctorId: selectedDoctorId,
        startAt: startsAt,
        endAt: endsAt,
      });
      if (unavailableConflict) {
        return res.status(409).json({
          error: `Ja existe indisponibilidade para este medico no periodo selecionado (${new Date(unavailableConflict.starts_at).toLocaleString('pt-BR')}).`,
          conflict: unavailableConflict,
        });
      }
    }

    const inserted = [];
    for (const selectedDoctorId of doctorIds) {
      const created = await query(
        `INSERT INTO doctor_unavailability (clinic_id, doctor_id, starts_at, ends_at, reason, created_by_id, created_by_role, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true)
         RETURNING *`,
        [clinicId, selectedDoctorId, startsAt, endsAt, reason, req.user.id, req.user.role]
      );
      inserted.push(created.rows[0]);
    }

    socketService.emitAll('agenda_updated', { clinic_id: clinicId, unavailability_created: true });
    return res.status(201).json({ created: inserted.length, items: inserted });
  } catch (error) {
    return next(error);
  }
});

router.delete('/agenda/unavailability/:id', requireDoctorOrReceptionist, async (req, res, next) => {
  try {
    await ensureDoctorUnavailabilitySchema();
    const clinicId = req.user?.clinicId || null;

    const current = await query(
      `SELECT id, doctor_id, clinic_id
         FROM doctor_unavailability
        WHERE id = $1
          AND clinic_id = $2
          AND active = true
        LIMIT 1`,
      [req.params.id, clinicId]
    );
    if (current.rowCount === 0) {
      return res.status(404).json({ error: 'Indisponibilidade nao encontrada.' });
    }

    const scopeCheck = await validateSchedulingDoctorScope(req, current.rows[0].doctor_id);
    if (!scopeCheck.ok) {
      return res.status(scopeCheck.status).json({ error: 'Sem permissao para remover esta indisponibilidade.' });
    }

    await query(
      `UPDATE doctor_unavailability
          SET active = false,
              updated_at = now()
        WHERE id = $1`,
      [req.params.id]
    );

    socketService.emitAll('agenda_updated', { clinic_id: clinicId, unavailability_removed: true });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

async function doctorBelongsToClinic(doctorId, clinicId) {
  if (!doctorId || !clinicId) return false;
  const scopedDoctor = await query(
    `SELECT 1
       FROM clinic_members cm
      WHERE cm.member_id = $1
        AND cm.member_type = 'doctor'
        AND cm.clinic_id = $2
        AND cm.active = true
      LIMIT 1`,
    [doctorId, clinicId]
  );
  return scopedDoctor.rowCount > 0;
}

async function getReceptionistClinicMemberId(receptionistId, clinicId) {
  if (!receptionistId || !clinicId) return null;
  const receptionistClinicMemberRow = await query(
    `SELECT id
       FROM clinic_members
      WHERE member_id = $1
        AND member_type = 'receptionist'
        AND clinic_id = $2
        AND active = true
      LIMIT 1`,
    [receptionistId, clinicId]
  );
  return receptionistClinicMemberRow.rows[0]?.id || null;
}

async function receptionistCanScheduleDoctor(receptionistClinicMemberId, doctorId) {
  if (!receptionistClinicMemberId || !doctorId) return false;

  const scopeAllowed = await query(
    `SELECT 1
       FROM receptionist_doctor_scope s
      WHERE s.clinic_member_id = $1
        AND s.active = true
        AND (
          s.scope_type = 'ALL_DOCTORS'
          OR (s.scope_type = 'ONE_DOCTOR' AND s.doctor_id = $2)
        )
      LIMIT 1`,
    [receptionistClinicMemberId, doctorId]
  );

  return scopeAllowed.rowCount > 0;
}

async function validateSchedulingDoctorScope(req, doctorId) {
  const clinicId = req.user?.clinicId || null;
  if (!clinicId) {
    return { ok: false, status: 400, error: 'Clinica ativa nao encontrada no contexto de login' };
  }

  const doctorInClinic = await doctorBelongsToClinic(doctorId, clinicId);
  if (!doctorInClinic) {
    return { ok: false, status: 403, error: 'Medico informado nao pertence a clinica ativa' };
  }

  if (req.user.role === 'DOCTOR' && String(doctorId) !== String(req.user.id)) {
    return { ok: false, status: 403, error: 'Medico so pode agendar consultas para a propria agenda' };
  }

  if (req.user.role === 'RECEPTIONIST') {
    const hasScopeTable = await hasColumn('receptionist_doctor_scope', 'clinic_member_id');
    if (hasScopeTable) {
      const receptionistClinicMemberId = await getReceptionistClinicMemberId(req.user.id, clinicId);
      if (!receptionistClinicMemberId) {
        return { ok: false, status: 403, error: 'Recepcionista sem vinculo ativo com a clinica' };
      }

      const canSchedule = await receptionistCanScheduleDoctor(receptionistClinicMemberId, doctorId);
      if (!canSchedule) {
        return { ok: false, status: 403, error: 'Recepcionista sem permissao para agendar para este medico' };
      }
    }
  }

  return { ok: true };
}

router.get('/doctors', requireDoctorOrReceptionist, async (req, res, next) => {
  try {
    const clinicId = req.user?.clinicId || null;

    // Se existir a tabela de escopo, aplicamos no receptionist
    const hasScopeTable = await hasColumn('receptionist_doctor_scope', 'clinic_member_id');
    if (req.user.role === 'RECEPTIONIST' && hasScopeTable) {
      const receptionistClinicMemberRow = await query(
        `SELECT id
           FROM clinic_members
          WHERE member_id = $1
            AND member_type = 'receptionist'
            AND clinic_id = $2
            AND active = true
          LIMIT 1`,
        [req.user.id, clinicId]
      );

      const receptionistClinicMemberId = receptionistClinicMemberRow.rows[0]?.id || null;

      if (!receptionistClinicMemberId) {
        // sem vinculo consistente
        return res.json([]);
      }

      const result = await query(
        `SELECT d.id, d.name, d.email, d.crm
           FROM doctors d
           JOIN clinic_members cm ON cm.member_id = d.id
          WHERE cm.member_type = 'doctor'
            AND cm.active = true
            AND cm.clinic_id = $1
            AND (
              EXISTS (
                SELECT 1
                  FROM receptionist_doctor_scope s
                 WHERE s.clinic_member_id = $2
                   AND s.active = true
                   AND s.scope_type = 'ALL_DOCTORS'
              )
              OR EXISTS (
                SELECT 1
                  FROM receptionist_doctor_scope s
                 WHERE s.clinic_member_id = $2
                   AND s.active = true
                   AND s.scope_type = 'ONE_DOCTOR'
                   AND s.doctor_id = d.id
              )
            )
          ORDER BY d.name ASC`,
        [clinicId, receptionistClinicMemberId]
      );

      return res.json(result.rows);
    }

    // fallback: todos os médicos do clinicId
    const result = await query(
      `SELECT d.id, d.name, d.email, d.crm
         FROM doctors d
         JOIN clinic_members cm ON cm.member_id = d.id
        WHERE cm.member_type = 'doctor'
          AND cm.active = true
          AND cm.clinic_id = $1
        ORDER BY d.name ASC`,
      [clinicId]
    );
    return res.json(result.rows);
  } catch (error) {
    return next(error);
  }
});

router.get('/patients', requireDoctorOrReceptionist, async (req, res, next) => {
  try {
    const { search } = req.query;
    const hasClinicId = await hasColumn('patients', 'clinic_id');
    let sql = 'SELECT id, name, email, phone FROM patients';
    const values = [];
    const where = [];
    if (hasClinicId) {
      values.push(req.user?.clinicId || null);
      where.push(`clinic_id = $${values.length}`);
    }
    if (search && search.trim()) {
      values.push(`%${search.trim()}%`);
      where.push(`(name ILIKE $${values.length} OR phone ILIKE $${values.length})`);
      sql += ` ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY name ASC LIMIT 20`;
    } else {
      sql += ` ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY name ASC`;
    }
    const result = await query(sql, values);
    return res.json(result.rows);
  } catch (error) {
    return next(error);
  }
});

router.get('/agenda', requireDoctorOrReceptionist, async (req, res, next) => {
  try {
    const { from, to, doctorId, patientId } = req.query;
    const where = [];
    const values = [];

    const hasConsultClinicId = await hasColumn('consultations', 'clinic_id');
    if (hasConsultClinicId) {
      values.push(req.user?.clinicId || null);
      where.push(`c.clinic_id = $${values.length}`);
    }

    if (req.user.role === 'DOCTOR') {
      values.push(req.user.id);
      where.push(`c.doctor_id = $${values.length}`);
    }

    if (from) {
      values.push(from);
      where.push(`c.consultation_at >= $${values.length}`);
    }
    if (to) {
      values.push(to);
      where.push(`c.consultation_at <= $${values.length}`);
    }
    if (doctorId && req.user.role === 'RECEPTIONIST') {
      values.push(doctorId);
      where.push(`c.doctor_id = $${values.length}`);
    }

    // Restringe agenda do receptionist por escopo (ONE_DOCTOR)
    if (req.user.role === 'RECEPTIONIST') {
      const hasScopeTable = await hasColumn('receptionist_doctor_scope', 'clinic_member_id');
      if (hasScopeTable) {
        const receptionistClinicMemberRow = await query(
          `SELECT id
             FROM clinic_members
            WHERE member_id = $1
              AND member_type = 'receptionist'
              AND clinic_id = $2
              AND active = true
            LIMIT 1`,
          [req.user.id, req.user.clinicId || null]
        );
        const receptionistClinicMemberId = receptionistClinicMemberRow.rows[0]?.id || null;
        if (!receptionistClinicMemberId) return res.json([]);
        const scopeParamIndex = values.length + 1;

        // Filtra apenas médicos dentro do escopo
        values.push(receptionistClinicMemberId);
        where.push(`(
          EXISTS (
            SELECT 1
              FROM receptionist_doctor_scope s
             WHERE s.clinic_member_id = $${scopeParamIndex}
               AND s.active = true
               AND s.scope_type = 'ALL_DOCTORS'
          )
          OR EXISTS (
            SELECT 1
              FROM receptionist_doctor_scope s
             WHERE s.clinic_member_id = $${scopeParamIndex}
               AND s.active = true
               AND s.scope_type = 'ONE_DOCTOR'
               AND s.doctor_id = c.doctor_id
          )
        )`);
      }
    }
    if (patientId) {
      values.push(patientId);
      where.push(`c.patient_id = $${values.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const result = await query(
      `SELECT c.*, p.name AS patient_name, p.email AS patient_email,
              d.name AS doctor_name, d.crm
       FROM consultations c
       INNER JOIN patients p ON p.id = c.patient_id
       INNER JOIN doctors d ON d.id = c.doctor_id
       ${whereSql}
       ORDER BY c.consultation_at ASC`,
      values
    );

    const items = result.rows.map((row) => ({
      ...row,
      google_calendar_link: buildGoogleCalendarLink({
        title: `Consulta - ${row.patient_name}`,
        description: `Medico: ${row.doctor_name}\nResumo: ${row.summary || ''}`,
        startAt: row.consultation_at,
      }),
    }));

    return res.json(items);
  } catch (error) {
    return next(error);
  }
});

router.post('/agenda', requireDoctorOrReceptionist, async (req, res, next) => {
  try {
    const {
      patientId,
      doctorId,
      consultationAt,
      summary,
      diagnosis,
      prescription,
      durationMin,
      notes,
      colorHex,
      guests,
      reminders,
      recurrence,
      modality,
    } = req.body;
    const normalizedModality = modality === 'TELECONSULTA' ? 'TELECONSULTA' : 'PRESENCIAL';
    const normalizedConsultationAt = normalizeConsultationAt(consultationAt);
    const normalizedDurationMin = normalizeDurationMin(durationMin);
    const clinicId = req.user?.clinicId || null;
    const hasConsultClinicId = await hasColumn('consultations', 'clinic_id');
    const hasDurationColumn = await hasColumn('consultations', 'duration_min');
    const hasPatientsClinicId = await hasColumn('patients', 'clinic_id');
    await ensureConsultationAdvancedSchema();

    const normalizedNotes = String(notes || '').trim() || null;
    const normalizedColorHex = normalizeColorHex(colorHex);
    const normalizedGuests = normalizeGuests(guests);
    const normalizedReminders = normalizeReminders(reminders);
    const normalizedRecurrence = parseRecurrence(recurrence);

    if (!patientId || !doctorId || !consultationAt || !summary) {
      return res.status(400).json({ error: 'patientId, doctorId, consultationAt e summary sao obrigatorios' });
    }

    const scheduleScope = await validateSchedulingDoctorScope(req, doctorId);
    if (!scheduleScope.ok) {
      return res.status(scheduleScope.status).json({ error: scheduleScope.error });
    }

    if (hasPatientsClinicId) {
      const patientScope = await query('SELECT id FROM patients WHERE id = $1 AND clinic_id = $2', [patientId, clinicId]);
      if (patientScope.rowCount === 0) {
        return res.status(404).json({ error: 'Paciente nao encontrado para a clinica ativa' });
      }
    }

    await ensureDoctorUnavailabilitySchema();
    const occurrenceDates = buildOccurrenceDates(new Date(normalizedConsultationAt), normalizedRecurrence);
    const recurringSeriesId = occurrenceDates.length > 1 ? randomUUID() : null;

    for (const dateItem of occurrenceDates) {
      const startIso = dateItem.toISOString();
      const conflict = await findConsultationConflict({
        clinicId,
        doctorId,
        consultationAt: startIso,
        durationMin: normalizedDurationMin,
      });
      if (conflict) {
        return res.status(409).json({
          error: `Conflito de horario: ja existe consulta para este medico em ${new Date(conflict.consultation_at).toLocaleString('pt-BR')}.`,
          conflict,
        });
      }

      const unavailabilityConflict = await findDoctorUnavailabilityConflict({
        clinicId,
        doctorId,
        startAt: startIso,
        endAt: new Date(new Date(startIso).getTime() + normalizedDurationMin * 60 * 1000).toISOString(),
      });
      if (unavailabilityConflict) {
        return res.status(409).json({
          error: `Medico indisponivel neste horario. Motivo: ${unavailabilityConflict.reason || 'Nao informado'}.`,
          conflict: unavailabilityConflict,
        });
      }
    }

    const [patientRow, doctorRow] = await Promise.all([
      query('SELECT name, email FROM patients WHERE id = $1', [patientId]),
      query('SELECT name FROM doctors WHERE id = $1', [doctorId]),
    ]);
    const patient = patientRow.rows[0];
    const doctor = doctorRow.rows[0];

    const insertedItems = [];
    let anyGoogleEventCreated = false;
    let teleconsultationInfo = null;
    for (let idx = 0; idx < occurrenceDates.length; idx += 1) {
      const startIso = occurrenceDates[idx].toISOString();
      const inserted = await query(
        `INSERT INTO consultations (
            patient_id,
            doctor_id,
            consultation_at,
            summary,
            diagnosis,
            prescription
            ${hasConsultClinicId ? ', clinic_id' : ''}
            ${hasDurationColumn ? ', duration_min' : ''},
            notes,
            color_hex,
            guests_json,
            reminders_json,
            series_id,
            series_meta,
            occurrence_index,
            occurrence_count
          )
          VALUES (
            $1, $2, $3, $4, $5, $6
            ${hasConsultClinicId ? ', $7' : ''}
            ${hasDurationColumn ? `${hasConsultClinicId ? ', $8' : ', $7'}` : ''},
            $${hasDurationColumn ? (hasConsultClinicId ? '9' : '8') : (hasConsultClinicId ? '8' : '7')},
            $${hasDurationColumn ? (hasConsultClinicId ? '10' : '9') : (hasConsultClinicId ? '9' : '8')},
            $${hasDurationColumn ? (hasConsultClinicId ? '11' : '10') : (hasConsultClinicId ? '10' : '9')}::jsonb,
            $${hasDurationColumn ? (hasConsultClinicId ? '12' : '11') : (hasConsultClinicId ? '11' : '10')}::jsonb,
            $${hasDurationColumn ? (hasConsultClinicId ? '13' : '12') : (hasConsultClinicId ? '12' : '11')}::uuid,
            $${hasDurationColumn ? (hasConsultClinicId ? '14' : '13') : (hasConsultClinicId ? '13' : '12')}::jsonb,
            $${hasDurationColumn ? (hasConsultClinicId ? '15' : '14') : (hasConsultClinicId ? '14' : '13')},
            $${hasDurationColumn ? (hasConsultClinicId ? '16' : '15') : (hasConsultClinicId ? '15' : '14')}
          )
          RETURNING *`,
        [
          patientId,
          doctorId,
          startIso,
          summary,
          diagnosis || null,
          prescription || null,
          ...(hasConsultClinicId ? [clinicId] : []),
          ...(hasDurationColumn ? [normalizedDurationMin] : []),
          normalizedNotes,
          normalizedColorHex,
          JSON.stringify(normalizedGuests),
          JSON.stringify(normalizedReminders),
          recurringSeriesId,
          JSON.stringify(normalizedRecurrence || null),
          idx + 1,
          occurrenceDates.length,
        ]
      );

      const consultation = inserted.rows[0];
      let googleEventId = null;
      if (gcal.isEnabled() && patient && doctor) {
        try {
          googleEventId = await gcal.createCalendarEvent({
            doctorId,
            patientName: patient.name,
            patientEmail: patient.email,
            doctorName: doctor.name,
            summary,
            notes: normalizedNotes,
            consultationAt: startIso,
            durationMin: normalizedDurationMin,
            guests: normalizedGuests,
            reminders: normalizedReminders,
          });

          if (googleEventId) {
            anyGoogleEventCreated = true;
            await query('UPDATE consultations SET google_event_id = $1 WHERE id = $2', [googleEventId, consultation.id]);
            consultation.google_event_id = googleEventId;
          }
        } catch (gcalErr) {
          console.warn('[Google Calendar] Erro ao criar evento (nao bloqueia):', gcalErr.message);
        }
      }

      insertedItems.push(consultation);
      socketService.emitToDoctor(String(doctorId), 'consultation_created', { id: consultation.id, patient_id: patientId, doctor_id: doctorId });
      socketService.emitToPatient(String(patientId), 'consultation_created', { id: consultation.id, patient_id: patientId, doctor_id: doctorId });

      if (normalizedModality === 'TELECONSULTA') {
        try {
          const { sessao } = await provisionarSessao({
            consultationId: consultation.id,
            clinicId,
            doctorId,
            patientId,
            consultationAt: startIso,
            actorType: 'system',
            actorId: req.user?.id || null,
          });
          const emailEnviado = await enviarLinkPorEmail({
            accessToken: sessao.access_token,
            patientEmail: patient?.email,
            patientName: patient?.name,
            doctorName: doctor?.name,
            consultationAt: startIso,
          });
          consultation.modality = 'TELECONSULTA';
          teleconsultationInfo = { sessionId: sessao.id, emailEnviado };
        } catch (teleErr) {
          // Best-effort: nao bloqueia a criacao do agendamento se a
          // teleconsulta nao puder ser provisionada (ex: JaaS mal configurado).
          console.warn('[teleconsultation] Falha ao provisionar sessao (nao bloqueia):', teleErr.message);
        }
      }
    }

    socketService.emitAll('agenda_updated', { doctor_id: doctorId });
    return res.status(201).json({
      ...insertedItems[0],
      google_event_created: anyGoogleEventCreated,
      recurring: occurrenceDates.length > 1,
      series_id: recurringSeriesId,
      created_count: insertedItems.length,
      items: insertedItems,
      teleconsultation: teleconsultationInfo,
    });
  } catch (error) {
    return next(error);
  }
});

router.put('/agenda/:id', requireDoctorOrReceptionist, async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      consultationAt,
      summary,
      diagnosis,
      prescription,
      durationMin,
      notes,
      colorHex,
      guests,
      reminders,
      scope,
    } = req.body;
    const normalizedConsultationAt = consultationAt ? normalizeConsultationAt(consultationAt) : null;
    const normalizedDurationMin = normalizeDurationMin(durationMin);
    const hasConsultClinicId = await hasColumn('consultations', 'clinic_id');
    const hasDurationColumn = await hasColumn('consultations', 'duration_min');
    await ensureConsultationAdvancedSchema();

    const normalizedNotes = notes === undefined ? undefined : (String(notes || '').trim() || null);
    const normalizedColorHex = colorHex === undefined ? undefined : normalizeColorHex(colorHex);
    const normalizedGuests = guests === undefined ? undefined : normalizeGuests(guests);
    const normalizedReminders = reminders === undefined ? undefined : normalizeReminders(reminders);
    const updateScope = scope === 'series' ? 'series' : 'single';

    const current = hasConsultClinicId
      ? await query('SELECT id, doctor_id, patient_id, consultation_at, summary, duration_min, google_event_id, series_id FROM consultations WHERE id = $1 AND clinic_id = $2', [id, req.user?.clinicId || null])
      : await query('SELECT id, doctor_id, patient_id, consultation_at, summary, duration_min, google_event_id, series_id FROM consultations WHERE id = $1', [id]);
    if (current.rowCount === 0) {
      return res.status(404).json({ error: 'Consulta nao encontrada' });
    }
    if (req.user.role === 'DOCTOR' && String(current.rows[0].doctor_id) !== String(req.user.id)) {
      return res.status(403).json({ error: 'Sem permissao para editar esta consulta' });
    }

    if (req.user.role === 'RECEPTIONIST') {
      const scheduleScope = await validateSchedulingDoctorScope(req, current.rows[0].doctor_id);
      if (!scheduleScope.ok) {
        return res.status(scheduleScope.status).json({ error: scheduleScope.error });
      }
    }

    const nextConsultationAt = normalizedConsultationAt || current.rows[0].consultation_at;
    const nextDurationMin = hasDurationColumn
      ? (Number.isFinite(Number(durationMin)) ? normalizedDurationMin : Number(current.rows[0].duration_min || 30))
      : 30;

    const conflict = await findConsultationConflict({
      clinicId: req.user?.clinicId || null,
      doctorId: current.rows[0].doctor_id,
      consultationAt: nextConsultationAt,
      durationMin: nextDurationMin,
      excludeConsultationId: id,
    });
    if (conflict) {
      return res.status(409).json({
        error: `Conflito de horario: ja existe consulta para este medico em ${new Date(conflict.consultation_at).toLocaleString('pt-BR')}.`,
        conflict,
      });
    }

    await ensureDoctorUnavailabilitySchema();
    const unavailable = await findDoctorUnavailabilityConflict({
      clinicId: req.user?.clinicId || null,
      doctorId: current.rows[0].doctor_id,
      startAt: nextConsultationAt,
      endAt: new Date(new Date(nextConsultationAt).getTime() + nextDurationMin * 60 * 1000).toISOString(),
    });
    if (unavailable) {
      return res.status(409).json({
        error: `Medico indisponivel no periodo selecionado. Motivo: ${unavailable.reason || 'Nao informado'}.`,
        conflict: unavailable,
      });
    }

    let updated;
    if (updateScope === 'series' && current.rows[0].series_id) {
      const seriesRows = hasConsultClinicId
        ? await query(
          'SELECT * FROM consultations WHERE series_id = $1 AND clinic_id = $2 ORDER BY consultation_at ASC',
          [current.rows[0].series_id, req.user?.clinicId || null]
        )
        : await query(
          'SELECT * FROM consultations WHERE series_id = $1 ORDER BY consultation_at ASC',
          [current.rows[0].series_id]
        );

      const baseCurrent = new Date(current.rows[0].consultation_at);
      const baseTarget = normalizedConsultationAt ? new Date(normalizedConsultationAt) : new Date(current.rows[0].consultation_at);
      const deltaMs = baseTarget.getTime() - baseCurrent.getTime();

      const updatedRows = [];
      for (const row of seriesRows.rows) {
        const nextAt = normalizedConsultationAt
          ? new Date(new Date(row.consultation_at).getTime() + deltaMs).toISOString()
          : row.consultation_at;

        const line = await query(
          `UPDATE consultations
           SET consultation_at = $1,
               summary = COALESCE($2, summary),
               diagnosis = COALESCE($3, diagnosis),
               prescription = COALESCE($4, prescription),
               notes = COALESCE($5, notes),
               color_hex = COALESCE($6, color_hex),
               guests_json = COALESCE($7::jsonb, guests_json),
               reminders_json = COALESCE($8::jsonb, reminders_json)
               ${hasDurationColumn ? ', duration_min = COALESCE($9, duration_min)' : ''}
           WHERE id = $${hasDurationColumn ? '10' : '9'}
           RETURNING *`,
          [
            nextAt,
            summary || null,
            diagnosis || null,
            prescription || null,
            normalizedNotes === undefined ? null : normalizedNotes,
            normalizedColorHex === undefined ? null : normalizedColorHex,
            normalizedGuests === undefined ? null : JSON.stringify(normalizedGuests),
            normalizedReminders === undefined ? null : JSON.stringify(normalizedReminders),
            ...(hasDurationColumn ? [Number.isFinite(Number(durationMin)) ? normalizedDurationMin : null] : []),
            row.id,
          ]
        );
        updatedRows.push(line.rows[0]);

        if (gcal.isEnabled() && line.rows[0].google_event_id) {
          try {
            const [patientRow, doctorRow] = await Promise.all([
              query('SELECT name, email FROM patients WHERE id = $1', [line.rows[0].patient_id]),
              query('SELECT name FROM doctors WHERE id = $1', [line.rows[0].doctor_id]),
            ]);
            const patient = patientRow.rows[0];
            const doctor = doctorRow.rows[0];
            if (patient && doctor) {
              await gcal.updateCalendarEvent({
                doctorId: line.rows[0].doctor_id,
                eventId: line.rows[0].google_event_id,
                patientName: patient.name,
                patientEmail: patient.email,
                doctorName: doctor.name,
                summary: line.rows[0].summary,
                notes: line.rows[0].notes,
                consultationAt: line.rows[0].consultation_at,
                durationMin: hasDurationColumn ? Number(line.rows[0].duration_min || 30) : 30,
                guests: Array.isArray(line.rows[0].guests_json) ? line.rows[0].guests_json : [],
                reminders: Array.isArray(line.rows[0].reminders_json) ? line.rows[0].reminders_json : [],
              });
            }
          } catch (gcalErr) {
            console.warn('[Google Calendar] Erro ao atualizar serie (nao bloqueia):', gcalErr.message);
          }
        }
      }

      updated = { rowCount: updatedRows.length, rows: [updatedRows[0]], updatedCount: updatedRows.length };
    } else {
      const detachFromSeries = Boolean(current.rows[0].series_id && updateScope === 'single');
      updated = await query(
        `UPDATE consultations
         SET consultation_at = COALESCE($1, consultation_at),
             summary = COALESCE($2, summary),
             diagnosis = COALESCE($3, diagnosis),
             prescription = COALESCE($4, prescription),
             notes = COALESCE($5, notes),
             color_hex = COALESCE($6, color_hex),
             guests_json = COALESCE($7::jsonb, guests_json),
             reminders_json = COALESCE($8::jsonb, reminders_json),
             series_id = CASE WHEN $9 THEN NULL ELSE series_id END,
             series_meta = CASE WHEN $9 THEN NULL ELSE series_meta END,
             occurrence_index = CASE WHEN $9 THEN NULL ELSE occurrence_index END,
             occurrence_count = CASE WHEN $9 THEN NULL ELSE occurrence_count END,
             is_exception = CASE WHEN $9 THEN true ELSE is_exception END,
             origin_series_id = CASE WHEN $9 THEN COALESCE(origin_series_id, $10::uuid) ELSE origin_series_id END
             ${hasDurationColumn ? ', duration_min = COALESCE($11, duration_min)' : ''}
         WHERE id = $${hasDurationColumn ? '12' : '11'}
         RETURNING *`,
        [
          normalizedConsultationAt || null,
          summary || null,
          diagnosis || null,
          prescription || null,
          normalizedNotes === undefined ? null : normalizedNotes,
          normalizedColorHex === undefined ? null : normalizedColorHex,
          normalizedGuests === undefined ? null : JSON.stringify(normalizedGuests),
          normalizedReminders === undefined ? null : JSON.stringify(normalizedReminders),
          detachFromSeries,
          current.rows[0].series_id || null,
          ...(hasDurationColumn ? [Number.isFinite(Number(durationMin)) ? normalizedDurationMin : null] : []),
          id,
        ]
      );
    }

    if (updated.rowCount > 0 && gcal.isEnabled() && updated.rows[0].google_event_id) {
      try {
        const [patientRow, doctorRow] = await Promise.all([
          query('SELECT name, email FROM patients WHERE id = $1', [updated.rows[0].patient_id || current.rows[0].patient_id]),
          query('SELECT name FROM doctors WHERE id = $1', [updated.rows[0].doctor_id || current.rows[0].doctor_id]),
        ]);
        const patient = patientRow.rows[0];
        const doctor = doctorRow.rows[0];
        if (patient && doctor) {
          await gcal.updateCalendarEvent({
            doctorId: updated.rows[0].doctor_id || current.rows[0].doctor_id,
            eventId: updated.rows[0].google_event_id,
            patientName: patient.name,
            patientEmail: patient.email,
            doctorName: doctor.name,
            summary: updated.rows[0].summary,
            notes: updated.rows[0].notes,
            consultationAt: updated.rows[0].consultation_at,
            durationMin: hasDurationColumn ? Number(updated.rows[0].duration_min || 30) : 30,
            guests: Array.isArray(updated.rows[0].guests_json) ? updated.rows[0].guests_json : [],
            reminders: Array.isArray(updated.rows[0].reminders_json) ? updated.rows[0].reminders_json : [],
          });
        }
      } catch (gcalErr) {
        console.warn('[Google Calendar] Erro ao atualizar evento (nao bloqueia):', gcalErr.message);
      }
    }

    socketService.emitToDoctor(String(updated.rows[0].doctor_id || current.rows[0].doctor_id), 'consultation_updated', {
      id: updated.rows[0].id,
      consultation_at: updated.rows[0].consultation_at,
    });
    socketService.emitAll('agenda_updated', { doctor_id: updated.rows[0].doctor_id || current.rows[0].doctor_id });

    return res.json({ ...updated.rows[0], updated_count: updated.updatedCount || 1, scope: updateScope });
  } catch (error) {
    return next(error);
  }
});

router.delete('/agenda/:id', requireDoctorOrReceptionist, async (req, res, next) => {
  try {
    const { id } = req.params;
    const deleteScope = req.query?.scope === 'series' ? 'series' : 'single';
    const hasConsultClinicId = await hasColumn('consultations', 'clinic_id');
    await ensureConsultationAdvancedSchema();

    const current = hasConsultClinicId
      ? await query(
        'SELECT id, doctor_id, patient_id, consultation_at, google_event_id, series_id FROM consultations WHERE id = $1 AND clinic_id = $2',
        [id, req.user?.clinicId || null]
      )
      : await query(
        'SELECT id, doctor_id, patient_id, consultation_at, google_event_id, series_id FROM consultations WHERE id = $1',
        [id]
      );

    if (current.rowCount === 0) {
      return res.status(404).json({ error: 'Consulta nao encontrada' });
    }

    const item = current.rows[0];
    if (req.user.role === 'DOCTOR' && String(item.doctor_id) !== String(req.user.id)) {
      return res.status(403).json({ error: 'Sem permissao para excluir esta consulta' });
    }

    if (req.user.role === 'RECEPTIONIST') {
      const scheduleScope = await validateSchedulingDoctorScope(req, item.doctor_id);
      if (!scheduleScope.ok) {
        return res.status(scheduleScope.status).json({ error: scheduleScope.error });
      }
    }

    const targets = deleteScope === 'series' && item.series_id
      ? (hasConsultClinicId
        ? await query('SELECT id, doctor_id, patient_id, google_event_id FROM consultations WHERE series_id = $1 AND clinic_id = $2', [item.series_id, req.user?.clinicId || null])
        : await query('SELECT id, doctor_id, patient_id, google_event_id FROM consultations WHERE series_id = $1', [item.series_id]))
      : { rows: [item] };

    for (const target of targets.rows) {
      await query('DELETE FROM consultations WHERE id = $1', [target.id]);
      if (gcal.isEnabled() && target.google_event_id) {
        try {
          await gcal.deleteCalendarEvent({ doctorId: target.doctor_id, eventId: target.google_event_id });
        } catch (gcalErr) {
          console.warn('[Google Calendar] Erro ao excluir evento (nao bloqueia):', gcalErr.message);
        }
      }
      socketService.emitToDoctor(String(target.doctor_id), 'consultation_deleted', { id: target.id });
      socketService.emitToPatient(String(target.patient_id), 'consultation_deleted', { id: target.id });
    }

    socketService.emitAll('agenda_updated', { doctor_id: item.doctor_id, consultation_deleted: true });

    return res.json({ ok: true, scope: deleteScope, deleted_count: targets.rows.length });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
