const nodemailer = require('nodemailer');

function createTransporter() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user, pass },
  });
}

async function sendPatientWelcomeEmail({ to, patientName, loginLink, tempPassword }) {
  const transporter = createTransporter();
  if (!transporter || !to) {
    return { sent: false, warning: 'SMTP nao configurado ou e-mail ausente' };
  }

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: 'Acesso do paciente liberado',
    text:
      `Ola ${patientName}, seu acesso ao portal foi criado.\n` +
      `Link: ${loginLink}\n` +
      `Senha inicial: ${tempPassword}\n` +
      'Altere a senha no primeiro acesso.',
    html:
      `<p>Olá ${patientName}, seu acesso ao portal foi criado.</p>` +
      `<p><a href="${loginLink}">Acessar portal do paciente</a></p>` +
      `<p><strong>Senha inicial:</strong> ${tempPassword}</p>` +
      '<p>Altere a senha no primeiro acesso.</p>',
  });

  return { sent: true };
}

async function sendLinkEmail({ to, subject, message, link }) {
  const transporter = createTransporter();
  if (!transporter || !to) {
    return { sent: false, warning: 'SMTP nao configurado ou e-mail ausente' };
  }

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject,
    text: `${message}\n\nLink: ${link}`,
    html: `<p>${message}</p><p><a href="${link}">Abrir link</a></p>`,
  });

  return { sent: true };
}

module.exports = { sendPatientWelcomeEmail, sendLinkEmail };
