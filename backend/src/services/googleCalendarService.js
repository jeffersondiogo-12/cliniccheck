const { google } = require('googleapis');
const { query } = require('../config/database');

const CLIENT_ID = process.env.GOOGLE_CALENDAR_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_CALENDAR_REDIRECT_URI;
const ENABLED = process.env.GOOGLE_CALENDAR_ENABLED === 'true';
const columnCache = new Map();

async function hasDoctorColumn(columnName) {
  if (columnCache.has(columnName)) return columnCache.get(columnName);

  const found = await query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'doctors' AND column_name = $1
     LIMIT 1`,
    [columnName]
  );
  const exists = found.rowCount > 0;
  columnCache.set(columnName, exists);
  return exists;
}

async function hasPatientColumn(columnName) {
  if (columnCache.has(`patients.${columnName}`)) return columnCache.get(`patients.${columnName}`);

  const found = await query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'patients' AND column_name = $1
     LIMIT 1`,
    [columnName]
  );
  const exists = found.rowCount > 0;
  columnCache.set(`patients.${columnName}`, exists);
  return exists;
}

async function ensureGoogleCalendarSchema() {
  const [hasRefreshToken, hasConnectedFlag] = await Promise.all([
    hasDoctorColumn('google_refresh_token'),
    hasDoctorColumn('google_calendar_connected'),
  ]);

  if (!hasRefreshToken || !hasConnectedFlag) {
    const error = new Error('Colunas do Google Calendar ausentes na tabela doctors. Execute a migration de schema.');
    error.code = 'GCAL_SCHEMA_MISSING';
    throw error;
  }
}

async function ensureGoogleCalendarPatientSchema() {
  const [hasRefreshToken, hasConnectedFlag] = await Promise.all([
    hasPatientColumn('google_refresh_token'),
    hasPatientColumn('google_calendar_connected'),
  ]);

  if (!hasRefreshToken || !hasConnectedFlag) {
    const error = new Error('Colunas do Google Calendar ausentes na tabela patients. Execute a migration de schema.');
    error.code = 'GCAL_PATIENT_SCHEMA_MISSING';
    throw error;
  }
}

function getConfigStatus() {
  const missing = [];
  if (!ENABLED) missing.push('GOOGLE_CALENDAR_ENABLED=true');
  if (!CLIENT_ID) missing.push('GOOGLE_CALENDAR_CLIENT_ID');
  if (!CLIENT_SECRET) missing.push('GOOGLE_CALENDAR_CLIENT_SECRET');
  if (!REDIRECT_URI) missing.push('GOOGLE_CALENDAR_REDIRECT_URI');
  return {
    enabled: ENABLED,
    missing,
    ok: missing.length === 0,
  };
}

function createOAuth2Client() {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
}

function getAuthUrl(stateValue) {
  const oauth2Client = createOAuth2Client();
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar.events'],
    state: String(stateValue || ''),
  });
}

async function exchangeCodeForTokens(code) {
  const oauth2Client = createOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);
  return tokens;
}

async function saveDoctorTokens(doctorId, tokens) {
  await ensureGoogleCalendarSchema();
  await query(
    `UPDATE doctors
     SET google_refresh_token = $1,
         google_calendar_connected = true
     WHERE id = $2`,
    [tokens.refresh_token || null, doctorId]
  );
}

async function getDoctorTokens(doctorId) {
  await ensureGoogleCalendarSchema();
  const result = await query(
    'SELECT google_refresh_token, google_calendar_connected FROM doctors WHERE id = $1',
    [doctorId]
  );
  return result.rows[0] || null;
}

async function savePatientTokens(patientId, tokens) {
  await ensureGoogleCalendarPatientSchema();
  await query(
    `UPDATE patients
     SET google_refresh_token = $1,
         google_calendar_connected = true
     WHERE id = $2`,
    [tokens.refresh_token || null, patientId]
  );
}

async function getPatientTokens(patientId) {
  await ensureGoogleCalendarPatientSchema();
  const result = await query(
    'SELECT google_refresh_token, google_calendar_connected FROM patients WHERE id = $1',
    [patientId]
  );
  return result.rows[0] || null;
}

async function disconnectDoctor(doctorId) {
  await ensureGoogleCalendarSchema();
  await query(
    `UPDATE doctors SET google_refresh_token = NULL, google_calendar_connected = false WHERE id = $1`,
    [doctorId]
  );
}

async function disconnectPatient(patientId) {
  await ensureGoogleCalendarPatientSchema();
  await query(
    `UPDATE patients SET google_refresh_token = NULL, google_calendar_connected = false WHERE id = $1`,
    [patientId]
  );
}

