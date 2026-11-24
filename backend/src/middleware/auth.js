const jwt = require('jsonwebtoken');
const { query } = require('../config/database');
const { getJwtSecret } = require('../config/security');

const JWT_SECRET = getJwtSecret();

// Nomes dos cookies de sessao, um por perfil. Um mesmo navegador pode
// acumular mais de um ao mesmo tempo (ex: alguem que ja logou como medico
// antes de tentar logar como paciente ou recepcionista), porque os cookies
// sao httpOnly e so o servidor consegue apaga-los de verdade — o
// `document.cookie = 'xToken=; expires=...'` feito no front nao tem efeito
// nenhum sobre um cookie httpOnly, entao o cookie antigo continua valido.
// Por isso a extracao abaixo NAO escolhe um cookie por prioridade fixa
// (o bug era: doctorToken sempre vencia se existisse). Em vez disso ela
// junta todos os candidatos presentes e cada middleware valida pelo
// "role" gravado dentro do proprio token, nao pelo nome do cookie que
// apareceu primeiro.
const ROLE_COOKIE_NAMES = {
  DOCTOR: 'doctorToken',
  RECEPTIONIST: 'receptionToken',
  PATIENT: 'patientToken',
};

function parseCookies(req) {
  const cookies = req.headers.cookie || '';
  if (!cookies) return {};

  const cookieMap = {};
  for (const chunk of cookies.split(';')) {
    const [key, ...rest] = chunk.trim().split('=');
    if (!key) continue;
    cookieMap[key] = decodeURIComponent(rest.join('='));
  }
  return cookieMap;
}

// Junta os tokens candidatos desta requisicao. Se vier um header
// Authorization (usado pelas chamadas fetch das proprias paginas, que
// sempre mandam o token certo a partir do seu localStorage), ele e o
// unico candidato — nao ha ambiguidade. Senao, junta os cookies de
// sessao presentes (pode ser mais de um ao mesmo tempo).
function extractTokenCandidates(req) {
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    return [authHeader.slice(7)];
  }

  const cookieMap = parseCookies(req);
  return Object.values(ROLE_COOKIE_NAMES)
    .map((cookieName) => cookieMap[cookieName])
    .filter(Boolean);
}

// Verifica os candidatos e devolve o primeiro payload valido cujo "role"
// esteja entre os permitidos para quem esta chamando. allowedRoles pode
// ser uma string ('DOCTOR') ou uma lista (['DOCTOR', 'RECEPTIONIST']).
function verifyToken(req, allowedRoles) {
  const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
  const candidates = extractTokenCandidates(req);

  for (const token of candidates) {
    try {
      const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
      if (roles.includes(payload.role)) {
        return payload;
      }
    } catch (_error) {
      // token invalido/expirado/de outro navegador — tenta o proximo candidato
    }
  }

  return null;
}

function requireDoctor(req, res, next) {
  const payload = verifyToken(req, 'DOCTOR');
  if (!payload) {
    return res.status(401).json({ error: 'Acesso restrito ao medico' });
  }

  req.doctor = {
    ...payload,
    clinicId: req.doctor?.clinicId || payload.clinicId || null,
  };
  return next();
}

async function resolveReceptionistClinicId(receptionistId, preferredClinicId) {
  if (preferredClinicId) {
    const found = await query(
      `SELECT c.id
         FROM clinics c
         JOIN clinic_members cm ON cm.clinic_id = c.id
        WHERE c.id = $1
          AND cm.member_id = $2
          AND cm.member_type = 'receptionist'
          AND cm.active = true
          AND c.active = true
        LIMIT 1`,
      [preferredClinicId, receptionistId]
    );
    if (found.rowCount > 0) return preferredClinicId;
  }

  const member = await query(
    `SELECT cm.clinic_id
       FROM clinic_members cm
       JOIN clinics c ON c.id = cm.clinic_id
      WHERE cm.member_id = $1
        AND cm.member_type = 'receptionist'
        AND cm.active = true
        AND c.active = true
      ORDER BY cm.joined_at ASC
      LIMIT 1`,
    [receptionistId]
  );
  return member.rows[0]?.clinic_id || null;
}

async function requireReceptionist(req, res, next) {
  const payload = verifyToken(req, 'RECEPTIONIST');
  if (!payload) {
    return res.status(401).json({ error: 'Acesso restrito a recepcionista' });
  }

  try {
    const clinicId = await resolveReceptionistClinicId(payload.id, payload.clinicId);
    if (!clinicId) {
      return res.status(403).json({ error: 'Recepcionista sem clinica vinculada ativa.' });
    }
    req.receptionist = {
      ...payload,
      clinicId,
    };
    return next();
  } catch (_error) {
    return res.status(403).json({ error: 'Recepcionista sem clinica vinculada ativa.' });
  }
}

