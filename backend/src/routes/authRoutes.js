const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../config/database');
const { requireDoctor, requireReceptionist, requireDoctorOrReceptionist, clearOtherRoleCookies } = require('../middleware/auth');
const { getJwtSecret } = require('../config/security');
const gcal = require('../services/googleCalendarService');

const JWT_SECRET = getJwtSecret();
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('invalid-password-placeholder', 10);

const router = express.Router();

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizePassword(value) {
  return String(value || '');
}

function isValidCredentialInput(email, password) {
  if (!email || !password) return false;
  if (email.length > 254 || password.length > 128) return false;
  return true;
}

async function findOwnedClinicByDoctor(doctorId) {
  const owned = await query(
    `SELECT id, name
       FROM clinics
      WHERE created_by = $1 AND active = true
      ORDER BY created_at ASC
      LIMIT 1`,
    [doctorId]
  );
  return owned.rows[0] || null;
}

async function resolveProvisioningClinic(req) {
  const activeClinicId = req.doctor?.clinicId || null;
  const doctorId = req.doctor?.id;

  if (activeClinicId && doctorId) {
    const allowed = await query(
      `SELECT 1
         FROM clinics c
         LEFT JOIN clinic_members cm
           ON cm.clinic_id = c.id
          AND cm.member_id = $2
          AND cm.member_type = 'doctor'
          AND cm.active = true
        WHERE c.id = $1
          AND c.active = true
          AND (
            c.created_by = $2
            OR cm.role IN ('owner', 'admin')
          )
        LIMIT 1`,
      [activeClinicId, doctorId]
    );

    if (allowed.rowCount > 0) {
      const activeClinic = await query(
        `SELECT id, name FROM clinics WHERE id = $1 LIMIT 1`,
        [activeClinicId]
      );
      if (activeClinic.rowCount > 0) return activeClinic.rows[0];
    }
  }

  return findOwnedClinicByDoctor(doctorId);
}

async function findDoctorClinicByName(doctorId, clinicName) {
  const result = await query(
    `SELECT c.id, c.name, c.created_by,
            CASE
              WHEN c.created_by = $1 THEN 'owner'
              ELSE cm.role
            END AS clinic_role
       FROM clinics c
       LEFT JOIN clinic_members cm
              ON cm.clinic_id = c.id
             AND cm.member_id = $1
             AND cm.member_type = 'doctor'
             AND cm.active = true
      WHERE c.active = true
        AND lower(c.name) = lower($2)
        AND (c.created_by = $1 OR cm.id IS NOT NULL)
      LIMIT 1`,
    [doctorId, clinicName]
  );
  return result.rows[0] || null;
}

