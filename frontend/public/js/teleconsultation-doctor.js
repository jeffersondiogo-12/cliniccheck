/* teleconsultation-doctor.js
 * Roda em /medico/teleconsulta/:consultationId
 * Reaproveita o mesmo token (localStorage.doctorToken) usado no restante
 * do painel do médico — não inventa um esquema de auth novo.
 */
(function () {
  const consultationId = window.__TC_CONSULTATION_ID__;
  const token = localStorage.getItem('doctorToken');
  const doctorData = JSON.parse(localStorage.getItem('doctorData') || '{}');

  const els = {
    status: document.getElementById('tcStatus'),
    alertBox: document.getElementById('tcAlert'),
    videoHost: document.getElementById('tcVideoHost'),
    videoShell: document.getElementById('tcVideoShell'),
    startPanel: document.getElementById('tcStartPanel'),
    startBtn: document.getElementById('tcStartBtn'),
    enableBtn: document.getElementById('tcEnableBtn'),
    endBtn: document.getElementById('tcEndBtn'),
    resendBtn: document.getElementById('tcResendBtn'),
    waitingBanner: document.getElementById('tcWaitingBanner'),
    patientLinkBox: document.getElementById('tcPatientLinkBox'),
    patientLinkInput: document.getElementById('tcPatientLinkInput'),
  };

  let jitsiApi = null;
  let currentSessionId = null;
  let socket = null;

  function showAlert(message, type = 'error') {
    if (!els.alertBox) return;
    els.alertBox.textContent = message;
    els.alertBox.className = `tc-alert tc-alert-${type}`;
    els.alertBox.style.display = 'block';
  }
  function clearAlert() {
    if (els.alertBox) els.alertBox.style.display = 'none';
  }

  function api(path, options = {}) {
    return fetch(path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(options.headers || {}),
      },
    }).then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Falha na operação.');
      return data;
    });
  }

  function setBadge(text, kind) {
    if (!els.status) return;
    els.status.textContent = text;
    els.status.className = `tc-badge ${kind ? `tc-badge-${kind}` : ''}`;
  }

  function connectSocket() {
    if (typeof io === 'undefined') return;
    socket = io();
    socket.on('connect', () => {
      socket.emit('join_doctor', { doctorId: doctorData.id, clinicId: doctorData.clinicId });
    });
    socket.on('teleconsultation:paciente_aguardando', (payload) => {
      if (payload.sessionId !== currentSessionId) return;
      if (els.waitingBanner) els.waitingBanner.style.display = 'block';
      if (els.startBtn) els.startBtn.disabled = false;
    });
  }

  async function montarJitsi() {
    if (jitsiApi) return; // já montado
    const { token: jitsiToken, appId, domain, roomName } = await api(`/api/teleconsultation/sessions/${currentSessionId}/token-video`, {
      method: 'POST',
    });

    const script = document.createElement('script');
    script.src = 'https://8x8.vc/libs/external_api.min.js';
    script.onerror = () => showAlert('Não foi possível carregar o serviço de vídeo (8x8.vc). Verifique sua conexão e tente novamente.');
    script.onload = () => {
      // eslint-disable-next-line no-undef
      jitsiApi = new JitsiMeetExternalAPI(domain, {
        roomName,
        jwt: jitsiToken,
        parentNode: els.videoHost,
        width: '100%',
        height: '100%',
        configOverwrite: {
          prejoinPageEnabled: true,
          disableDeepLinking: true,
          startWithAudioMuted: false,
          startWithVideoMuted: false,
        },
        interfaceConfigOverwrite: {
          TOOLBAR_BUTTONS: [
            'microphone', 'camera', 'desktop', 'fullscreen', 'fodeviceselection',
            'hangup', 'chat', 'raisehand', 'tileview', 'videoquality',
          ],
        },
      });
      jitsiApi.addEventListener('videoConferenceLeft', () => {
        window.location.href = '/medico/agenda';
      });
    };
    document.head.appendChild(script);
    if (els.videoShell) els.videoShell.style.display = 'block';
    if (els.startPanel) els.startPanel.style.display = 'none';
  }

  async function habilitarTeleconsulta() {
    clearAlert();
    try {
      const res = await api(`/api/teleconsultation/consultations/${consultationId}/enable`, { method: 'POST' });
      currentSessionId = res.sessionId;
      if (els.patientLinkBox) els.patientLinkBox.style.display = 'block';
      if (els.patientLinkInput) els.patientLinkInput.value = res.patientLink;
      showAlert(
        res.emailEnviado
          ? 'Link enviado por e-mail ao paciente. Você já pode entrar na sala para testar câmera e microfone.'
          : 'Não foi possível enviar o e-mail automaticamente — copie o link abaixo e envie manualmente ao paciente.',
        res.emailEnviado ? 'info' : 'warn'
      );
      setBadge('Aguardando', 'wait');
      await montarJitsi();
    } catch (err) {
      showAlert(err.message);
    }
  }

  async function carregarSessaoExistente() {
    const info = await api(`/api/teleconsultation/consultations/${consultationId}/session`);
    if (!info.enabled) {
      if (els.enableBtn) els.enableBtn.style.display = 'inline-flex';
      return;
    }
    currentSessionId = info.sessionId;
    if (info.status === 'FINALIZADA') {
      setBadge('Encerrada', undefined);
      showAlert('Esta teleconsulta já foi encerrada.', 'info');
      return;
    }
    if (!info.dentroDaJanela) {
      showAlert('Fora da janela de horário desta consulta (abre 15 min antes).', 'warn');
    }
    setBadge(info.status === 'EM_ANDAMENTO' ? 'Em andamento' : 'Aguardando', info.status === 'EM_ANDAMENTO' ? 'live' : 'wait');
    if (info.patientJoinedAt && els.waitingBanner) els.waitingBanner.style.display = 'block';
    await montarJitsi();
  }

  async function iniciarAtendimento() {
    clearAlert();
    try {
      await api(`/api/teleconsultation/sessions/${currentSessionId}/iniciar`, { method: 'POST' });
      setBadge('Em andamento', 'live');
      if (els.waitingBanner) els.waitingBanner.style.display = 'none';
    } catch (err) {
      showAlert(err.message);
    }
  }

  async function encerrarAtendimento() {
    if (!window.confirm('Encerrar a teleconsulta agora?')) return;
    try {
      await api(`/api/teleconsultation/sessions/${currentSessionId}/finalizar`, { method: 'POST' });
      window.location.href = '/medico/agenda';
    } catch (err) {
      showAlert(err.message);
    }
  }

  async function reenviarLink() {
    try {
      const res = await api(`/api/teleconsultation/sessions/${currentSessionId}/reenviar-link`, { method: 'POST' });
      showAlert(res.emailEnviado ? 'Link reenviado por e-mail.' : 'Não foi possível reenviar por e-mail — use o link copiável.', res.emailEnviado ? 'info' : 'warn');
    } catch (err) {
      showAlert(err.message);
    }
  }

  if (!token) {
    window.location.href = '/medico/login';
    return;
  }

  if (els.enableBtn) els.enableBtn.addEventListener('click', habilitarTeleconsulta);
  if (els.startBtn) els.startBtn.addEventListener('click', iniciarAtendimento);
  if (els.endBtn) els.endBtn.addEventListener('click', encerrarAtendimento);
  if (els.resendBtn) els.resendBtn.addEventListener('click', reenviarLink);

  connectSocket();
  carregarSessaoExistente().catch((err) => showAlert(err.message));
})();
