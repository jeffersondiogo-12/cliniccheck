const express = require('express');
const { query } = require('../config/database');
const { requireDoctor } = require('../middleware/auth');
const googleCalendarService = require('../services/googleCalendarService');
const socketService = require('../services/socketService');

const router = express.Router();

const MAX_PHOTO_SIZE = 4.2 * 1024 * 1024; // ~3MB de imagem em base64
const SAO_PAULO_OFFSET_MIN = -3 * 60;

function slugify(text) {
  return String(text || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'medico';
}

async function generateUniqueSlug(baseName, doctorId) {
  const base = slugify(baseName);
  let candidate = base;
  let suffix = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const existing = await query(
      `SELECT id FROM doctor_portfolios WHERE slug = $1 AND doctor_id <> $2 LIMIT 1`,
      [candidate, doctorId]
    );
    if (existing.rowCount === 0) return candidate;
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
}

function validatePhoto(photoUrl) {
  if (!photoUrl) return true;
  if (typeof photoUrl !== 'string' || !photoUrl.startsWith('data:image/')) return false;
  return photoUrl.length <= MAX_PHOTO_SIZE;
}

// Garante que o médico logado já tem uma linha em doctor_portfolios,
// criando com valores padrão (e slug único a partir do nome) na primeira vez.
async function ensurePortfolio(doctorId, doctorName) {
  const existing = await query(`SELECT * FROM doctor_portfolios WHERE doctor_id = $1`, [doctorId]);
  if (existing.rowCount > 0) return existing.rows[0];

  const slug = await generateUniqueSlug(doctorName, doctorId);
  const inserted = await query(
    `INSERT INTO doctor_portfolios (doctor_id, slug) VALUES ($1, $2) RETURNING *`,
    [doctorId, slug]
  );
  const portfolio = inserted.rows[0];

  // Semeia as 4 seções sugeridas (o próprio médico edita/remove depois).
  const seedSections = [
    {
      type: 'TEXT',
      title: 'Quem sou eu',
      content: 'Fale sobre a sua formação (faculdade) e seus estudos, quanto tempo de experiência você tem, e o seu jeito de trabalhar — o que você mais gosta de fazer.',
      image_position: 'right',
    },
    {
      type: 'TEXT',
      title: 'O que eu faço',
      content: 'Explique aqui os seus serviços — atendimento no consultório, consultas online, procedimentos que você realiza.',
      image_position: 'left',
    },
    {
      type: 'TEXT',
      title: 'Como funciona a consulta',
      content: 'Conte pra quem está vendo o que ela vai encontrar: quanto tempo dura o atendimento, se é online ou presencial, e como marcar um horário.',
      image_position: 'none',
    },
    {
      type: 'TESTIMONIALS',
      title: 'Depoimentos',
      content: JSON.stringify([
        { name: 'Nome do paciente', text: 'Escreva aqui um depoimento curto de alguém que já passou pela sua consulta e ficou satisfeito.' },
      ]),
      image_position: 'none',
    },
  ];
  for (let i = 0; i < seedSections.length; i += 1) {
    const s = seedSections[i];
    await query(
      `INSERT INTO doctor_portfolio_sections (portfolio_id, type, title, content, image_position, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [portfolio.id, s.type, s.title, s.content, s.image_position, i]
    );
  }

  return portfolio;
}

// ═══════════════════════════════════════════════════════════════
// PORTFÓLIO — configurações gerais (área logada do médico)
// ═══════════════════════════════════════════════════════════════
router.get('/me', requireDoctor, async (req, res, next) => {
  try {
    const portfolio = await ensurePortfolio(req.doctor.id, req.doctor.name);
    return res.json(portfolio);
  } catch (err) {
    return next(err);
  }
});

router.put('/me', requireDoctor, async (req, res, next) => {
  try {
    const portfolio = await ensurePortfolio(req.doctor.id, req.doctor.name);
    const {
      slug, published, headline, whatsappNumber, whatsappMessageTemplate,
      themePrimaryColor, themeAccentColor, themeFont, themeLayout, themeNavStyle,
      coverPhotoUrl, logoUrl,
      showAgenda, agendaSlotMinutes, agendaDaysAhead,
      agendaWorkingHoursStart, agendaWorkingHoursEnd, agendaWorkingDays,
    } = req.body;

    // DEBUG: Log the incoming request data
    console.log('[Portfolio PUT] Doctor:', req.doctor.id, '| Published value:', published, '| Type:', typeof published);
    console.log('[Portfolio PUT] Full payload:', { slug, published, headline });

    if (coverPhotoUrl !== undefined && !validatePhoto(coverPhotoUrl)) {
      return res.status(400).json({ error: 'Foto de capa inválida ou muito grande (máx. ~3MB).' });
    }
    if (logoUrl !== undefined && !validatePhoto(logoUrl)) {
      return res.status(400).json({ error: 'Logo inválida ou muito grande (máx. ~3MB).' });
    }

    let finalSlug = portfolio.slug;
    // Só tenta atualizar slug se ele for fornecido e não-vazio
    if (slug !== undefined && slug !== null && slug.trim() !== '') {
      const desired = slugify(slug);
      if (!desired) return res.status(400).json({ error: 'Endereço (slug) inválido.' });
      // Só atualiza se for diferente do atual
      if (desired !== portfolio.slug) {
        const taken = await query(`SELECT id FROM doctor_portfolios WHERE slug = $1 AND doctor_id <> $2 LIMIT 1`, [desired, req.doctor.id]);
        if (taken.rowCount > 0) return res.status(409).json({ error: 'Esse endereço já está em uso por outro médico. Escolha outro.' });
        finalSlug = desired;
      }
    }

    const updated = await query(
      `UPDATE doctor_portfolios SET
         slug = $1,
         published = COALESCE($2, published),
         headline = COALESCE($3, headline),
         whatsapp_number = COALESCE($4, whatsapp_number),
         whatsapp_message_template = COALESCE($5, whatsapp_message_template),
         theme_primary_color = COALESCE($6, theme_primary_color),
         theme_accent_color = COALESCE($7, theme_accent_color),
         theme_font = COALESCE($8, theme_font),
         theme_layout = COALESCE($9, theme_layout),
         theme_nav_style = COALESCE($10, theme_nav_style),
         cover_photo_url = COALESCE($11, cover_photo_url),
         logo_url = COALESCE($12, logo_url),
         show_agenda = COALESCE($13, show_agenda),
         agenda_slot_minutes = COALESCE($14, agenda_slot_minutes),
         agenda_days_ahead = COALESCE($15, agenda_days_ahead),
         agenda_working_hours_start = COALESCE($16, agenda_working_hours_start),
         agenda_working_hours_end = COALESCE($17, agenda_working_hours_end),
         agenda_working_days = COALESCE($18, agenda_working_days)
       WHERE doctor_id = $19
       RETURNING *`,
      [
        finalSlug,
        published != null ? Boolean(published) : null,
        headline ?? null,
        whatsappNumber ?? null,
        whatsappMessageTemplate ?? null,
        themePrimaryColor ?? null,
        themeAccentColor ?? null,
        themeFont ?? null,
        themeLayout ?? null,
        themeNavStyle ?? null,
        coverPhotoUrl ?? null,
        logoUrl ?? null,
        showAgenda != null ? Boolean(showAgenda) : null,
        agendaSlotMinutes ? parseInt(agendaSlotMinutes, 10) : null,
        agendaDaysAhead ? parseInt(agendaDaysAhead, 10) : null,
        agendaWorkingHoursStart ?? null,
        agendaWorkingHoursEnd ?? null,
        agendaWorkingDays ?? null,
        req.doctor.id,
      ]
    );
    return res.json(updated.rows[0]);
  } catch (err) {
    return next(err);
  }
});

// ═══════════════════════════════════════════════════════════════
// SEÇÕES DE CONTEÚDO
// ═══════════════════════════════════════════════════════════════
router.get('/me/sections', requireDoctor, async (req, res, next) => {
  try {
    const portfolio = await ensurePortfolio(req.doctor.id, req.doctor.name);
    const result = await query(
      `SELECT * FROM doctor_portfolio_sections WHERE portfolio_id = $1 ORDER BY sort_order ASC, created_at ASC`,
      [portfolio.id]
    );
    return res.json(result.rows);
  } catch (err) {
    return next(err);
  }
});

router.post('/me/sections', requireDoctor, async (req, res, next) => {
  try {
    const portfolio = await ensurePortfolio(req.doctor.id, req.doctor.name);
    const { type, title, content, imagePosition, imageUrl } = req.body;
    if (!['TEXT', 'GALLERY', 'TESTIMONIALS'].includes(type)) {
      return res.status(400).json({ error: 'Tipo de seção inválido.' });
    }
    if (imageUrl !== undefined && !validatePhoto(imageUrl)) {
      return res.status(400).json({ error: 'Imagem inválida ou muito grande (máx. ~3MB).' });
    }
    const maxOrderRes = await query(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM doctor_portfolio_sections WHERE portfolio_id = $1`, [portfolio.id]);
    const nextOrder = Number(maxOrderRes.rows[0].m) + 1;

    const inserted = await query(
      `INSERT INTO doctor_portfolio_sections (portfolio_id, type, title, content, image_position, image_url, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [portfolio.id, type, title || null, content || null, imagePosition || 'right', imageUrl || null, nextOrder]
    );
    return res.status(201).json(inserted.rows[0]);
  } catch (err) {
    return next(err);
  }
});

router.put('/me/sections/reorder', requireDoctor, async (req, res, next) => {
  try {
    const portfolio = await ensurePortfolio(req.doctor.id, req.doctor.name);
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    for (let i = 0; i < ids.length; i += 1) {
      await query(
        `UPDATE doctor_portfolio_sections SET sort_order = $1 WHERE id = $2 AND portfolio_id = $3`,
        [i, ids[i], portfolio.id]
      );
    }
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
});

router.put('/me/sections/:sectionId', requireDoctor, async (req, res, next) => {
  try {
    const portfolio = await ensurePortfolio(req.doctor.id, req.doctor.name);
    const { sectionId } = req.params;
    const { title, content, imagePosition, imageUrl, visible } = req.body;
    if (imageUrl !== undefined && !validatePhoto(imageUrl)) {
      return res.status(400).json({ error: 'Imagem inválida ou muito grande (máx. ~3MB).' });
    }
    const updated = await query(
      `UPDATE doctor_portfolio_sections SET
         title = COALESCE($1, title),
         content = COALESCE($2, content),
         image_position = COALESCE($3, image_position),
         image_url = COALESCE($4, image_url),
         visible = COALESCE($5, visible)
       WHERE id = $6 AND portfolio_id = $7
       RETURNING *`,
      [title ?? null, content ?? null, imagePosition ?? null, imageUrl ?? null, visible != null ? Boolean(visible) : null, sectionId, portfolio.id]
    );
    if (updated.rowCount === 0) return res.status(404).json({ error: 'Seção não encontrada.' });
    return res.json(updated.rows[0]);
  } catch (err) {
    return next(err);
  }
});

router.delete('/me/sections/:sectionId', requireDoctor, async (req, res, next) => {
  try {
    const portfolio = await ensurePortfolio(req.doctor.id, req.doctor.name);
    const { sectionId } = req.params;
    const deleted = await query(
      `DELETE FROM doctor_portfolio_sections WHERE id = $1 AND portfolio_id = $2 RETURNING id`,
      [sectionId, portfolio.id]
    );
    if (deleted.rowCount === 0) return res.status(404).json({ error: 'Seção não encontrada.' });
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
});

// ═══════════════════════════════════════════════════════════════
// GALERIA DE FOTOS
// ═══════════════════════════════════════════════════════════════
router.get('/me/photos', requireDoctor, async (req, res, next) => {
  try {
    const portfolio = await ensurePortfolio(req.doctor.id, req.doctor.name);
    const result = await query(
      `SELECT * FROM doctor_portfolio_photos WHERE portfolio_id = $1 ORDER BY sort_order ASC, created_at ASC`,
      [portfolio.id]
    );
    return res.json(result.rows);
  } catch (err) {
    return next(err);
  }
});

router.post('/me/photos', requireDoctor, async (req, res, next) => {
  try {
    const portfolio = await ensurePortfolio(req.doctor.id, req.doctor.name);
    const { url, caption } = req.body;
    if (!validatePhoto(url) || !url) {
      return res.status(400).json({ error: 'Imagem inválida ou muito grande (máx. ~3MB).' });
    }
    const countRes = await query(`SELECT COUNT(*)::int AS c, COALESCE(MAX(sort_order),-1) AS m FROM doctor_portfolio_photos WHERE portfolio_id = $1`, [portfolio.id]);
    if (countRes.rows[0].c >= 24) {
      return res.status(400).json({ error: 'Limite de 24 fotos na galeria. Remova alguma antes de adicionar outra.' });
    }
    const inserted = await query(
      `INSERT INTO doctor_portfolio_photos (portfolio_id, url, caption, sort_order) VALUES ($1,$2,$3,$4) RETURNING *`,
      [portfolio.id, url, caption || null, Number(countRes.rows[0].m) + 1]
    );
    return res.status(201).json(inserted.rows[0]);
  } catch (err) {
    return next(err);
  }
});

router.put('/me/photos/:photoId', requireDoctor, async (req, res, next) => {
  try {
    const portfolio = await ensurePortfolio(req.doctor.id, req.doctor.name);
    const { caption } = req.body;
    const updated = await query(
      `UPDATE doctor_portfolio_photos SET caption = $1 WHERE id = $2 AND portfolio_id = $3 RETURNING *`,
      [caption ?? null, req.params.photoId, portfolio.id]
    );
    if (updated.rowCount === 0) return res.status(404).json({ error: 'Foto não encontrada.' });
    return res.json(updated.rows[0]);
  } catch (err) {
    return next(err);
  }
});

router.delete('/me/photos/:photoId', requireDoctor, async (req, res, next) => {
  try {
    const portfolio = await ensurePortfolio(req.doctor.id, req.doctor.name);
    const deleted = await query(
      `DELETE FROM doctor_portfolio_photos WHERE id = $1 AND portfolio_id = $2 RETURNING id`,
      [req.params.photoId, portfolio.id]
    );
    if (deleted.rowCount === 0) return res.status(404).json({ error: 'Foto não encontrada.' });
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
});

router.put('/me/photos/reorder', requireDoctor, async (req, res, next) => {
  try {
    const portfolio = await ensurePortfolio(req.doctor.id, req.doctor.name);
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    for (let i = 0; i < ids.length; i += 1) {
      await query(`UPDATE doctor_portfolio_photos SET sort_order = $1 WHERE id = $2 AND portfolio_id = $3`, [i, ids[i], portfolio.id]);
    }
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
});

// ═══════════════════════════════════════════════════════════════
// DISPONIBILIDADE — calculada a partir do Google Calendar já conectado
// ═══════════════════════════════════════════════════════════════
function pad(n) { return String(n).padStart(2, '0'); }

// Constrói um Date a partir de um "instante local de São Paulo"
// (ano/mês/dia/hora/minuto), assumindo UTC-3 fixo (Brasil não observa
// horário de verão desde 2019 — mesma premissa já usada no resto do app).
function spDate(year, month, day, hour, minute) {
  return new Date(Date.UTC(year, month, day, hour - SAO_PAULO_OFFSET_MIN / 60, minute));
}

async function computeAvailability(doctorId, portfolio) {
  const slotMin = portfolio.agenda_slot_minutes || 30;
  const daysAhead = Math.min(portfolio.agenda_days_ahead || 14, 60);
  const workingDays = String(portfolio.agenda_working_days || '1,2,3,4,5').split(',').map((d) => parseInt(d.trim(), 10)).filter((d) => !Number.isNaN(d));
  const [startH, startM] = String(portfolio.agenda_working_hours_start || '09:00').split(':').map((n) => parseInt(n, 10));
  const [endH, endM] = String(portfolio.agenda_working_hours_end || '18:00').split(':').map((n) => parseInt(n, 10));

  const now = new Date();
  // Referência de "hoje" em São Paulo (a partir do UTC atual).
  const spNow = new Date(now.getTime() + SAO_PAULO_OFFSET_MIN * 60 * 1000);
  const todayY = spNow.getUTCFullYear();
  const todayM = spNow.getUTCMonth();
  const todayD = spNow.getUTCDate();

  const fromDate = spDate(todayY, todayM, todayD, 0, 0);
  const toDate = spDate(todayY, todayM, todayD + daysAhead, 23, 59);

  const busyPeriods = portfolio.show_agenda
    ? await googleCalendarService.getBusyPeriods({ doctorId, fromISO: fromDate.toISOString(), toISO: toDate.toISOString() })
    : [];
  const busyRanges = busyPeriods.map((p) => ({ start: new Date(p.start), end: new Date(p.end) }));

  // Horários já pedidos por outro paciente (pendentes ou confirmados) também
  // contam como ocupados — sem isto, dois pacientes podiam escolher o mesmo
  // horário antes do médico dar baixa na solicitação.
  const spFrom = new Date(fromDate.getTime() + SAO_PAULO_OFFSET_MIN * 60 * 1000);
  const spTo = new Date(toDate.getTime() + SAO_PAULO_OFFSET_MIN * 60 * 1000);
  const fromIsoDate = `${spFrom.getUTCFullYear()}-${pad(spFrom.getUTCMonth() + 1)}-${pad(spFrom.getUTCDate())}`;
  const toIsoDate = `${spTo.getUTCFullYear()}-${pad(spTo.getUTCMonth() + 1)}-${pad(spTo.getUTCDate())}`;
  const requestedRows = await query(
    `SELECT requested_date, requested_time
       FROM portfolio_booking_requests
      WHERE doctor_id = $1
        AND status IN ('pending','confirmed')
        AND requested_date >= $2::date
        AND requested_date <= $3::date`,
    [doctorId, fromIsoDate, toIsoDate]
  );
  for (const row of requestedRows.rows) {
    const isoDate = row.requested_date instanceof Date
      ? `${row.requested_date.getUTCFullYear()}-${pad(row.requested_date.getUTCMonth() + 1)}-${pad(row.requested_date.getUTCDate())}`
      : String(row.requested_date).slice(0, 10);
    const [rh, rm] = String(row.requested_time).split(':').map((n) => parseInt(n, 10));
    if (Number.isNaN(rh) || Number.isNaN(rm)) continue;
    const [y, mo, d] = isoDate.split('-').map((n) => parseInt(n, 10));
    const start = spDate(y, mo - 1, d, rh, rm);
    const end = new Date(start.getTime() + slotMin * 60 * 1000);
    busyRanges.push({ start, end });
  }

  const minBookableTime = new Date(now.getTime() + 2 * 60 * 60 * 1000); // pelo menos 2h de antecedência

  const days = [];
  for (let offset = 0; offset < daysAhead; offset += 1) {
    const dayStart = spDate(todayY, todayM, todayD + offset, 0, 0);
    const weekday = dayStart.getUTCDay(); // getUTCDay do "instante SP" representado em UTC ainda reflete o dia certo pois construímos com Date.UTC ajustado
    if (!workingDays.includes(weekday)) continue;

    const slots = [];
    let cursor = spDate(todayY, todayM, todayD + offset, startH, startM || 0);
    const dayEnd = spDate(todayY, todayM, todayD + offset, endH, endM || 0);
    while (cursor < dayEnd) {
      const slotEnd = new Date(cursor.getTime() + slotMin * 60 * 1000);
      const overlapsBusy = busyRanges.some((b) => cursor < b.end && slotEnd > b.start);
      if (!overlapsBusy && cursor >= minBookableTime) {
        const spCursor = new Date(cursor.getTime() + SAO_PAULO_OFFSET_MIN * 60 * 1000);
        slots.push(`${pad(spCursor.getUTCHours())}:${pad(spCursor.getUTCMinutes())}`);
      }
      cursor = slotEnd;
    }

    if (slots.length > 0) {
      const spDay = new Date(dayStart.getTime() + SAO_PAULO_OFFSET_MIN * 60 * 1000);
      const isoDate = `${spDay.getUTCFullYear()}-${pad(spDay.getUTCMonth() + 1)}-${pad(spDay.getUTCDate())}`;
      const dayLabel = new Date(`${isoDate}T12:00:00-03:00`).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' });
      days.push({ date: isoDate, dayLabel, slots });
    }
  }

  return days;
}

router.get('/me/availability', requireDoctor, async (req, res, next) => {
  try {
    const portfolio = await ensurePortfolio(req.doctor.id, req.doctor.name);
    const days = await computeAvailability(req.doctor.id, portfolio);
    return res.json({ days, googleConnected: !!(await googleCalendarService.getDoctorTokens(req.doctor.id))?.google_calendar_connected });
  } catch (err) {
    return next(err);
  }
});

// ═══════════════════════════════════════════════════════════════
// SOLICITAÇÕES DE AGENDAMENTO — fila do que os pacientes marcaram
// pelo portfólio público. Cai direto no Google Calendar do médico
// assim que o paciente reserva — o médico não precisa confirmar nada
// pra o compromisso aparecer na agenda dele.
// ═══════════════════════════════════════════════════════════════

// Tenta criar o evento no Google Calendar do médico e devolve o id do
// evento (ou null se não estiver conectado / a criação falhar). Nunca
// lança erro — quem chama decide o que fazer se vier null.
async function syncBookingRequestToGoogle(doctor, bookingRequest) {
  if (!googleCalendarService.isEnabled()) return null;
  try {
    const isoDate = bookingRequest.requested_date instanceof Date
      ? bookingRequest.requested_date.toISOString().slice(0, 10)
      : String(bookingRequest.requested_date).slice(0, 10);
    const portfolio = await ensurePortfolio(doctor.id, doctor.name);
    return await googleCalendarService.createCalendarEvent({
      doctorId: doctor.id,
      patientName: bookingRequest.patient_name,
      patientEmail: null,
      doctorName: doctor.name,
      summary: `Consulta — ${bookingRequest.patient_name} (via portfólio)`,
      notes: bookingRequest.patient_phone ? `WhatsApp do paciente: ${bookingRequest.patient_phone}` : null,
      consultationAt: `${isoDate}T${bookingRequest.requested_time}`,
      durationMin: portfolio.agenda_slot_minutes || 30,
    });
  } catch (gcalErr) {
    console.error('[Portfolio] Falha ao sincronizar solicitação com Google Calendar:', gcalErr.message);
    return null;
  }
}

router.get('/me/booking-requests', requireDoctor, async (req, res, next) => {
  try {
    const result = await query(
      `SELECT id, patient_name, patient_phone, requested_date, requested_time, status, google_event_id, created_at, decided_at
         FROM portfolio_booking_requests
        WHERE doctor_id = $1
          AND status IN ('pending','confirmed')
        ORDER BY requested_date ASC, requested_time ASC`,
      [req.doctor.id]
    );
    return res.json(result.rows);
  } catch (err) {
    return next(err);
  }
});

// Retry manual — só é necessário se a sincronização automática (feita no
// momento em que o paciente reserva) tiver falhado (ex.: Google Calendar
// fora do ar naquele instante).
router.post('/me/booking-requests/:id/confirm', requireDoctor, async (req, res, next) => {
  try {
    const found = await query(
      `SELECT * FROM portfolio_booking_requests WHERE id = $1 AND doctor_id = $2 LIMIT 1`,
      [req.params.id, req.doctor.id]
    );
    if (found.rowCount === 0) return res.status(404).json({ error: 'Solicitação não encontrada.' });
    const bookingRequest = found.rows[0];
    if (bookingRequest.status === 'cancelled') {
      return res.status(409).json({ error: 'Essa solicitação já foi cancelada.' });
    }

    const googleEventId = await syncBookingRequestToGoogle(req.doctor, bookingRequest);

    const updated = await query(
      `UPDATE portfolio_booking_requests
          SET status = 'confirmed', decided_at = now(), google_event_id = COALESCE($2, google_event_id)
        WHERE id = $1
        RETURNING id, patient_name, patient_phone, requested_date, requested_time, status, google_event_id, created_at, decided_at`,
      [bookingRequest.id, googleEventId]
    );

    socketService.emitToDoctor(req.doctor.id, 'booking_request_updated', { id: bookingRequest.id, status: 'confirmed' });
    return res.json(updated.rows[0]);
  } catch (err) {
    return next(err);
  }
});

router.post('/me/booking-requests/:id/cancel', requireDoctor, async (req, res, next) => {
  try {
    const found = await query(
      `SELECT * FROM portfolio_booking_requests WHERE id = $1 AND doctor_id = $2 LIMIT 1`,
      [req.params.id, req.doctor.id]
    );
    if (found.rowCount === 0) return res.status(404).json({ error: 'Solicitação não encontrada.' });
    const bookingRequest = found.rows[0];
    if (bookingRequest.status === 'cancelled') {
      return res.status(409).json({ error: 'Essa solicitação já estava cancelada.' });
    }

    if (bookingRequest.google_event_id) {
      await googleCalendarService.deleteCalendarEvent({ doctorId: req.doctor.id, eventId: bookingRequest.google_event_id });
    }

    const updated = await query(
      `UPDATE portfolio_booking_requests
          SET status = 'cancelled', decided_at = now()
        WHERE id = $1
        RETURNING id, patient_name, patient_phone, requested_date, requested_time, status, google_event_id, created_at, decided_at`,
      [req.params.id]
    );

    socketService.emitToDoctor(req.doctor.id, 'booking_request_updated', { id: req.params.id, status: 'cancelled' });
    return res.json(updated.rows[0]);
  } catch (err) {
    return next(err);
  }
});

// ═══════════════════════════════════════════════════════════════
// PÚBLICO — sem autenticação, é a página que o paciente vê
// ═══════════════════════════════════════════════════════════════
const publicRouter = express.Router();

publicRouter.get('/:slug', async (req, res, next) => {
  try {
    const { slug } = req.params;
    const portfolioRes = await query(
      `SELECT p.*, d.name AS doctor_name, d.specialty AS doctor_specialty, d.bio AS doctor_bio, d.photo_url AS doctor_photo_url, d.id AS doctor_id
         FROM doctor_portfolios p
         JOIN doctors d ON d.id = p.doctor_id
        WHERE p.slug = $1 AND p.published = true
        LIMIT 1`,
      [slug]
    );
    if (portfolioRes.rowCount === 0) return res.status(404).json({ error: 'Portfólio não encontrado.' });
    const portfolio = portfolioRes.rows[0];

    const sectionsRes = await query(
      `SELECT id, type, title, content, image_position, image_url, sort_order
         FROM doctor_portfolio_sections
        WHERE portfolio_id = $1 AND visible = true
        ORDER BY sort_order ASC`,
      [portfolio.id]
    );
    const photosRes = await query(
      `SELECT id, url, caption FROM doctor_portfolio_photos WHERE portfolio_id = $1 ORDER BY sort_order ASC`,
      [portfolio.id]
    );

    // Nunca expõe tokens/segredos — só o que é necessário pra renderizar a página.
    const { whatsapp_number: whatsappNumber, whatsapp_message_template: whatsappMessageTemplate } = portfolio;
    return res.json({
      doctor: { name: portfolio.doctor_name, specialty: portfolio.doctor_specialty, bio: portfolio.doctor_bio, photoUrl: portfolio.doctor_photo_url },
      headline: portfolio.headline,
      whatsappNumber,
      whatsappMessageTemplate,
      theme: {
        primaryColor: portfolio.theme_primary_color,
        accentColor: portfolio.theme_accent_color,
        font: portfolio.theme_font,
        layout: portfolio.theme_layout,
        navStyle: portfolio.theme_nav_style,
      },
      coverPhotoUrl: portfolio.cover_photo_url,
      logoUrl: portfolio.logo_url,
      showAgenda: portfolio.show_agenda,
      sections: sectionsRes.rows,
      photos: photosRes.rows,
    });
  } catch (err) {
    return next(err);
  }
});

publicRouter.get('/:slug/availability', async (req, res, next) => {
  try {
    const { slug } = req.params;
    const portfolioRes = await query(`SELECT * FROM doctor_portfolios WHERE slug = $1 AND published = true LIMIT 1`, [slug]);
    if (portfolioRes.rowCount === 0) return res.status(404).json({ error: 'Portfólio não encontrado.' });
    const portfolio = portfolioRes.rows[0];
    if (!portfolio.show_agenda) return res.json({ days: [] });
    const days = await computeAvailability(portfolio.doctor_id, portfolio);
    return res.json({ days });
  } catch (err) {
    return next(err);
  }
});

function isValidDateStr(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}
function isValidTimeStr(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''));
}

// Grava a escolha do paciente (dia/horário + nome/WhatsApp) e já tenta criar
// o evento na agenda do Google do médico na hora — sem esperar nenhuma ação
// do médico. O WhatsApp continua sendo obrigatório: isto aqui só evita que
// o agendamento fique só na conversa e nunca chegue na agenda de verdade.
publicRouter.post('/:slug/booking-requests', async (req, res, next) => {
  try {
    const { slug } = req.params;
    const portfolioRes = await query(
      `SELECT p.*, d.name AS doctor_name
         FROM doctor_portfolios p
         JOIN doctors d ON d.id = p.doctor_id
        WHERE p.slug = $1 AND p.published = true
        LIMIT 1`,
      [slug]
    );
    if (portfolioRes.rowCount === 0) return res.status(404).json({ error: 'Portfólio não encontrado.' });
    const portfolio = portfolioRes.rows[0];
    if (!portfolio.show_agenda) return res.status(400).json({ error: 'Agenda não disponível neste portfólio.' });

    const { date, time } = req.body || {};
    const patientName = String(req.body?.patientName || '').trim().slice(0, 120);
    const patientPhoneDigits = String(req.body?.patientPhone || '').replace(/\D/g, '').slice(0, 20);

    if (!isValidDateStr(date) || !isValidTimeStr(time)) {
      return res.status(400).json({ error: 'Data ou horário inválido.' });
    }
    if (patientName.length < 2) {
      return res.status(400).json({ error: 'Informe seu nome para reservar o horário.' });
    }
    if (patientPhoneDigits.length < 10) {
      return res.status(400).json({ error: 'Informe um número de WhatsApp válido (com DDD) para reservar o horário.' });
    }

    // Nunca confia no que veio do navegador do paciente sozinho — recalcula
    // a disponibilidade (fuso, antecedência mínima, Google Calendar e outras
    // solicitações já feitas) e só aceita se o horário ainda está livre.
    const days = await computeAvailability(portfolio.doctor_id, portfolio);
    const day = days.find((d) => d.date === date);
    if (!day || !day.slots.includes(time)) {
      return res.status(409).json({ error: 'Esse horário não está mais disponível. Escolha outro.' });
    }

    let inserted;
    try {
      inserted = await query(
        `INSERT INTO portfolio_booking_requests
           (doctor_id, portfolio_id, patient_name, patient_phone, requested_date, requested_time)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, requested_date, requested_time, status, patient_name, patient_phone`,
        [portfolio.doctor_id, portfolio.id, patientName, patientPhoneDigits, date, time]
      );
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Esse horário acabou de ser reservado por outro paciente. Escolha outro.' });
      }
      throw err;
    }

    let bookingRequest = inserted.rows[0];

    // Cai direto na agenda do Google do médico agora — nenhuma ação do
    // médico é necessária pro compromisso aparecer lá.
    const googleEventId = await syncBookingRequestToGoogle(
      { id: portfolio.doctor_id, name: portfolio.doctor_name },
      bookingRequest
    );
    if (googleEventId) {
      const updated = await query(
        `UPDATE portfolio_booking_requests
            SET status = 'confirmed', decided_at = now(), google_event_id = $2
          WHERE id = $1
          RETURNING id, requested_date, requested_time, status, patient_name, patient_phone`,
        [bookingRequest.id, googleEventId]
      );
      bookingRequest = updated.rows[0];
    }

    socketService.emitToDoctor(portfolio.doctor_id, 'booking_request_created', {
      id: bookingRequest.id,
      patientName,
      date,
      time,
      status: bookingRequest.status,
    });

    return res.status(201).json(bookingRequest);
  } catch (err) {
    return next(err);
  }
});

module.exports = { router, publicRouter };
