const form = document.getElementById('patientLoginForm');
const statusText = document.getElementById('patientLoginStatus');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(form);

  try {
    const response = await fetch('/api/patient-auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: formData.get('email'),
        password: formData.get('password'),
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Falha no login');
    }

    localStorage.setItem('patientToken', data.token);
    document.cookie = `patientToken=${encodeURIComponent(data.token)}; path=/; max-age=43200; SameSite=Lax`;
    window.location.href = '/paciente/portal';
  } catch (error) {
    statusText.textContent = error.message;
  }
});