async function createCalendarEvent({ doctorId, patientName, patientEmail, doctorName, summary, notes, consultationAt, durationMin = 30, guests = [], reminders = [] }) {
  if (!ENABLED || !CLIENT_ID || !CLIENT_SECRET) return null;

  const doctorRow = await getDoctorTokens(doctorId);
  if (!doctorRow || !doctorRow.google_calendar_connected || !doctorRow.google_refresh_token) return null;

  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({ refresh_token: doctorRow.google_refresh_token });

  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  // Converte o horário para string no fuso de São Paulo (UTC-3).
  // consultationAt pode vir como:
  //   - "2026-05-01T11:00" (datetime-local, horário local SP, sem fuso)
  //   - "2026-05-01T14:00:00.000Z" (UTC do banco, equivale a 11:00 SP)
  //   - Date object (pg driver retorna UTC)
  const SAO_PAULO_OFFSET_MS = -3 * 60 * 60 * 1000;
  const pad = (n) => String(n).padStart(2, '0');

  function toSaoPauloDateTimeString(input) {
    if (input instanceof Date) {
      // Date object vindo do pg: UTC → SP
      const sp = new Date(input.getTime() + SAO_PAULO_OFFSET_MS);
      return `${sp.getUTCFullYear()}-${pad(sp.getUTCMonth() + 1)}-${pad(sp.getUTCDate())}T${pad(sp.getUTCHours())}:${pad(sp.getUTCMinutes())}:${pad(sp.getUTCSeconds())}-03:00`;
    }
    const str = String(input).trim();
    // Já tem offset ou Z → converter para SP
    if (/[+-]\d{2}:\d{2}$/.test(str) || str.endsWith('Z')) {
      const d = new Date(str);
      const sp = new Date(d.getTime() + SAO_PAULO_OFFSET_MS);
      return `${sp.getUTCFullYear()}-${pad(sp.getUTCMonth() + 1)}-${pad(sp.getUTCDate())}T${pad(sp.getUTCHours())}:${pad(sp.getUTCMinutes())}:${pad(sp.getUTCSeconds())}-03:00`;
    }
    // Sem fuso (datetime-local) → já é horário SP, só adicionar offset
    const base = str.slice(0, 16); // "2026-05-01T11:00"
    return `${base}:00-03:00`;
  }

  const startStr = toSaoPauloDateTimeString(consultationAt);
  // Calcular fim a partir do startStr (que tem offset correto)
  const startDate = new Date(startStr);
  const endDate = new Date(startDate.getTime() + (durationMin || 30) * 60 * 1000);
  const endStr = toSaoPauloDateTimeString(endDate);

  const attendees = [
    ...(patientEmail ? [{ email: patientEmail, displayName: patientName }] : []),
    ...normalizeGuestList(guests),
  ];

  const reminderOverrides = normalizeReminders(reminders);

  const event = {
    summary: `Consulta — ${patientName}`,
    description: `Médico: ${doctorName}\nResumo: ${summary || ''}${notes ? `\nObservações: ${notes}` : ''}`,
    start: { dateTime: startStr, timeZone: 'America/Sao_Paulo' },
    end: { dateTime: endStr, timeZone: 'America/Sao_Paulo' },
    attendees,
    reminders: {
      useDefault: reminderOverrides.length === 0,
      overrides: reminderOverrides,
    },
    guestsCanSeeOtherGuests: false,
  };

  try {
    const resp = await calendar.events.insert({
      calendarId: 'primary',
      resource: event,
      sendUpdates: 'all',
    });
    return resp.data.id;
  } catch (err) {
    console.error('[Google Calendar] Falha ao criar evento:', err.message);
    return null;
  }
}

async function deleteCalendarEvent({ doctorId, eventId }) {
  if (!ENABLED || !CLIENT_ID || !CLIENT_SECRET || !eventId) return;

  const doctorRow = await getDoctorTokens(doctorId);
  if (!doctorRow || !doctorRow.google_refresh_token) return;

  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({ refresh_token: doctorRow.google_refresh_token });

  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  try {
    await calendar.events.delete({ calendarId: 'primary', eventId });
  } catch (err) {
    console.error('[Google Calendar] Falha ao excluir evento:', err.message);
  }
}

function normalizeGuestList(guests) {
  const list = Array.isArray(guests) ? guests : [];
  return [...new Set(list
    .map((v) => String(v || '').trim().toLowerCase())
    .filter((email) => /.+@.+\..+/.test(email)))]
    .map((email) => ({ email }));
}

function normalizeReminders(reminders) {
  const list = Array.isArray(reminders) ? reminders : [];
  const minutesList = [...new Set(list
    .map((v) => Number(v?.minutes ?? v))
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 10080)
    .map((n) => Math.round(n)))];
  return minutesList.map((minutes) => ({ method: 'popup', minutes }));
}

