let authToken = null;
let editorInstance = null;
let currentDocumentId = null;

const loginForm = document.getElementById('loginForm');
const patientForm = document.getElementById('patientForm');
const consultationForm = document.getElementById('consultationForm');
const surgeryForm = document.getElementById('surgeryForm');
const documentForm = document.getElementById('documentForm');
const shareForm = document.getElementById('shareForm');

const loginStatus = document.getElementById('loginStatus');
const patientSelect = document.getElementById('patientSelect');
const surgerySelect = document.getElementById('surgerySelect');
const templateSelect = document.getElementById('templateSelect');
const customHtmlField = document.getElementById('customHtml');
const documentResult = document.getElementById('documentResult');
const shareEmail = document.getElementById('shareEmail');
const sharePhone = document.getElementById('sharePhone');
const shareMessage = document.getElementById('shareMessage');
const shareResult = document.getElementById('shareResult');

function api(path, options = {}) {
  return fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...(options.headers || {}),
    },
  }).then(async (res) => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || 'Falha na operacao');
    }
    return data;
  });
}

function setupEditor() {
  if (window.ClassicEditor) {
    window.ClassicEditor.create(customHtmlField)
      .then((editor) => {
        editorInstance = editor;
      })
      .catch(() => {
        editorInstance = null;
      });
  }
}

async function loadPatients() {
  const patients = await api('/api/patients');
  patientSelect.innerHTML = '';
  patients.forEach((p) => {
    const option = document.createElement('option');
    option.value = p.id;
    option.dataset.email = p.email || '';
    option.dataset.phone = p.phone || '';
    option.textContent = `${p.name} ${p.document_id ? '- ' + p.document_id : ''}`;
    patientSelect.appendChild(option);
  });
}

async function loadSurgeries() {
  const surgeries = await api('/api/surgeries');
  surgerySelect.innerHTML = '';
  surgeries.forEach((s) => {
    const option = document.createElement('option');
    option.value = s.id;
    option.textContent = `${s.title} - ${s.patient_name}`;
    surgerySelect.appendChild(option);
  });
}

async function loadTemplates() {
  const templates = await api('/api/templates');
  templateSelect.innerHTML = '<option value="">Sem template</option>';
  templates.forEach((tpl) => {
    const option = document.createElement('option');
    option.value = tpl.id;
    option.textContent = tpl.name;
    option.dataset.bodyHtml = tpl.body_html;
    templateSelect.appendChild(option);
  });
}

templateSelect.addEventListener('change', () => {
  const selected = templateSelect.options[templateSelect.selectedIndex];
  if (selected && selected.dataset.bodyHtml) {
    if (editorInstance) {
      editorInstance.setData(selected.dataset.bodyHtml);
    } else {
      customHtmlField.value = selected.dataset.bodyHtml;
    }
  }
});

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(loginForm);
  try {
    const result = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: formData.get('email'),
        password: formData.get('password'),
      }),
    });

    authToken = result.token;
    loginStatus.textContent = `Logado como ${result.doctor.name}`;
    await Promise.all([loadPatients(), loadSurgeries(), loadTemplates()]);
  } catch (error) {
    loginStatus.textContent = error.message;
  }
});

patientForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(patientForm);
  try {
    const response = await api('/api/patients', {
      method: 'POST',
      body: JSON.stringify({
        name: formData.get('name'),
        email: formData.get('email'),
        password: formData.get('password'),
        phone: formData.get('phone'),
        documentId: formData.get('documentId'),
        birthDate: formData.get('birthDate'),
      }),
    });

    patientForm.reset();
    await loadPatients();
    alert(response.inviteEmail.sent ? 'Paciente cadastrado e e-mail enviado.' : 'Paciente cadastrado. SMTP nao configurado.');
  } catch (error) {
    alert(error.message);
  }
});

consultationForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(consultationForm);
  try {
    await api('/api/consultations', {
      method: 'POST',
      body: JSON.stringify({
        patientId: patientSelect.value,
        consultationAt: formData.get('consultationAt'),
        summary: formData.get('summary'),
        diagnosis: formData.get('diagnosis'),
        prescription: formData.get('prescription'),
      }),
    });
    consultationForm.reset();
    alert('Consulta salva no histórico do paciente.');
  } catch (error) {
    alert(error.message);
  }
});

surgeryForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(surgeryForm);
  try {
    await api('/api/surgeries', {
      method: 'POST',
      body: JSON.stringify({
        patientId: patientSelect.value,
        title: formData.get('title'),
        scheduledAt: formData.get('scheduledAt'),
        hospital: formData.get('hospital'),
        procedureDetails: formData.get('procedureDetails'),
        complications: formData.get('complications'),
        notes: formData.get('notes'),
      }),
    });
    surgeryForm.reset();
    await loadSurgeries();
  } catch (error) {
    alert(error.message);
  }
});

documentForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(documentForm);

  try {
    const result = await api('/api/documents/generate', {
      method: 'POST',
      body: JSON.stringify({
        surgeryId: surgerySelect.value,
        templateId: formData.get('templateId') || null,
        title: formData.get('title'),
        customHtml: editorInstance ? editorInstance.getData() : formData.get('customHtml'),
      }),
    });

    currentDocumentId = result.documentId;
    shareForm.classList.remove('hidden-block');
    shareEmail.value = result.patientContact?.email || '';
    sharePhone.value = result.patientContact?.phone || '';
    shareMessage.value = `Ola, seu documento medico esta disponivel para leitura e assinatura: ${result.accessLink}`;

    documentResult.innerHTML = `
      <p><strong>Documento criado.</strong></p>
      <p><a href="${result.accessLink}" target="_blank">Link interno de assinatura</a></p>
      ${result.whatsappLink ? `<p><a href="${result.whatsappLink}" target="_blank">Abrir envio no WhatsApp</a></p>` : ''}
      <p><a href="${result.downloads.pdf}" target="_blank">Download PDF</a> | <a href="${result.downloads.docx}" target="_blank">Download DOCX</a></p>
    `;
  } catch (error) {
    documentResult.textContent = error.message;
  }
});

shareForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  if (!currentDocumentId) {
    shareResult.textContent = 'Gere um documento antes de compartilhar.';
    return;
  }

  try {
    const result = await api(`/api/documents/${currentDocumentId}/share`, {
      method: 'POST',
      body: JSON.stringify({
        patientEmail: shareEmail.value.trim() || null,
        patientPhone: sharePhone.value.trim() || null,
        customMessage: shareMessage.value.trim() || null,
      }),
    });

    shareResult.innerHTML = `
      <p><strong>Compartilhamento concluido.</strong></p>
      <p><a href="${result.accessLink}" target="_blank">Link do documento</a></p>
      ${result.whatsappLink ? `<p><a href="${result.whatsappLink}" target="_blank">Enviar via WhatsApp</a></p>` : '<p>Telefone nao informado para WhatsApp.</p>'}
      <p>${result.emailSent ? 'E-mail enviado com sucesso.' : 'E-mail nao enviado.'}</p>
      ${result.emailWarning ? `<p>${result.emailWarning}</p>` : ''}
    `;
  } catch (error) {
    shareResult.textContent = error.message;
  }
});

setupEditor();