async function requireDoctorOrReceptionist(req, res, next) {
  const payload = verifyToken(req, ['DOCTOR', 'RECEPTIONIST']);
  if (!payload) {
    return res.status(401).json({ error: 'Acesso restrito a equipe da clinica' });
  }

  try {
    if (payload.role === 'DOCTOR') {
      const clinicId = await resolveDoctorClinicId(payload.id, payload.clinicId);
      req.user = { ...payload, clinicId };
      req.doctor = req.user;
      return next();
    }

    const clinicId = await resolveReceptionistClinicId(payload.id, payload.clinicId);
    if (!clinicId) {
      return res.status(403).json({ error: 'Recepcionista sem clinica vinculada ativa.' });
    }
    req.user = { ...payload, clinicId };
    req.receptionist = req.user;
    return next();
  } catch (err) {
    console.error('[auth] Erro ao resolver clinica em requireDoctorOrReceptionist:', err.message);
    return res.status(503).json({ error: 'Servico temporariamente indisponivel. Tente novamente em instantes.' });
  }
}

function requirePatient(req, res, next) {
  const payload = verifyToken(req, 'PATIENT');
  if (!payload) {
    return res.status(401).json({ error: 'Acesso restrito ao paciente' });
  }

  req.patient = payload;
  return next();
}

function requirePatientPagePermission(req, res, next) {
  const payload = verifyToken(req, 'PATIENT');
  if (!payload) {
    return res.redirect('/paciente/login');
  }

  req.patient = payload;
  return next();
}

async function resolveDoctorClinicId(doctorId, preferredClinicId) {
  if (preferredClinicId) {
    const found = await query(
      `SELECT id FROM clinics WHERE id = $1 AND active = true LIMIT 1`,
      [preferredClinicId]
    );
    if (found.rowCount > 0) return preferredClinicId;
  }

  const owned = await query(
    `SELECT id FROM clinics WHERE created_by = $1 AND active = true ORDER BY created_at ASC LIMIT 1`,
    [doctorId]
  );
  if (owned.rowCount > 0) return owned.rows[0].id;

  const member = await query(
    `SELECT cm.clinic_id
       FROM clinic_members cm
       JOIN clinics c ON c.id = cm.clinic_id
      WHERE cm.member_id = $1
        AND cm.member_type = 'doctor'
        AND cm.active = true
        AND c.active = true
      ORDER BY cm.joined_at ASC
      LIMIT 1`,
    [doctorId]
  );
  return member.rows[0]?.clinic_id || null;
}

function permissionActionByMethod(method) {
  if (method === 'POST') return 'create';
  if (method === 'PUT' || method === 'PATCH') return 'update';
  if (method === 'DELETE') return 'delete';
  return 'view';
}

async function getDoctorPermission(doctorId, clinicId, pageCode) {
  if (!clinicId) return { can_view: false, can_create: false, can_update: false, can_delete: false, isOwner: false };

  const owner = await query(
    `SELECT id FROM clinics WHERE id = $1 AND created_by = $2 AND active = true LIMIT 1`,
    [clinicId, doctorId]
  );
  if (owner.rowCount > 0) {
    return { can_view: true, can_create: true, can_update: true, can_delete: true, isOwner: true };
  }

  const member = await query(
    `SELECT id FROM clinic_members
      WHERE clinic_id = $1 AND member_id = $2 AND member_type = 'doctor' AND active = true
      LIMIT 1`,
    [clinicId, doctorId]
  );
  if (member.rowCount === 0) {
    return { can_view: false, can_create: false, can_update: false, can_delete: false, isOwner: false };
  }

  const perm = await query(
    `SELECT can_view, can_create, can_update, can_delete
       FROM clinic_member_permissions
      WHERE clinic_member_id = $1 AND page_code = $2
      LIMIT 1`,
    [member.rows[0].id, pageCode]
  );

  if (perm.rowCount === 0) {
    const defaults = await query(
      `SELECT default_can_view AS can_view,
              default_can_create AS can_create,
              default_can_update AS can_update,
              default_can_delete AS can_delete
         FROM app_pages
        WHERE code = $1 AND active = true
        LIMIT 1`,
      [pageCode]
    );
    if (defaults.rowCount > 0) {
      return { ...defaults.rows[0], isOwner: false };
    }
    return { can_view: false, can_create: false, can_update: false, can_delete: false, isOwner: false };
  }
  return { ...perm.rows[0], isOwner: false };
}

function requireDoctorPagePermission(pageCode) {
  return async (req, res, next) => {
    const payload = verifyToken(req, 'DOCTOR');
    if (!payload) {
      return res.redirect('/medico/login');
    }
    req.doctor = payload;
    try {
      const clinicId = await resolveDoctorClinicId(payload.id, payload.clinicId);
      const perm = await getDoctorPermission(payload.id, clinicId, pageCode);
      if (!perm.can_view) {
        return res.redirect('/medico?forbidden=1');
      }
      req.doctor.clinicId = clinicId;
      return next();
    } catch (_err) {
      return res.redirect('/medico?forbidden=1');
    }
  };
}

