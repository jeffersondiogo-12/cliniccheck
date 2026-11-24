const express = require('express');
const { query } = require('../config/database');
const { requireDoctor } = require('../middleware/auth');
const socketService = require('../services/socketService');

const router = express.Router();

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

const ROLE_WEIGHT = {
  member: 1,
  admin: 2,
  owner: 3,
};

function hasMinimumRole(currentRole, requiredRole) {
  return (ROLE_WEIGHT[currentRole] || 0) >= (ROLE_WEIGHT[requiredRole] || 0);
}

async function isGlobalOwner(doctorId) {
  const owner = await query(
    `SELECT 1 FROM clinics WHERE created_by = $1 AND active = true LIMIT 1`,
    [doctorId]
  );
  return owner.rowCount > 0;
}

async function isClinicOwner(doctorId, clinicId) {
  const owner = await query(
    `SELECT 1
       FROM clinics
      WHERE id = $1
        AND created_by = $2
        AND active = true
      LIMIT 1`,
    [clinicId, doctorId]
  );
  return owner.rowCount > 0;
}

async function canCreateClinic(doctorId) {
  // Owner pode criar novas clínicas.
  if (await isGlobalOwner(doctorId)) return true;

  // Bootstrap: permite a primeira clínica para médico sem vínculo prévio.
  const linkedAsMember = await query(
    `SELECT 1
       FROM clinic_members
      WHERE member_id = $1
        AND member_type = 'doctor'
        AND active = true
      LIMIT 1`,
    [doctorId]
  );
  return linkedAsMember.rowCount === 0;
}

async function resolveDoctorRoleForClinic(req, clinicId) {
  const doctorId = req.doctor.id;

  // Owner apenas da clínica que criou.
  if (await isClinicOwner(doctorId, clinicId)) {
    return { role: 'owner' };
  }

  // Admin/member ficam restritos à clínica ativa do login.
  if (!req.doctor?.clinicId || String(req.doctor.clinicId) !== String(clinicId)) {
    return { role: null, reason: 'ACTIVE_CLINIC_ONLY' };
  }

  const member = await query(
    `SELECT role
       FROM clinic_members
      WHERE clinic_id = $1
        AND member_id = $2
        AND member_type = 'doctor'
        AND active = true
      LIMIT 1`,
    [clinicId, doctorId]
  );

  if (member.rowCount === 0) {
    return { role: null, reason: 'NO_MEMBERSHIP' };
  }

  return { role: member.rows[0].role || 'member' };
}

async function requireClinicRole(req, res, clinicId, requiredRole) {
  const resolved = await resolveDoctorRoleForClinic(req, clinicId);
  if (!resolved.role) {
    if (resolved.reason === 'ACTIVE_CLINIC_ONLY') {
      res.status(403).json({ error: 'Admin e membro so podem atuar na clinica ativa do login.' });
    } else {
      res.status(403).json({ error: 'Sem permissao para esta clinica.' });
    }
    return null;
  }

  if (!hasMinimumRole(resolved.role, requiredRole)) {
    res.status(403).json({ error: `Permissao insuficiente. Requer papel ${requiredRole}.` });
    return null;
  }

  return resolved;
}

async function getClinicMemberScoped(memberRowId, clinicId) {
  const found = await query(
    `SELECT id, clinic_id, member_id, member_type, role, active
       FROM clinic_members
      WHERE id = $1 AND clinic_id = $2
      LIMIT 1`,
    [memberRowId, clinicId]
  );
  return found.rows[0] || null;
}

router.use(requireDoctor);

