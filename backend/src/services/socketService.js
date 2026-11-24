/**
 * socketService.js — singleton para Socket.IO
 * Usado pelos routes para emitir eventos em tempo real para clientes conectados.
 */

let _io = null;

function doctorRoom(doctorId, clinicId) {
  return clinicId ? `clinic:${clinicId}:doctor:${doctorId}` : `doctor:${doctorId}`;
}

function patientRoom(patientId, clinicId) {
  return clinicId ? `clinic:${clinicId}:patient:${patientId}` : `patient:${patientId}`;
}

function clinicRoom(clinicId) {
  return `clinic:${clinicId}`;
}

function init(io) {
  _io = io;
  io.on('connection', (socket) => {
    console.log('[WS] Cliente conectado:', socket.id);
    // Rooms por clinica para isolamento SaaS total.
    socket.on('join_doctor', (payload) => {
      const doctorId = typeof payload === 'string' ? payload : payload?.doctorId;
      const clinicId = typeof payload === 'string' ? null : payload?.clinicId;
      if (doctorId) socket.join(doctorRoom(doctorId, clinicId));
    });
    socket.on('join_patient', (payload) => {
      const patientId = typeof payload === 'string' ? payload : payload?.patientId;
      const clinicId = typeof payload === 'string' ? null : payload?.clinicId;
      if (patientId) socket.join(patientRoom(patientId, clinicId));
    });
    socket.on('join_clinic', (clinicId) => {
      if (clinicId) socket.join(clinicRoom(clinicId));
    });
    socket.on('disconnect', () => {
      console.log('[WS] Cliente desconectado:', socket.id);
    });
  });
}

/**
 * Emite evento para todos os clientes de um médico específico.
 * @param {string} doctorId - UUID do médico
 * @param {string} event    - nome do evento
 * @param {object} data     - payload do evento
 */
function emitToDoctor(doctorId, event, data, clinicId) {
  if (!_io) return;
  const scopedClinicId = clinicId || data?.clinicId || null;
  _io.to(doctorRoom(doctorId, scopedClinicId)).emit(event, data);
}

/**
 * Emite evento para TODOS os clientes conectados (broadcast global).
 * Usar apenas para eventos administrativos/não sensíveis.
 */
function emitAll(event, data) {
  if (!_io) return;
  _io.emit(event, data);
}

function emitToPatient(patientId, event, data, clinicId) {
  if (!_io) return;
  const scopedClinicId = clinicId || data?.clinicId || null;
  _io.to(patientRoom(patientId, scopedClinicId)).emit(event, data);
}

function emitToClinic(clinicId, event, data) {
  if (!_io || !clinicId) return;
  _io.to(clinicRoom(clinicId)).emit(event, data);
}

module.exports = { init, emitToDoctor, emitToPatient, emitToClinic, emitAll };