function requireReceptionistPagePermission(pageCode) {
  return async (req, res, next) => {
    const payload = verifyToken(req, 'RECEPTIONIST');
    if (!payload) {
      return res.redirect('/recepcao/login');
    }
    req.receptionist = payload;
    try {
      const clinicId = await resolveReceptionistClinicId(payload.id, payload.clinicId);
      const perm = await getReceptionistPermission(payload.id, clinicId, pageCode);
      if (!perm.can_view) {
        return res.redirect('/recepcao?forbidden=1');
      }
      req.receptionist.clinicId = clinicId;
      return next();
    } catch (_err) {
      return res.redirect('/recepcao?forbidden=1');
    }
  };
}

function requireDoctorApiPermission(pageCode) {
  return async (req, res, next) => {
    const payload = verifyToken(req, 'DOCTOR');
    if (!payload) {
      return res.status(401).json({ error: 'Acesso restrito ao medico' });
    }
    req.doctor = payload;
    try {
      const clinicId = await resolveDoctorClinicId(payload.id, payload.clinicId);
      const perm = await getDoctorPermission(payload.id, clinicId, pageCode);
      const action = permissionActionByMethod(req.method);
      const allowed =
        (action === 'view' && perm.can_view) ||
        (action === 'create' && perm.can_create) ||
        (action === 'update' && perm.can_update) ||
        (action === 'delete' && perm.can_delete);

      if (!allowed) {
        return res.status(403).json({ error: `Sem permissao para ${action} em ${pageCode}.` });
      }

      req.doctor.clinicId = clinicId;
      return next();
    } catch (err) {
      return res.status(403).json({ error: 'Permissao nao concedida.' });
    }
  };
}

async function getReceptionistPermission(receptionistId, clinicId, pageCode) {
  if (!clinicId) return { can_view: false, can_create: false, can_update: false, can_delete: false, isOwner: false };

  const member = await query(
    `SELECT id FROM clinic_members
      WHERE clinic_id = $1 AND member_id = $2 AND member_type = 'receptionist' AND active = true
      LIMIT 1`,
    [clinicId, receptionistId]
  );
  if (member.rowCount === 0) {
    return { can_view: false, can_create: false, can_update: false, can_delete: false, isOwner: false };
  }

  const perm = await query(
    `SELECT can_view, can_create, can_update, can_delete
       FROM clinic_member_permissions
      WHERE clinic_member_id = $1 AND page_code = $2
      LIMIT 1`,
    [member.rows[0].id, pageCode]
  );

  if (perm.rowCount === 0) {
    const defaults = await query(
      `SELECT default_can_view AS can_view,
              default_can_create AS can_create,
              default_can_update AS can_update,
              default_can_delete AS can_delete
         FROM app_pages
        WHERE code = $1 AND active = true AND (member_type = 'receptionist' OR member_type = 'both')
        LIMIT 1`,
      [pageCode]
    );
    if (defaults.rowCount > 0) {
      return { ...defaults.rows[0], isOwner: false };
    }
    return { can_view: false, can_create: false, can_update: false, can_delete: false, isOwner: false };
  }
  return { ...perm.rows[0], isOwner: false };
}

// Verifica permissao de pagina para um usuario resolvido por requireDoctorOrReceptionist
// (req.user com { role: 'DOCTOR' | 'RECEPTIONIST', id, clinicId }).
async function getStaffPermission(user, pageCode) {
  if (!user) return { can_view: false, can_create: false, can_update: false, can_delete: false, isOwner: false };
  if (user.role === 'DOCTOR') return getDoctorPermission(user.id, user.clinicId, pageCode);
  return getReceptionistPermission(user.id, user.clinicId, pageCode);
}

// Chamar no momento do login, depois de emitir o cookie do perfil atual.
// O front tenta "limpar" os cookies dos outros perfis via document.cookie,
// mas isso nao tem efeito nenhum sobre cookie httpOnly — so o servidor
// consegue apagar de verdade, com Set-Cookie. Isso evita que um cookie
// antigo de outro perfil fique acumulado no navegador (a checagem por
// role em verifyToken ja evita o bug mesmo sem isto, mas manter so um
// cookie de sessao por vez facilita suporte/depuracao).
function clearOtherRoleCookies(res, currentRole) {
  Object.entries(ROLE_COOKIE_NAMES).forEach(([role, cookieName]) => {
    if (role !== currentRole) {
      res.clearCookie(cookieName, { path: '/' });
    }
  });
}

module.exports = {
  requireDoctor,
  requireReceptionist,
  requireDoctorOrReceptionist,
  requirePatient,
  requirePatientPagePermission,
  requireDoctorPagePermission,
  requireReceptionistPagePermission,
  requireDoctorApiPermission,
  clearOtherRoleCookies,
  getDoctorPermission,
  getReceptionistPermission,
  getStaffPermission,
  permissionActionByMethod,
};