// ─── LISTAR CLÍNICAS DO MÉDICO ────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const doctorId = req.doctor.id;
    const result = await query(`
      SELECT
        c.id, c.name, c.cnpj, c.phone, c.email,
        c.address, c.city, c.state, c.zip_code,
        c.logo_url, c.header_color, c.header_image_url, c.footer_text,
        c.active, c.created_at, c.updated_at,
        (c.created_by = $1) AS is_owner,
        (SELECT COUNT(*) FROM clinic_members cm WHERE cm.clinic_id = c.id AND cm.active = true) AS member_count
      FROM clinics c
      LEFT JOIN clinic_members cm2 ON cm2.clinic_id = c.id AND cm2.member_id = $1 AND cm2.member_type = 'doctor' AND cm2.active = true
      WHERE c.created_by = $1 OR cm2.id IS NOT NULL
      ORDER BY c.name ASC
    `, [doctorId]);
    return res.json(result.rows);
  } catch (err) { return next(err); }
});

// ─── CRIAR CLÍNICA ────────────────────────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const doctorId = req.doctor.id;
    const canCreate = await canCreateClinic(doctorId);
    if (!canCreate) {
      return res.status(403).json({ error: 'Somente owner pode criar nova clinica.' });
    }

    const { name, cnpj, phone, email, address, city, state, zipCode, logoUrl, headerColor, headerImageUrl, footerText } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Nome da clínica é obrigatório.' });

    // Normaliza CNPJ
    const cnpjClean = cnpj ? cnpj.replace(/\D/g, '') : null;
    if (cnpjClean && cnpjClean.length !== 14) {
      return res.status(400).json({ error: 'CNPJ inválido. Informe 14 dígitos.' });
    }

    const result = await query(`
      INSERT INTO clinics (name, cnpj, phone, email, address, city, state, zip_code, logo_url, header_color, header_image_url, footer_text, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *
    `, [name.trim(), cnpjClean||null, phone||null, email||null, address||null, city||null, state||null, zipCode||null, logoUrl||null, headerColor||null, headerImageUrl||null, footerText||null, doctorId]);

    const clinic = result.rows[0];

    // Registra o criador como membro owner
    const ownerAssoc = await query(`
      INSERT INTO clinic_members (clinic_id, member_id, member_type, role)
      VALUES ($1,$2,'doctor','owner')
      ON CONFLICT (clinic_id, member_id, member_type)
      DO UPDATE SET active=true, role='owner'
      RETURNING id
    `, [clinic.id, doctorId]);

    if (ownerAssoc.rowCount > 0) {
      await grantDefaultPermissions(ownerAssoc.rows[0].id, 'doctor');
      await query(
        `UPDATE clinic_member_permissions
            SET can_view = true, can_create = true, can_update = true, can_delete = true
          WHERE clinic_member_id = $1`,
        [ownerAssoc.rows[0].id]
      );
    }

    socketService.emitToDoctor(doctorId, 'clinic_created', {
      id: clinic.id,
      name: clinic.name,
    });

    return res.status(201).json(clinic);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'CNPJ já cadastrado em outra clínica.' });
    return next(err);
  }
});

// ─── ATUALIZAR CLÍNICA ────────────────────────────────────────────────
router.put('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, cnpj, phone, email, address, city, state, zipCode, logoUrl, headerColor, headerImageUrl, footerText, active } = req.body;
    const acl = await requireClinicRole(req, res, id, 'admin');
    if (!acl) return;

    const cnpjClean = cnpj ? cnpj.replace(/\D/g, '') : null;
    if (cnpjClean && cnpjClean.length !== 14) {
      return res.status(400).json({ error: 'CNPJ inválido. Informe 14 dígitos.' });
    }

    const result = await query(`
      UPDATE clinics SET
        name             = COALESCE($2, name),
        cnpj             = $3,
        phone            = $4,
        email            = $5,
        address          = $6,
        city             = $7,
        state            = $8,
        zip_code         = $9,
        logo_url         = $10,
        header_color     = COALESCE($11, header_color),
        header_image_url = $12,
        footer_text      = $13,
        active           = COALESCE($14, active),
        updated_at       = now()
      WHERE id = $1
      RETURNING *
    `, [id, name?.trim()||null, cnpjClean||null, phone||null, email||null, address||null, city||null, state||null, zipCode||null, logoUrl||null, headerColor||null, headerImageUrl||null, footerText||null, active??null]);

    if (!result.rows.length) return res.status(404).json({ error: 'Clínica não encontrada.' });

    socketService.emitToDoctor(req.doctor.id, 'clinic_updated', {
      id: result.rows[0].id,
      name: result.rows[0].name,
      active: result.rows[0].active,
    });

    return res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'CNPJ já cadastrado em outra clínica.' });
    return next(err);
  }
});

