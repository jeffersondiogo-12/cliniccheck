const surgeriesList = document.getElementById('surgeriesList');
const consultationsList = document.getElementById('consultationsList');
const refreshBtn = document.getElementById('refreshBtn');
const logoutBtn = document.getElementById('logoutBtn');

const getCookie = (name) => {
  const match = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([.$?*|{}()[\]\\/+^])/g, '\\$1') + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
};

const token = localStorage.getItem('patientToken') || getCookie('patientToken');

if (!token) {
  window.location.href = '/paciente/login';
}

async function loadRecords() {
  const response = await fetch('/api/patient-auth/me/records', {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Falha ao carregar dados');
  }

  surgeriesList.innerHTML = '';
  if (data.surgeries.length === 0) {
    surgeriesList.innerHTML = '<p class="hint">Sem cirurgias registradas.</p>';
  } else {
    data.surgeries.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'sub-card';
      card.innerHTML = `
        <p><strong>${item.title}</strong> (${item.status})</p>
        <p>Médico: ${item.doctor_name} (${item.crm})</p>
        <p>Hospital: ${item.hospital || 'Não informado'}</p>
        <p>Data: ${item.scheduled_at ? new Date(item.scheduled_at).toLocaleString('pt-BR') : 'Não definida'}</p>
      `;
      surgeriesList.appendChild(card);
    });
  }

  consultationsList.innerHTML = '';
  if (data.consultations.length === 0) {
    consultationsList.innerHTML = '<p class="hint">Sem consultas registradas.</p>';
  } else {
    data.consultations.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'sub-card';
      const isTele = item.modality === 'TELECONSULTA' && item.teleconsultation_token;
      const teleEncerrada = item.teleconsultation_status === 'FINALIZADA';
      const teleButton = isTele
        ? (teleEncerrada
            ? '<p><span class="hint">Teleconsulta encerrada</span></p>'
            : `<p><a class="btn btn-green" href="/paciente/teleconsulta/${item.teleconsultation_token}">🎥 Entrar na Teleconsulta</a></p>`)
        : '';
      card.innerHTML = `
        <p><strong>${new Date(item.consultation_date).toLocaleString('pt-BR')}</strong>${isTele ? ' <span class="hint">(Teleconsulta)</span>' : ''}</p>
        <p>Médico: ${item.doctor_name} (${item.crm})</p>
        <p><strong>Resumo:</strong> ${item.notes}</p>
        <p><strong>Diagnóstico:</strong> ${item.diagnosis || 'Não informado'}</p>
        <p><strong>Prescrição:</strong> ${item.prescription || 'Não informado'}</p>
        ${teleButton}
      `;
      consultationsList.appendChild(card);
    });
  }
}

refreshBtn.addEventListener('click', () => {
  loadRecords().catch((error) => alert(error.message));
});

logoutBtn.addEventListener('click', () => {
  localStorage.removeItem('patientToken');
  localStorage.removeItem('patientData');
  document.cookie = 'patientToken=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax';
  window.location.href = '/paciente/login';
});

loadRecords().catch((error) => {
  alert(error.message);
  localStorage.removeItem('patientToken');
  localStorage.removeItem('patientData');
  document.cookie = 'patientToken=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax';
  window.location.href = '/paciente/login';
});
