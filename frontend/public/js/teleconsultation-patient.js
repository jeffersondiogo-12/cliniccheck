/* teleconsultation-patient.js
 * Roda em /paciente/teleconsulta/:token — acesso via link único, sem login.
 * Fluxo: consentimento LGPD -> sala de espera -> vídeo (só quando o
 * médico inicia) -> encerramento.
 */
(function () {
  const tokenParam = window.__TC_TOKEN__;
  const base = `/api/patient/teleconsultation/${tokenParam}`;

  const steps = {
    loading: document.getElementById('tcStepLoading'),
    consent: document.getElementById('tcStepConsent'),
    waiting: document.getElementById('tcStepWaiting'),
    video: document.getElementById('tcStepVideo'),
    ended: document.getElementById('tcStepEnded'),
    error: document.getElementById('tcStepError'),
  };
  const els = {
    consentText: document.getElementById('tcConsentText'),
    consentCheck: document.getElementById('tcConsentCheck'),
    consentBtn: document.getElementById('tcConsentBtn'),
    errorMsg: document.getElementById('tcErrorMsg'),
    doctorName: document.getElementById('tcDoctorName'),
    consultationAt: document.getElementById('tcConsultationAt'),
    videoHost: document.getElementById('tcVideoHost'),
    leaveBtn: document.getElementById('tcLeaveBtn'),
  };

  let jitsiApi = null;
  let socket = null;
  let sessaoAtual = null;

  function mostrarPasso(nome) {
    Object.entries(steps).forEach(([key, el]) => {
      if (el) el.style.display = key === nome ? 'block' : 'none';
    });
  }

  function mostrarErro(mensagem) {
    if (els.errorMsg) els.errorMsg.textContent = mensagem;
    mostrarPasso('error');
  }

  function api(path, options = {}) {
    return fetch(path, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    }).then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Não foi possível completar a ação.');
      return data;
    });
  }

  function conectarSocket() {
    if (typeof io === 'undefined' || !sessaoAtual) return;
    socket = io();
    socket.on('connect', () => {
      socket.emit('join_patient', { patientId: sessaoAtual.patientId, clinicId: sessaoAtual.clinicId });
    });
    socket.on('teleconsultation:iniciada', (payload) => {
      if (payload.sessionId !== sessaoAtual.sessionId) return;
      entrarNaChamada();
    });
    socket.on('teleconsultation:finalizada', (payload) => {
      if (payload.sessionId !== sessaoAtual.sessionId) return;
      if (jitsiApi) jitsiApi.executeCommand('hangup');
      mostrarPasso('ended');
    });
  }

  async function montarJitsi() {
    const { token: jitsiToken, appId, domain, roomName } = await api(`${base}/token-video`, { method: 'POST' });

    mostrarPasso('video');
    const script = document.createElement('script');
    script.src = 'https://8x8.vc/libs/external_api.min.js';
    script.onerror = () => mostrarErro('Não foi possível carregar o serviço de vídeo (8x8.vc). Verifique sua conexão e tente novamente.');
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
        },
        interfaceConfigOverwrite: {
          TOOLBAR_BUTTONS: ['microphone', 'camera', 'fullscreen', 'fodeviceselection', 'hangup', 'chat', 'raisehand', 'tileview'],
        },
      });
      jitsiApi.addEventListener('videoConferenceLeft', () => mostrarPasso('ended'));
    };
    document.head.appendChild(script);
  }

  async function entrarNaChamada() {
    try {
      await montarJitsi();
    } catch (err) {
      mostrarErro(err.message);
    }
  }

  async function entrarNaSalaDeEspera() {
    try {
      const res = await api(`${base}/aguardar`, { method: 'POST' });
      mostrarPasso('waiting');
      if (res.status === 'EM_ANDAMENTO') {
        await entrarNaChamada();
      }
    } catch (err) {
      mostrarErro(err.message);
    }
  }

  async function aceitarTermo() {
    if (!els.consentCheck || !els.consentCheck.checked) return;
    try {
      await api(`${base}/consentimento`, { method: 'POST', body: JSON.stringify({ aceito: true }) });
      await entrarNaSalaDeEspera();
    } catch (err) {
      mostrarErro(err.message);
    }
  }

  async function iniciar() {
    mostrarPasso('loading');
    try {
      const status = await api(base);
      sessaoAtual = {
        sessionId: status.sessionId,
        patientId: status.patientId,
        clinicId: status.clinicId,
      };

      if (els.doctorName) els.doctorName.textContent = status.doctorName ? `Dr(a). ${status.doctorName}${status.doctorCrm ? ` — CRM ${status.doctorCrm}` : ''}` : '';
      if (els.consultationAt && status.consultationAt) {
        els.consultationAt.textContent = new Date(status.consultationAt).toLocaleString('pt-BR');
      }

      conectarSocket();

      if (status.status === 'FINALIZADA') {
        mostrarPasso('ended');
        return;
      }
      if (!status.dentroDaJanela) {
        mostrarErro(`Este link ainda não está liberado. A sala abre ${status.janelaAntecedenciaMin} minutos antes do horário agendado.`);
        return;
      }
      if (status.precisaConsentimento) {
        if (els.consentText) els.consentText.textContent = status.termoTexto || '';
        mostrarPasso('consent');
        return;
      }
      if (status.status === 'EM_ANDAMENTO') {
        await entrarNaChamada();
        return;
      }
      await entrarNaSalaDeEspera();
    } catch (err) {
      mostrarErro(err.message);
    }
  }

  if (els.consentCheck && els.consentBtn) {
    els.consentCheck.addEventListener('change', () => {
      els.consentBtn.disabled = !els.consentCheck.checked;
    });
    els.consentBtn.addEventListener('click', aceitarTermo);
  }
  if (els.leaveBtn) {
    els.leaveBtn.addEventListener('click', () => {
      if (jitsiApi) jitsiApi.executeCommand('hangup');
    });
  }

  iniciar();
})();