// ─── EXCLUIR CLÍNICA (soft delete) ───────────────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const acl = await requireClinicRole(req, res, id, 'owner');
    if (!acl) return;

    const result = await query(
      `UPDATE clinics SET active = false, updated_at = now() WHERE id = $1 RETURNING id`,
      [id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Clínica não encontrada ou sem permissão.' });

    socketService.emitToDoctor(req.doctor.id, 'clinic_deactivated', {
      id,
    });

    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

// ─── LISTAR MEMBROS DA CLÍNICA ────────────────────────────────────────
router.get('/:id/members', async (req, res, next) => {
  try {
    const { id } = req.params;
    const acl = await requireClinicRole(req, res, id, 'member');
    if (!acl) return;

    const result = await query(`
      SELECT
        cm.id AS member_row_id,
        cm.member_id,
        cm.member_type,
        cm.role,
        cm.active,
        cm.joined_at,
        CASE
          WHEN cm.member_type = 'doctor'       THEN d.name
          WHEN cm.member_type = 'receptionist' THEN r.name
        END AS name,
        CASE
          WHEN cm.member_type = 'doctor'       THEN d.email
          WHEN cm.member_type = 'receptionist' THEN r.email
        END AS email,
        CASE
          WHEN cm.member_type = 'doctor' THEN d.crm
          ELSE NULL
        END AS crm,
        CASE
          WHEN cm.member_type = 'doctor'       THEN d.phone
          WHEN cm.member_type = 'receptionist' THEN r.phone
        END AS phone,
        CASE
          WHEN cm.member_type = 'doctor'       THEN d.photo_url
          WHEN cm.member_type = 'receptionist' THEN r.photo_url
        END AS photo_url,
        CASE
          WHEN cm.member_type = 'doctor' THEN d.bio
          ELSE NULL
        END AS bio,
        CASE
          WHEN cm.member_type = 'doctor' THEN d.specialty
          ELSE NULL
        END AS specialty
      FROM clinic_members cm
      LEFT JOIN doctors       d ON d.id = cm.member_id AND cm.member_type = 'doctor'
      LEFT JOIN receptionists r ON r.id = cm.member_id AND cm.member_type = 'receptionist'
      WHERE cm.clinic_id = $1
      ORDER BY cm.role ASC, name ASC
    `, [id]);
    return res.json(result.rows);
  } catch (err) { return next(err); }
});

// ─── ADICIONAR MEMBRO ─────────────────────────────────────────────────
router.post('/:id/members', async (req, res, next) => {
  try {
    const clinicId = req.params.id;
    const { memberId, memberType } = req.body;
    const acl = await requireClinicRole(req, res, clinicId, 'admin');
    if (!acl) return;

    if (!memberId) return res.status(400).json({ error: 'memberId é obrigatório.' });
    if (!['doctor','receptionist'].includes(memberType)) {
      return res.status(400).json({ error: 'memberType deve ser "doctor" ou "receptionist".' });
    }

    // Verifica se o membro existe
    let check;
    if (memberType === 'doctor') {
      check = await query(`SELECT id, name, email, crm FROM doctors WHERE id=$1`, [memberId]);
    } else {
      check = await query(`SELECT id, name, email FROM receptionists WHERE id=$1`, [memberId]);
    }
    if (!check.rows.length) return res.status(404).json({ error: 'Profissional não encontrado.' });

    // Sempre entra como member no ato da criação/vinculação.
    const validRole = 'member';
    const result = await query(`
      INSERT INTO clinic_members (clinic_id, member_id, member_type, role)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (clinic_id, member_id, member_type) DO UPDATE SET active=true, role=$4
      RETURNING *
    `, [clinicId, memberId, memberType, validRole]);

    await grantDefaultPermissions(result.rows[0].id, memberType);

    socketService.emitToDoctor(req.doctor.id, 'clinic_member_added', {
      clinic_id: clinicId,
      member_id: memberId,
      member_type: memberType,
      role: validRole,
    });
    if (memberType === 'doctor') {
      socketService.emitToDoctor(memberId, 'clinic_member_added', {
        clinic_id: clinicId,
        member_id: memberId,
        member_type: memberType,
        role: validRole,
      });
    }

    return res.status(201).json({ ...result.rows[0], name: check.rows[0].name, email: check.rows[0].email });
  } catch (err) { return next(err); }
});

// ─── ATUALIZAR PAPEL DO MEMBRO ────────────────────────────────────────
router.patch('/:id/members/:memberRowId', async (req, res, next) => {
  try {
    const { id: clinicId, memberRowId } = req.params;
    const { role } = req.body;
    const acl = await requireClinicRole(req, res, clinicId, 'admin');
    if (!acl) return;

    const targetMember = await getClinicMemberScoped(memberRowId, clinicId);
    if (!targetMember) {
      return res.status(404).json({ error: 'Membro nao encontrado para a clinica informada.' });
    }

    // Papel owner nao pode ser delegado por este endpoint.
    const validRole = ['admin', 'member'].includes(role) ? role : 'member';

    await query(`UPDATE clinic_members SET role=$1 WHERE id=$2`, [validRole, memberRowId]);
    if (validRole === 'admin') {
      await query(
        `UPDATE clinic_member_permissions
            SET can_view = true, can_create = true, can_update = true, can_delete = true
          WHERE clinic_member_id = $1`,
        [memberRowId]
      );
    }

    socketService.emitToDoctor(req.doctor.id, 'clinic_member_role_updated', {
      clinic_id: clinicId,
      member_row_id: memberRowId,
      role: validRole,
    });

    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

// ─── EDITAR PERFIL DE UM MEMBRO (dono/admin da clinica edita qualquer perfil) ──
router.put('/:id/members/:memberRowId/profile', async (req, res, next) => {
  try {
    const { id: clinicId, memberRowId } = req.params;
    const acl = await requireClinicRole(req, res, clinicId, 'admin');
    if (!acl) return;

    const targetMember = await getClinicMemberScoped(memberRowId, clinicId);
    if (!targetMember) {
      return res.status(404).json({ error: 'Membro nao encontrado para a clinica informada.' });
    }

    const { name, phone, bio, specialty, photoUrl } = req.body;
    if (photoUrl && photoUrl.length > 4.2 * 1024 * 1024) {
      return res.status(400).json({ error: 'Foto muito grande (maximo aproximado de 3MB).' });
    }
    if (name != null && !String(name).trim()) {
      return res.status(400).json({ error: 'O nome nao pode ficar em branco.' });
    }

    let updated;
    if (targetMember.member_type === 'doctor') {
      updated = await query(
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
          targetMember.member_id,
        ]
      );
    } else {
      updated = await query(
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
          targetMember.member_id,
        ]
      );
    }
    if (updated.rowCount === 0) return res.status(404).json({ error: 'Registro nao encontrado.' });

    socketService.emitToDoctor(req.doctor.id, 'clinic_member_profile_updated', {
      clinic_id: clinicId,
      member_row_id: memberRowId,
    });

    return res.json(updated.rows[0]);
  } catch (err) { return next(err); }
});

// ─── PERMISSÕES DE UM MEMBRO ────────────────────────────────────────────
router.get('/:id/members/:memberRowId/permissions', async (req, res, next) => {
  try {
    const { id: clinicId, memberRowId } = req.params;
    const acl = await requireClinicRole(req, res, clinicId, 'admin');
    if (!acl) return;

    const member = await query(
      `SELECT member_type FROM clinic_members WHERE id = $1 AND clinic_id = $2 LIMIT 1`,
      [memberRowId, clinicId]
    );
    if (member.rowCount === 0) return res.status(404).json({ error: 'Membro não encontrado.' });
    const memberType = member.rows[0].member_type;

    const pages = await query(
      `SELECT p.code, p.name, p.menu_group, p.sort_order, p.member_type,
              (p.member_type <> $2 AND p.member_type <> 'both') AS is_out_of_profile,
              COALESCE(cmp.can_view,
                CASE WHEN (p.member_type = $2 OR p.member_type = 'both') THEN p.default_can_view ELSE false END
              ) AS can_view,
              COALESCE(cmp.can_create,
                CASE WHEN (p.member_type = $2 OR p.member_type = 'both') THEN p.default_can_create ELSE false END
              ) AS can_create,
              COALESCE(cmp.can_update,
                CASE WHEN (p.member_type = $2 OR p.member_type = 'both') THEN p.default_can_update ELSE false END
              ) AS can_update,
              COALESCE(cmp.can_delete,
                CASE WHEN (p.member_type = $2 OR p.member_type = 'both') THEN p.default_can_delete ELSE false END
              ) AS can_delete
         FROM app_pages p
         LEFT JOIN clinic_member_permissions cmp
           ON cmp.page_code = p.code
          AND cmp.clinic_member_id = $1
        WHERE p.active = true
        ORDER BY p.menu_group, p.sort_order`,
      [memberRowId, memberType]
    );
    return res.json(pages.rows);
  } catch (err) { return next(err); }
});

router.put('/:id/members/:memberRowId/permissions', async (req, res, next) => {
  try {
    const { id: clinicId, memberRowId } = req.params;
    const acl = await requireClinicRole(req, res, clinicId, 'admin');
    if (!acl) return;

    const targetMember = await getClinicMemberScoped(memberRowId, clinicId);
    if (!targetMember) {
      return res.status(404).json({ error: 'Membro nao encontrado para a clinica informada.' });
    }

    const { permissions } = req.body;
    if (!Array.isArray(permissions)) {
      return res.status(400).json({ error: 'permissions deve ser uma lista.' });
    }

    for (const item of permissions) {
      await query(
        `INSERT INTO clinic_member_permissions (clinic_member_id, page_code, can_view, can_create, can_update, can_delete)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (clinic_member_id, page_code)
         DO UPDATE SET can_view = EXCLUDED.can_view,
                       can_create = EXCLUDED.can_create,
                       can_update = EXCLUDED.can_update,
                       can_delete = EXCLUDED.can_delete,
                       updated_at = now()`,
        [
          memberRowId,
          item.pageCode,
          !!item.canView,
          !!item.canCreate,
          !!item.canUpdate,
          !!item.canDelete,
        ]
      );
    }
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
});

// ─── REMOVER MEMBRO ───────────────────────────────────────────────────
router.delete('/:id/members/:memberRowId', async (req, res, next) => {
  try {
    const { id: clinicId, memberRowId } = req.params;
    const acl = await requireClinicRole(req, res, clinicId, 'admin');
    if (!acl) return;

    const targetMember = await getClinicMemberScoped(memberRowId, clinicId);
    if (!targetMember) {
      return res.status(404).json({ error: 'Membro nao encontrado para a clinica informada.' });
    }

    if (targetMember.member_type === 'doctor' && String(targetMember.member_id) === String(req.doctor.id)) {
      return res.status(400).json({ error: 'Nao e permitido remover o proprio acesso.' });
    }

    await query(`UPDATE clinic_members SET active=false WHERE id=$1`, [memberRowId]);

    socketService.emitToDoctor(req.doctor.id, 'clinic_member_removed', {
      clinic_id: clinicId,
      member_row_id: memberRowId,
    });

    return res.json({ ok: true });
  } catch (err) { return next(err); }
});

router.get('/:id/doctors', async (req, res, next) => {
  try {
    const { id: clinicId } = req.params;
    const acl = await requireClinicRole(req, res, clinicId, 'member');
    if (!acl) return;

    // Retorna médicos que já pertencem à clínica
    const result = await query(
      `SELECT d.id, d.name, d.crm
         FROM doctors d
         JOIN clinic_members cm ON cm.member_id = d.id AND cm.member_type = 'doctor' AND cm.clinic_id = $1
        WHERE cm.active = true
        ORDER BY d.name ASC`,
      [clinicId]
    );
    return res.json(result.rows);
  } catch (err) { return next(err); }
});

// ─── LISTAR RECEPCIONISTAS DA CLÍNICA ────────────────────────────────
router.get('/:id/receptionists', async (req, res, next) => {
  try {
    const { id: clinicId } = req.params;
    const acl = await requireClinicRole(req, res, clinicId, 'member');
    if (!acl) return;

    const result = await query(
      `SELECT r.id, r.name
         FROM receptionists r
         JOIN clinic_members cm ON cm.member_id = r.id AND cm.member_type = 'receptionist' AND cm.clinic_id = $1
        WHERE cm.active = true
        ORDER BY r.name ASC`,
      [clinicId]
    );
    return res.json(result.rows);
  } catch (err) { return next(err); }
});

// ─── LISTAR TODOS OS MÉDICOS (para add membros) ───────────────────────
// Retorna apenas médicos que ainda não são membros da clínica do owner,
// sem expor e-mail para não vazar dados de outros consultórios.
router.get('/all-doctors', async (req, res, next) => {
  try {
    const clinicId = req.doctor?.clinicId || null;
    if (!clinicId) {
      return res.status(400).json({ error: 'Clinica ativa nao encontrada no contexto de login.' });
    }

    const acl = await requireClinicRole(req, res, clinicId, 'admin');
    if (!acl) return;

    const result = await query(
      `SELECT d.id, d.name, d.crm
         FROM doctors d
        WHERE NOT EXISTS (
          SELECT 1 FROM clinic_members cm
           WHERE cm.clinic_id = $1
             AND cm.member_id = d.id
             AND cm.member_type = 'doctor'
             AND cm.active = true
        )
        ORDER BY d.name ASC`,
      [clinicId]
    );
    return res.json(result.rows);
  } catch (err) { return next(err); }
});

// ─── LISTAR TODOS OS RECEPCIONISTAS (para add membros) ────────────────
// Retorna apenas recepcionistas que ainda não são membros da clínica do owner,
// sem expor e-mail para não vazar dados de outros consultórios.
router.get('/all-receptionists', async (req, res, next) => {
  try {
    const clinicId = req.doctor?.clinicId || null;
    if (!clinicId) {
      return res.status(400).json({ error: 'Clinica ativa nao encontrada no contexto de login.' });
    }

    const acl = await requireClinicRole(req, res, clinicId, 'admin');
    if (!acl) return;

    const result = await query(
      `SELECT r.id, r.name
         FROM receptionists r
        WHERE NOT EXISTS (
          SELECT 1 FROM clinic_members cm
           WHERE cm.clinic_id = $1
             AND cm.member_id = r.id
             AND cm.member_type = 'receptionist'
             AND cm.active = true
        )
        AND r.active = true
        ORDER BY r.name ASC`,
      [clinicId]
    );
    return res.json(result.rows);
  } catch (err) { return next(err); }
});

module.exports = router;