async function updateCalendarEvent({ doctorId, eventId, patientName, patientEmail, doctorName, summary, notes, consultationAt, durationMin = 30, guests = [], reminders = [] }) {
  if (!ENABLED || !CLIENT_ID || !CLIENT_SECRET || !eventId) return null;

  const doctorRow = await getDoctorTokens(doctorId);
  if (!doctorRow || !doctorRow.google_calendar_connected || !doctorRow.google_refresh_token) return null;

  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({ refresh_token: doctorRow.google_refresh_token });
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  const SAO_PAULO_OFFSET_MS = -3 * 60 * 60 * 1000;
  const pad = (n) => String(n).padStart(2, '0');

  function toSaoPauloDateTimeString(input) {
    if (input instanceof Date) {
      const sp = new Date(input.getTime() + SAO_PAULO_OFFSET_MS);
      return `${sp.getUTCFullYear()}-${pad(sp.getUTCMonth() + 1)}-${pad(sp.getUTCDate())}T${pad(sp.getUTCHours())}:${pad(sp.getUTCMinutes())}:${pad(sp.getUTCSeconds())}-03:00`;
    }
    const str = String(input).trim();
    if (/[+-]\d{2}:\d{2}$/.test(str) || str.endsWith('Z')) {
      const d = new Date(str);
      const sp = new Date(d.getTime() + SAO_PAULO_OFFSET_MS);
      return `${sp.getUTCFullYear()}-${pad(sp.getUTCMonth() + 1)}-${pad(sp.getUTCDate())}T${pad(sp.getUTCHours())}:${pad(sp.getUTCMinutes())}:${pad(sp.getUTCSeconds())}-03:00`;
    }
    const base = str.slice(0, 16);
    return `${base}:00-03:00`;
  }

  const startStr = toSaoPauloDateTimeString(consultationAt);
  const startDate = new Date(startStr);
  const endDate = new Date(startDate.getTime() + (durationMin || 30) * 60 * 1000);
  const endStr = toSaoPauloDateTimeString(endDate);

  const attendees = [
    ...(patientEmail ? [{ email: patientEmail, displayName: patientName }] : []),
    ...normalizeGuestList(guests),
  ];
  const reminderOverrides = normalizeReminders(reminders);

  const resource = {
    summary: `Consulta — ${patientName}`,
    description: `Médico: ${doctorName}\nResumo: ${summary || ''}${notes ? `\nObservações: ${notes}` : ''}`,
    start: { dateTime: startStr, timeZone: 'America/Sao_Paulo' },
    end: { dateTime: endStr, timeZone: 'America/Sao_Paulo' },
    attendees,
    reminders: {
      useDefault: reminderOverrides.length === 0,
      overrides: reminderOverrides,
    },
    guestsCanSeeOtherGuests: false,
  };

  try {
    await calendar.events.update({
      calendarId: 'primary',
      eventId,
      resource,
      sendUpdates: 'all',
    });
    return eventId;
  } catch (err) {
    console.error('[Google Calendar] Falha ao atualizar evento:', err.message);
    return null;
  }
}

// Lista os períodos ocupados (início/fim) da agenda do médico num intervalo
// de datas — usado pra calcular horários livres no Portfólio público. Usa
// events.list (não freebusy.query) porque já funciona com o escopo
// 'calendar.events' que os médicos já autorizaram, sem precisar pedir
// permissão de novo.
async function getBusyPeriods({ doctorId, fromISO, toISO }) {
  if (!ENABLED || !CLIENT_ID || !CLIENT_SECRET) return [];

  const doctorRow = await getDoctorTokens(doctorId);
  if (!doctorRow || !doctorRow.google_calendar_connected || !doctorRow.google_refresh_token) return [];

  const oauth2Client = createOAuth2Client();
  oauth2Client.setCredentials({ refresh_token: doctorRow.google_refresh_token });
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  try {
    const resp = await calendar.events.list({
      calendarId: 'primary',
      timeMin: fromISO,
      timeMax: toISO,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250,
      fields: 'items(start,end,transparency,status)',
    });
    return (resp.data.items || [])
      .filter((ev) => ev.status !== 'cancelled' && ev.transparency !== 'transparent')
      .map((ev) => ({
        start: ev.start?.dateTime || (ev.start?.date ? `${ev.start.date}T00:00:00` : null),
        end: ev.end?.dateTime || (ev.end?.date ? `${ev.end.date}T23:59:59` : null),
      }))
      .filter((p) => p.start && p.end);
  } catch (err) {
    console.error('[Google Calendar] Falha ao listar eventos (busy):', err.message);
    return [];
  }
}

module.exports = {
  isEnabled: () => getConfigStatus().ok,
  getConfigStatus,
  getAuthUrl,
  exchangeCodeForTokens,
  saveDoctorTokens,
  getDoctorTokens,
  savePatientTokens,
  getPatientTokens,
  disconnectDoctor,
  disconnectPatient,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  getBusyPeriods,
};
