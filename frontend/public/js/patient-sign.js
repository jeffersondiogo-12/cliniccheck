const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const preview = document.getElementById('preview');
const startCameraBtn = document.getElementById('startCameraBtn');
const captureBtn = document.getElementById('captureBtn');
const signBtn = document.getElementById('signBtn');
const signStatus = document.getElementById('signStatus');
const signatureNameField = document.getElementById('signatureName');
const acceptedField = document.getElementById('accepted');
const documentBox = document.getElementById('documentBox');
const prevPageBtn = document.getElementById('prevPageBtn');
const nextPageBtn = document.getElementById('nextPageBtn');
const pageIndicator = document.getElementById('pageIndicator');
const readProgress = document.getElementById('readProgress');
const signBlockHint = document.getElementById('signBlockHint');
const faceBlockHint = document.getElementById('faceBlockHint');

let capturedFace = null;
let pages = [];
let currentPageIndex = 0;
const readPageIndexes = new Set();

function splitIntoPages(html) {
  const container = document.createElement('div');
  container.innerHTML = html;

  const blocks = Array.from(container.querySelectorAll('h1, h2, h3, p, ul, ol, li, div, table'));
  if (blocks.length === 0) {
    return [html];
  }

  const chunks = [];
  let currentChunk = '';
  let currentLength = 0;
  const maxCharsPerPage = 1600;

  blocks.forEach((block) => {
    const part = block.outerHTML;
    const partLength = block.textContent ? block.textContent.length : part.length;
    if (currentLength + partLength > maxCharsPerPage && currentChunk) {
      chunks.push(currentChunk);
      currentChunk = '';
      currentLength = 0;
    }
    currentChunk += part;
    currentLength += partLength;
  });

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks.length ? chunks : [html];
}

function setControlsEnabled(enabled) {
  startCameraBtn.disabled = !enabled;
  captureBtn.disabled = !enabled;
  signBtn.disabled = !enabled;
  signatureNameField.disabled = !enabled;
  acceptedField.disabled = !enabled;

  if (enabled) {
    signBlockHint.textContent = 'Leitura completa. Agora capture sua face e assine.';
    faceBlockHint.textContent = 'Leitura concluída. Agora capture sua face.';
  } else {
    signBlockHint.textContent = 'A assinatura será liberada após leitura completa do documento.';
    faceBlockHint.textContent = 'Capture sua face após concluir a leitura de todas as páginas.';
  }
}

async function syncReadProgress() {
  try {
    const maxReadPage = Math.max(...Array.from(readPageIndexes).map((idx) => idx + 1));
    await fetch(`/api/patient/progress/${window.__SIGN_TOKEN__}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        totalPages: pages.length,
        currentPage: maxReadPage,
      }),
    });
  } catch (_error) {
    // Mantem UX local mesmo se o sync temporariamente falhar.
  }
}

function updateReadingGate() {
  const readCount = readPageIndexes.size;
  readProgress.textContent = `Leitura: ${readCount}/${pages.length} páginas`;
  const allRead = readCount >= pages.length;
  setControlsEnabled(allRead);
}

async function markPageAsRead(index) {
  if (!readPageIndexes.has(index)) {
    readPageIndexes.add(index);
    updateReadingGate();
    await syncReadProgress();
  }
}

async function renderPage(index) {
  currentPageIndex = index;
  documentBox.innerHTML = pages[index];
  pageIndicator.textContent = `Página ${index + 1} de ${pages.length}`;

  prevPageBtn.disabled = index === 0;
  nextPageBtn.disabled = index === pages.length - 1;

  await markPageAsRead(index);
}

async function initializeDocumentReader() {
  pages = splitIntoPages(window.__DOCUMENT_HTML__ || '');
  setControlsEnabled(false);
  await renderPage(0);
}

prevPageBtn.addEventListener('click', async () => {
  if (currentPageIndex > 0) {
    await renderPage(currentPageIndex - 1);
  }
});

nextPageBtn.addEventListener('click', async () => {
  if (currentPageIndex < pages.length - 1) {
    await renderPage(currentPageIndex + 1);
  }
});

startCameraBtn.addEventListener('click', async () => {
  if (startCameraBtn.disabled) {
    signStatus.textContent = 'Finalize a leitura de todas as páginas antes de abrir a câmera.';
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
    video.srcObject = stream;
    signStatus.textContent = 'Camera pronta.';
  } catch (_error) {
    signStatus.textContent = 'Nao foi possivel abrir a camera.';
  }
});

captureBtn.addEventListener('click', () => {
  if (captureBtn.disabled) {
    signStatus.textContent = 'Finalize a leitura de todas as páginas antes de capturar a face.';
    return;
  }

  if (!video.srcObject) {
    signStatus.textContent = 'Abra a camera antes de capturar.';
    return;
  }

  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  capturedFace = canvas.toDataURL('image/jpeg', 0.85);
  preview.src = capturedFace;
  preview.style.display = 'block';
  signStatus.textContent = 'Face capturada com sucesso.';
});

signBtn.addEventListener('click', async () => {
  const signatureName = signatureNameField.value.trim();
  const accepted = acceptedField.checked;

  if (signBtn.disabled) {
    signStatus.textContent = 'Leia todas as páginas para liberar a assinatura.';
    return;
  }

  if (!signatureName) {
    signStatus.textContent = 'Informe o nome da assinatura.';
    return;
  }

  if (!accepted) {
    signStatus.textContent = 'Voce precisa aceitar o documento.';
    return;
  }

  if (!capturedFace) {
    signStatus.textContent = 'Capture sua face antes de finalizar a assinatura.';
    return;
  }

  try {
    const response = await fetch(`/api/patient/sign/${window.__SIGN_TOKEN__}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        signatureName,
        accepted,
        faceImageBase64: capturedFace,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Falha ao assinar documento');
    }

    signStatus.textContent = `Documento assinado em ${new Date(data.signedAt).toLocaleString('pt-BR')}.`;
  } catch (error) {
    signStatus.textContent = error.message;
  }
});

initializeDocumentReader();