async function grantDefaultPermissions(clinicMemberId, memberType) {
  await query(
    `INSERT INTO clinic_member_permissions (
       clinic_member_id, page_code, can_view, can_create, can_update, can_delete
     )
     SELECT $1, p.code, p.default_can_view, p.default_can_create, p.default_can_update, p.default_can_delete
       FROM app_pages p
      WHERE p.active = true
        AND (p.member_type = $2 OR p.member_type = 'both')
     ON CONFLICT (clinic_member_id, page_code) DO NOTHING`,
    [clinicMemberId, memberType]
  );
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function normalizeReceptionScope(scopeType, doctorId, doctorIds) {
  const normalizedScope = String(scopeType || 'ALL_DOCTORS').toUpperCase();
  const wantsAllDoctors = normalizedScope === 'ALL_DOCTORS';

  const rawDoctorIds = [];
  if (doctorId) rawDoctorIds.push(String(doctorId));
  if (Array.isArray(doctorIds)) {
    for (const item of doctorIds) {
      if (item) rawDoctorIds.push(String(item));
    }
  }

  const uniqueDoctorIds = [...new Set(rawDoctorIds.map((v) => v.trim()).filter(Boolean))];
  return {
    scopeType: wantsAllDoctors ? 'ALL_DOCTORS' : 'ONE_DOCTOR',
    doctorIds: wantsAllDoctors ? [] : uniqueDoctorIds,
  };
}

async function validateDoctorsInClinic(clinicId, doctorIds) {
  if (!doctorIds.length) return [];
  const invalidFormat = doctorIds.find((id) => !isUuid(id));
  if (invalidFormat) {
    const err = new Error('Lista de medicos contem id invalido.');
    err.status = 400;
    throw err;
  }

  const allowedDoctors = await query(
    `SELECT cm.member_id::text AS id
       FROM clinic_members cm
      WHERE cm.clinic_id = $1
        AND cm.member_type = 'doctor'
        AND cm.active = true
        AND cm.member_id = ANY($2::uuid[])`,
    [clinicId, doctorIds]
  );

  const allowedSet = new Set(allowedDoctors.rows.map((row) => String(row.id)));
  const invalidDoctor = doctorIds.find((id) => !allowedSet.has(String(id)));
  if (invalidDoctor) {
    const err = new Error('Ha medicos fora da clinica ativa no escopo selecionado.');
    err.status = 400;
    throw err;
  }

  return doctorIds;
}

async function persistReceptionistScope(clinicMemberId, scopeType, doctorIds) {
  await query('BEGIN');
  try {
    await query(`DELETE FROM receptionist_doctor_scope WHERE clinic_member_id = $1`, [clinicMemberId]);

    if (scopeType === 'ALL_DOCTORS') {
      await query(
        `INSERT INTO receptionist_doctor_scope (clinic_member_id, scope_type, doctor_id, active)
         VALUES ($1, 'ALL_DOCTORS', NULL, true)`,
        [clinicMemberId]
      );
    } else {
      for (const selectedDoctorId of doctorIds) {
        await query(
          `INSERT INTO receptionist_doctor_scope (clinic_member_id, scope_type, doctor_id, active)
           VALUES ($1, 'ONE_DOCTOR', $2, true)`,
          [clinicMemberId, selectedDoctorId]
        );
      }
    }

    await query('COMMIT');
  } catch (err) {
    await query('ROLLBACK');
    throw err;
  }
}

async function requireAdminDoctor(req, res) {
  if (!req.doctor?.id) {
    res.status(403).json({ error: 'Apenas administrador pode gerenciar equipe' });
    return false;
  }

  if (req.doctor.isAdmin === true) {
    return true;
  }

  const roleResult = await query('SELECT role FROM doctors WHERE id = $1', [req.doctor.id]);
  const role = roleResult.rows[0]?.role;
  if (role !== 'ADMIN') {
    res.status(403).json({ error: 'Apenas administrador pode gerenciar equipe' });
    return false;
  }

  req.doctor.isAdmin = true;
  return true;
}

router.post('/register-doctor', requireDoctor, async (req, res, next) => {
  try {
    if (!(await requireAdminDoctor(req, res))) return;

    const { name, email, password, crm, specialty } = req.body;

    if (!name || !email || !password || !crm) {
      return res.status(400).json({ error: 'name, email, password e crm sao obrigatorios' });
    }

    const exists = await query('SELECT id FROM doctors WHERE email = $1', [email]);
    if (exists.rowCount > 0) {
      return res.status(409).json({ error: 'Email ja cadastrado' });
    }

    const passwordHash = bcrypt.hashSync(password, 10);
    const inserted = await query(
      `INSERT INTO doctors (name, email, password_hash, crm, specialty, role)
       VALUES ($1, $2, $3, $4, $5, 'DOCTOR')
       RETURNING id, name, email, crm, specialty, role, created_at`,
      [name, email, passwordHash, crm, specialty||null]
    );

    // Ao criar pela tela, já vincula na clínica ativa (owner/admin) como member.
    const provisioningClinic = await resolveProvisioningClinic(req);
    if (provisioningClinic) {
      const assoc = await query(
        `INSERT INTO clinic_members (clinic_id, member_id, member_type, role)
         VALUES ($1, $2, 'doctor', 'member')
         ON CONFLICT (clinic_id, member_id, member_type)
         DO UPDATE SET active = true, role = 'member'
         RETURNING id`,
        [provisioningClinic.id, inserted.rows[0].id]
      );
      if (assoc.rowCount > 0) {
        await grantDefaultPermissions(assoc.rows[0].id, 'doctor');
      }
    }

    return res.status(201).json(inserted.rows[0]);
  } catch (error) {
    return next(error);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { clinicName } = req.body;
    const email = normalizeEmail(req.body?.email);
    const password = normalizePassword(req.body?.password);

    if (!isValidCredentialInput(email, password)) {
      return res.status(401).json({ error: 'Credenciais invalidas' });
    }

    const doctorResult = await query('SELECT * FROM doctors WHERE email = $1', [email]);
    const doctor = doctorResult.rows[0];
    const hashToCompare = doctor?.password_hash || DUMMY_PASSWORD_HASH;
    const passwordOk = bcrypt.compareSync(password, hashToCompare);

    if (!doctor || !passwordOk) {
      return res.status(401).json({ error: 'Credenciais invalidas' });
    }

    if (!clinicName || !clinicName.trim()) {
      return res.status(400).json({ error: 'Nome da clinica e obrigatorio para login.' });
    }

    const clinic = await findDoctorClinicByName(doctor.id, clinicName.trim());
    if (!clinic) {
      return res.status(401).json({ error: 'Clinica invalida ou sem vinculo com este profissional.' });
    }

    const isClinicOwner = clinic.clinic_role === 'owner';

    const token = jwt.sign(
      {
        id: doctor.id,
        name: doctor.name,
        email: doctor.email,
        role: 'DOCTOR',
        isAdmin: doctor.role === 'ADMIN',
        clinicId: clinic.id,
        clinicName: clinic.name,
        isClinicOwner,
      },
      JWT_SECRET,
      { expiresIn: '12h', algorithm: 'HS256' }
    );

    clearOtherRoleCookies(res, 'DOCTOR');
    res.cookie('doctorToken', token, {
      httpOnly: true,
      path: '/',
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 12 * 60 * 60 * 1000,
    });

    return res.json({
      token,
      doctor: {
        id: doctor.id,
        name: doctor.name,
        email: doctor.email,
        crm: doctor.crm,
        specialty: doctor.specialty,
        role: doctor.role,
        clinicId: clinic.id,
        clinicName: clinic.name,
        isClinicOwner,
      },
    });
  } catch (error) {
    return next(error);
  }
});

// Retorna clínicas vinculadas a um e-mail de atendente (sem expor dados sensíveis)
router.get('/clinics-for-receptionist', async (req, res, next) => {
  try {
    const { email } = req.query;
    if (!email || !email.trim()) return res.json([]);

    const result = await query(
      `SELECT c.id, c.name
         FROM clinics c
         JOIN clinic_members cm ON cm.clinic_id = c.id
         JOIN receptionists r ON r.id = cm.member_id
        WHERE lower(r.email) = lower($1)
          AND cm.member_type = 'receptionist'
          AND cm.active = true
          AND c.active = true
          AND r.active = true
        ORDER BY c.name ASC`,
      [email.trim()]
    );
    return res.json(result.rows.map(r => ({ id: r.id, name: r.name })));
  } catch (error) {
    return next(error);
  }
});

router.post('/login-receptionist', async (req, res, next) => {
  try {
    const { clinicName } = req.body;
    const email = normalizeEmail(req.body?.email);
    const password = normalizePassword(req.body?.password);

    if (!isValidCredentialInput(email, password)) {
      return res.status(401).json({ error: 'Credenciais invalidas' });
    }

    let receptionistResult;
    try {
      receptionistResult = await query('SELECT * FROM receptionists WHERE email = $1 AND active = true', [email]);
    } catch (dbErr) {
      if (dbErr.code === '42P01') {
        return res.status(400).json({
          error: 'Tabela de recepcionistas nao encontrada neste banco. Confirme a migration no banco de producao.',
        });
      }
      throw dbErr;
    }
    const receptionist = receptionistResult.rows[0];
    const hashToCompare = receptionist?.password_hash || DUMMY_PASSWORD_HASH;
    const passwordOk = bcrypt.compareSync(password, hashToCompare);

    if (!receptionist || !passwordOk) {
      return res.status(401).json({ error: 'Credenciais invalidas' });
    }

    if (!clinicName || !clinicName.trim()) {
      return res.status(400).json({ error: 'Nome da clinica e obrigatorio para login da recepcao.' });
    }

    const clinic = await query(
      `SELECT c.id, c.name
         FROM clinics c
         JOIN clinic_members cm ON cm.clinic_id = c.id
        WHERE lower(c.name) = lower($1)
          AND cm.member_id = $2
          AND cm.member_type = 'receptionist'
          AND cm.active = true
          AND c.active = true
        LIMIT 1`,
      [clinicName.trim(), receptionist.id]
    );
    if (clinic.rowCount === 0) {
      return res.status(401).json({ error: 'Clinica invalida ou sem vinculo com este atendente.' });
    }

    const token = jwt.sign(
      {
        id: receptionist.id,
        name: receptionist.name,
        email: receptionist.email,
        role: 'RECEPTIONIST',
        clinicId: clinic.rows[0].id,
        clinicName: clinic.rows[0].name,
      },
      JWT_SECRET,
      { expiresIn: '12h', algorithm: 'HS256' }
    );

    clearOtherRoleCookies(res, 'RECEPTIONIST');
    res.cookie('receptionToken', token, {
      httpOnly: true,
      path: '/',
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 12 * 60 * 60 * 1000,
    });

    return res.json({
      token,
      receptionist: {
        id: receptionist.id,
        name: receptionist.name,
        email: receptionist.email,
        role: 'RECEPTIONIST',
        clinicId: clinic.rows[0].id,
        clinicName: clinic.rows[0].name,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/register-receptionist', requireDoctor, async (req, res, next) => {
  try {
    if (!(await requireAdminDoctor(req, res))) return;

    const { name, email, password, scopeType, doctorId, doctorIds } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email e password sao obrigatorios' });
    }

    let exists;
    try {
      exists = await query('SELECT id FROM receptionists WHERE email = $1', [email]);
    } catch (dbErr) {
      if (dbErr.code === '42P01') {
        return res.status(400).json({
          error: 'Tabela de recepcionistas nao encontrada neste banco. Confirme a migration no banco de producao.',
        });
      }
      throw dbErr;
    }
    if (exists.rowCount > 0) {
      return res.status(409).json({ error: 'Email ja cadastrado' });
    }

    const inserted = await query(
      `INSERT INTO receptionists (name, email, password_hash, active)
       VALUES ($1, $2, $3, true)
       RETURNING id, name, email, active, created_at`,
      [name, email, bcrypt.hashSync(password, 10)]
    );

    // Ao criar pela tela, já vincula na clínica ativa (owner/admin) como member.
    const provisioningClinic = await resolveProvisioningClinic(req);
    if (provisioningClinic) {
      const assoc = await query(
        `INSERT INTO clinic_members (clinic_id, member_id, member_type, role)
         VALUES ($1, $2, 'receptionist', 'member')
         ON CONFLICT (clinic_id, member_id, member_type)
         DO UPDATE SET active = true, role = 'member'
         RETURNING id`,
        [provisioningClinic.id, inserted.rows[0].id]
      );
      if (assoc.rowCount > 0) {
        const clinicMemberId = assoc.rows[0].id;
        await grantDefaultPermissions(clinicMemberId, 'receptionist');

        // Persistir escopo de agenda da recepcao: todos ou lista de medicos.
        const normalized = normalizeReceptionScope(scopeType, doctorId, doctorIds);
        if (normalized.scopeType === 'ONE_DOCTOR' && normalized.doctorIds.length === 0) {
          return res.status(400).json({ error: 'Selecione ao menos um medico para escopo especifico.' });
        }

        const validDoctorIds = await validateDoctorsInClinic(provisioningClinic.id, normalized.doctorIds);
        await persistReceptionistScope(clinicMemberId, normalized.scopeType, validDoctorIds);
      }
    }


    return res.status(201).json(inserted.rows[0]);
  } catch (error) {
    return next(error);
  }
});

router.get('/team/doctors', requireDoctor, async (req, res, next) => {
  try {
    if (!(await requireAdminDoctor(req, res))) return;

    const clinicId = req.doctor.clinicId || null;
    if (!clinicId) return res.json([]);

    const result = await query(
      `SELECT d.id, d.name, d.email, d.crm, d.specialty, d.role, d.created_at
         FROM doctors d
         JOIN clinic_members cm ON cm.member_id = d.id
        WHERE cm.clinic_id = $1
          AND cm.member_type = 'doctor'
          AND cm.active = true
        ORDER BY d.created_at DESC`,
      [clinicId]
    );

    return res.json(result.rows);
  } catch (error) {
    return next(error);
  }
});

router.get('/team/receptionists', requireDoctor, async (req, res, next) => {
  try {
    if (!(await requireAdminDoctor(req, res))) return;

    const clinicId = req.doctor.clinicId || null;
    if (!clinicId) return res.json([]);

    let result;
    try {
      result = await query(
        `SELECT r.id, r.name, r.email, r.active, r.created_at
           FROM receptionists r
           JOIN clinic_members cm ON cm.member_id = r.id
          WHERE cm.clinic_id = $1
            AND cm.member_type = 'receptionist'
            AND cm.active = true
          ORDER BY r.created_at DESC`,
        [clinicId]
      );
    } catch (dbErr) {
      if (dbErr.code === '42P01') {
        return res.json([]);
      }
      throw dbErr;
    }

    return res.json(result.rows);
  } catch (error) {
    return next(error);
  }
});

router.get('/me', requireDoctor, async (req, res, next) => {
  try {
    const result = await query(
      'SELECT id, name, email, crm, specialty, role, phone, bio, photo_url, created_at FROM doctors WHERE id = $1',
      [req.doctor.id]
    );

    const me = result.rows[0] || null;
    if (!me) return res.json(null);

    const ownerClinic = await findOwnedClinicByDoctor(req.doctor.id);
    return res.json({
      ...me,
      isClinicOwner: !!ownerClinic,
      clinicId: req.doctor.clinicId || ownerClinic?.id || null,
      clinicName: req.doctor.clinicName || ownerClinic?.name || null,
    });
  } catch (error) {
    return next(error);
  }
});

// Auto-edicao do proprio perfil — funciona tanto pra medico quanto
// recepcionista, cada um so mexe nos proprios dados (nunca no de outra
// pessoa; pra editar o perfil de terceiros e preciso ser dono da clinica,
// pela tela de Minha Clinica).
router.put('/me/profile', requireDoctorOrReceptionist, async (req, res, next) => {
  try {
    const { name, phone, bio, specialty, photoUrl } = req.body;
    if (photoUrl && photoUrl.length > 4.2 * 1024 * 1024) {
      return res.status(400).json({ error: 'Foto muito grande (maximo aproximado de 3MB).' });
    }
    if (name != null && !String(name).trim()) {
      return res.status(400).json({ error: 'O nome nao pode ficar em branco.' });
    }

    if (req.user.role === 'DOCTOR') {
      const updated = await query(
        `UPDATE doctors SET
           name = COALESCE($1, name),
           phone = COALESCE($2, phone),
           bio = COALESCE($3, bio),
           specialty = COALESCE($4, specialty),
           photo_url = COALESCE($5, photo_url)
         WHERE id = $6
         RETURNING id, name, email, crm, specialty, phone, bio, photo_url`,
        [
          name != null ? String(name).trim() : null,
          phone ?? null,
          bio ?? null,
          specialty != null ? String(specialty).trim() : null,
          photoUrl ?? null,
          req.user.id,
        ]
      );
      return res.json(updated.rows[0]);
    }

    const updated = await query(
      `UPDATE receptionists SET
         name = COALESCE($1, name),
         phone = COALESCE($2, phone),
         photo_url = COALESCE($3, photo_url)
       WHERE id = $4
       RETURNING id, name, email, phone, photo_url`,
      [
        name != null ? String(name).trim() : null,
        phone ?? null,
        photoUrl ?? null,
        req.user.id,
      ]
    );
    return res.json(updated.rows[0]);
  } catch (error) {
    return next(error);
  }
});

router.get('/permissions', requireDoctor, async (req, res, next) => {
  try {
    const clinicId = req.doctor.clinicId || null;
    if (!clinicId) return res.json({ clinicId: null, pages: [] });

    const owner = await query(
      `SELECT id FROM clinics WHERE id = $1 AND created_by = $2 AND active = true LIMIT 1`,
      [clinicId, req.doctor.id]
    );

    if (owner.rowCount > 0) {
      const pages = await query(
        `SELECT code, name, menu_group, sort_order, member_type,
                false AS is_out_of_profile,
                true AS can_view, true AS can_create, true AS can_update, true AS can_delete
           FROM app_pages
          WHERE active = true
          ORDER BY menu_group, sort_order`
      );
      return res.json({ clinicId, isOwner: true, pages: pages.rows });
    }

    const perms = await query(
      `SELECT p.code, p.name, p.menu_group, p.sort_order, p.member_type,
              (p.member_type <> 'doctor' AND p.member_type <> 'both') AS is_out_of_profile,
              COALESCE(cmp.can_view,
                CASE WHEN (p.member_type = 'doctor' OR p.member_type = 'both') THEN p.default_can_view ELSE false END
              ) AS can_view,
              COALESCE(cmp.can_create,
                CASE WHEN (p.member_type = 'doctor' OR p.member_type = 'both') THEN p.default_can_create ELSE false END
              ) AS can_create,
              COALESCE(cmp.can_update,
                CASE WHEN (p.member_type = 'doctor' OR p.member_type = 'both') THEN p.default_can_update ELSE false END
              ) AS can_update,
              COALESCE(cmp.can_delete,
                CASE WHEN (p.member_type = 'doctor' OR p.member_type = 'both') THEN p.default_can_delete ELSE false END
              ) AS can_delete
         FROM clinic_members cm
         JOIN app_pages p ON p.active = true
         LEFT JOIN clinic_member_permissions cmp ON cmp.clinic_member_id = cm.id AND cmp.page_code = p.code
        WHERE cm.clinic_id = $1
          AND cm.member_id = $2
          AND cm.member_type = 'doctor'
          AND cm.active = true
        ORDER BY p.menu_group, p.sort_order`,
      [clinicId, req.doctor.id]
    );

    return res.json({ clinicId, isOwner: false, pages: perms.rows });
  } catch (error) {
    return next(error);
  }
});

// Mesma lógica acima, só que para o lado da recepção (usada para esconder/mostrar
// itens do menu de acordo com o que o proprietário configurou em Gestão da Clínica).
router.get('/permissions-receptionist', requireReceptionist, async (req, res, next) => {
  try {
    const clinicId = req.receptionist.clinicId || null;
    if (!clinicId) return res.json({ clinicId: null, pages: [] });

    const perms = await query(
      `SELECT p.code, p.name, p.menu_group, p.sort_order, p.member_type,
              (p.member_type <> 'receptionist' AND p.member_type <> 'both') AS is_out_of_profile,
              COALESCE(cmp.can_view,
                CASE WHEN (p.member_type = 'receptionist' OR p.member_type = 'both') THEN p.default_can_view ELSE false END
              ) AS can_view,
              COALESCE(cmp.can_create,
                CASE WHEN (p.member_type = 'receptionist' OR p.member_type = 'both') THEN p.default_can_create ELSE false END
              ) AS can_create,
              COALESCE(cmp.can_update,
                CASE WHEN (p.member_type = 'receptionist' OR p.member_type = 'both') THEN p.default_can_update ELSE false END
              ) AS can_update,
              COALESCE(cmp.can_delete,
                CASE WHEN (p.member_type = 'receptionist' OR p.member_type = 'both') THEN p.default_can_delete ELSE false END
              ) AS can_delete
         FROM clinic_members cm
         JOIN app_pages p ON p.active = true
         LEFT JOIN clinic_member_permissions cmp ON cmp.clinic_member_id = cm.id AND cmp.page_code = p.code
        WHERE cm.clinic_id = $1
          AND cm.member_id = $2
          AND cm.member_type = 'receptionist'
          AND cm.active = true
        ORDER BY p.menu_group, p.sort_order`,
      [clinicId, req.receptionist.id]
    );

    return res.json({ clinicId, isOwner: false, pages: perms.rows });
  } catch (error) {
    return next(error);
  }
});

// ─── GOOGLE CALENDAR OAUTH2 ──────────────────────────────────────
router.get('/google/authorize', requireDoctor, (req, res) => {
  if (!gcal.isEnabled()) {
    const config = gcal.getConfigStatus();
    return res.status(400).json({
      error: `Google Calendar nao configurado. Campos ausentes: ${config.missing.join(', ') || 'nenhum'}`,
    });
  }
  const url = gcal.getAuthUrl(req.doctor.id);
  return res.json({ url });
});

router.get('/google/callback', async (req, res, next) => {
  try {
    const { code, state, error } = req.query;
    if (error) {
      const deniedTarget = String(state || '').startsWith('patient:')
        ? '/paciente/portal?gcal=denied'
        : '/medico/agenda?gcal=denied';
      return res.redirect(deniedTarget);
    }
    if (!code || !state) {
      return res.redirect('/medico/agenda?gcal=error');
    }

    const tokens = await gcal.exchangeCodeForTokens(code);

    if (String(state).startsWith('patient:')) {
      const patientId = String(state).slice('patient:'.length);
      if (!patientId) return res.redirect('/paciente/portal?gcal=error');
      await gcal.savePatientTokens(patientId, tokens);
      return res.redirect('/paciente/portal?gcal=connected');
    }

    await gcal.saveDoctorTokens(state, tokens);
    return res.redirect('/medico/agenda?gcal=connected');
  } catch (err) {
    const errCode = err?.code || '';
    const errMsg = String(err?.message || '').toLowerCase();
    const state = String(req.query?.state || '');
    const isPatient = state.startsWith('patient:');
    const patientRedirect = '/paciente/portal';
    const doctorRedirect = '/medico/agenda';
    const redirectBase = isPatient ? patientRedirect : doctorRedirect;

    if (errCode === 'GCAL_SCHEMA_MISSING') {
      console.error('[Google Calendar] Falha no callback: schema incompleto no banco.', err.message);
      return res.redirect(`${redirectBase}?gcal=schema`);
    }

    if (errCode === 'GCAL_PATIENT_SCHEMA_MISSING') {
      console.error('[Google Calendar] Falha no callback paciente: schema incompleto no banco.', err.message);
      return res.redirect('/paciente/portal?gcal=schema');
    }

    if (errCode === 'invalid_grant' || errMsg.includes('invalid_grant')) {
      console.error('[Google Calendar] Falha no callback: invalid_grant (redirect URI, code expirado ou consentimento).');
      return res.redirect(`${redirectBase}?gcal=invalid-grant`);
    }

    console.error('[Google Calendar] Falha inesperada no callback:', err.message);
    return res.redirect(`${redirectBase}?gcal=error`);
  }
});

router.post('/google/disconnect', requireDoctor, async (req, res, next) => {
  try {
    await gcal.disconnectDoctor(req.doctor.id);
    return res.json({ ok: true });
  } catch (err) {
    if (err?.code === 'GCAL_SCHEMA_MISSING') {
      return res.status(412).json({
        ok: false,
        error: 'Schema Google Calendar não aplicado no banco. Rode o schema.sql atualizado.',
      });
    }
    return next(err);
  }
});

router.get('/google/status', requireDoctor, async (req, res, next) => {
  try {
    const row = await gcal.getDoctorTokens(req.doctor.id);
    return res.json({ connected: !!(row && row.google_calendar_connected) });
  } catch (err) {
    if (err?.code === 'GCAL_SCHEMA_MISSING') {
      return res.status(200).json({
        connected: false,
        setupRequired: true,
        error: 'Schema Google Calendar não aplicado no banco. Rode o schema.sql atualizado.',
      });
    }
    return next(err);
  }
});

module.exports = router;
