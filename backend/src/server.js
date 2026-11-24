require('dotenv').config();
const http = require('http');
const path = require('path');
const express = require('express');
const { Server } = require('socket.io');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { getSecurityConfig } = require('./config/security');
const { runMigrations } = require('./config/migrate');
const socketService = require('./services/socketService');

// Rede de seguranca: sem isto, qualquer erro assincrono que escape de um
// try/catch em algum lugar do codigo (ex: uma query ao banco que falha por
// ECONNRESET) derruba o processo Node inteiro, tirando o servidor do ar ate
// alguem reiniciar manualmente. Com isto, o erro so fica registrado no log
// e o servidor continua rodando para as outras requisicoes.
process.on('unhandledRejection', (reason) => {
  console.error('[server] Promise rejeitada sem tratamento (servidor continua no ar):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[server] Excecao nao tratada (servidor continua no ar):', err);
});

const authRoutes = require('./routes/authRoutes');
const patientRoutes = require('./routes/patientRoutes');
const patientAuthRoutes = require('./routes/patientAuthRoutes');
const patientRegistrationRoutes = require('./routes/patientRegistrationRoutes');
const surgeryRoutes = require('./routes/surgeryRoutes');
const consultationRoutes = require('./routes/consultationRoutes');
const insuranceRoutes = require('./routes/insuranceRoutes');
const teleconsultationRoutes = require('./routes/teleconsultationRoutes');
const patientTeleconsultationRoutes = require('./routes/patientTeleconsultationRoutes');
const templateRoutes = require('./routes/templateRoutes');
const documentRoutes = require('./routes/documentRoutes');
const portalRoutes = require('./routes/portalRoutes');
const tabletRoutes = require('./routes/tabletRoutes');
const certificateRoutes = require('./routes/certificateRoutes');
const lacunaSignatureRoutes = require('./routes/lacunaSignatureRoutes');
const receptionRoutes = require('./routes/receptionRoutes');
const procedureTypeRoutes = require('./routes/procedureTypeRoutes');
const prescriptionRoutes  = require('./routes/prescriptionRoutes');
const clinicRoutes        = require('./routes/clinicRoutes');
const cashierRoutes       = require('./routes/cashierRoutes');
const financeReportsRoutes = require('./routes/financeReportsRoutes');
const stockRoutes = require('./routes/stockRoutes');
const { router: portfolioRoutes, publicRouter: publicPortfolioRoutes } = require('./routes/portfolioRoutes');
const {
  requireDoctor,
  requireDoctorPagePermission,
  requireReceptionistPagePermission,
  requireDoctorApiPermission,
  requirePatientPagePermission,
} = require('./middleware/auth');

const app = express();
const security = getSecurityConfig();

app.disable('x-powered-by');
if (security.trustProxy) {
  app.set('trust proxy', 1);
}

function isSecureRequest(req) {
  if (req.secure) return true;
  const proto = req.headers['x-forwarded-proto'];
  if (!proto) return false;
  // Render e outros proxies podem enviar múltiplos valores separados por vírgula
  return proto.split(',')[0].trim() === 'https';
}

function enforceHttps(req, res, next) {
  if (!security.forceHttps) return next();
  if (isSecureRequest(req)) return next();

  if (req.method === 'GET' || req.method === 'HEAD') {
    const host = req.headers.host;
    if (!host) return res.status(400).json({ error: 'Host inválido.' });
    return res.redirect(301, `https://${host}${req.originalUrl}`);
  }

  return res.status(403).json({ error: 'HTTPS obrigatório.' });
}

function noStore(req, res, next) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  return next();
}

// ─── Segurança HTTP ──────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // compatibilidade com scripts inline EJS
  crossOriginEmbedderPolicy: false,
  hsts: security.forceHttps
    ? {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true,
      }
    : false,
}));

app.use(enforceHttps);

// Rate limiting – protege contra brute-force e enumeração
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 20,                   // máximo 20 tentativas por janela
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de login. Aguarde 15 minutos e tente novamente.' },
});

const publicApiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,  // 5 minutos
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Aguarde e tente novamente.' },
});

const apiLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutos
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Taxa de requisições excedida. Tente novamente em alguns minutos.' },
});

const signaturePageLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Muitas tentativas. Aguarde alguns minutos.',
});

const teleconsultationPageLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Muitas tentativas. Aguarde alguns minutos.',
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', '..', 'frontend', 'views'));

app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use('/public', express.static(path.join(__dirname, '..', '..', 'frontend', 'public')));
app.get('/favicon.ico', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'frontend', 'public', 'brand', 'clinic-check-favicon.svg'));
});

// As páginas abaixo (médico, recepção, admin) mudam de conteúdo conforme a
// permissão de cada usuário — sem isto, o navegador podia guardar uma versão
// já renderizada (ex.: cache "voltar/avançar") e mostrar de novo uma tela
// que a pessoa não tem mais acesso, sem passar pela checagem do servidor.
app.use(['/medico', '/recepcao', '/admin'], noStore);

app.get('/', (_req, res) => res.redirect('/medico/login'));
app.get('/medico/login', (_req, res) => res.render('doctor-login'));
app.get('/medico', requireDoctorPagePermission('dashboard'), (_req, res) => res.render('doctor-dashboard'));
app.get('/medico/pacientes', requireDoctorPagePermission('patients'), (_req, res) => res.render('doctor-patients'));
app.get('/medico/prontuarios', requireDoctorPagePermission('patients.records'), (_req, res) => res.render('doctor-medical-records'));
app.get('/medico/pacientes/:id', requireDoctorPagePermission('patients'), (_req, res) => res.render('doctor-patient-profile'));
app.get('/medico/pacientes/:id/detalhes', requireDoctorPagePermission('patients'), (_req, res) => res.render('doctor-patient-profile'));
app.get('/medico/procedimentos', requireDoctorPagePermission('procedures'), (_req, res) => res.render('doctor-procedures'));
app.get('/medico/procedimentos/novo', requireDoctorPagePermission('procedures'), (_req, res) => res.redirect('/medico/procedimentos'));
app.get('/medico/procedimentos/tipos', requireDoctorPagePermission('procedures.types'), (_req, res) => res.render('procedure-types'));
app.get('/medico/caixa', requireDoctorPagePermission('financeiro.caixa'), (_req, res) => res.render('doctor-cashier'));
app.get('/medico/financeiro/dashboard', requireDoctorPagePermission('financeiro.relatorios'), (_req, res) => res.render('doctor-finance-dashboard'));
app.get('/medico/financeiro/relatorios', requireDoctorPagePermission('financeiro.relatorios'), (_req, res) => res.render('doctor-finance-reports'));
app.get('/medico/financeiro/despesas', requireDoctorPagePermission('financeiro.despesas'), (_req, res) => res.render('doctor-expenses'));
app.get('/medico/documentos', requireDoctorPagePermission('documents'), (_req, res) => res.render('doctor-documents'));
app.get('/medico/templates', requireDoctorPagePermission('templates'), (_req, res) => res.render('doctor-templates'));
app.get('/medico/receita', requireDoctorPagePermission('prescriptions'), (_req, res) => res.render('doctor-prescription'));
app.get('/medico/receita-atestado', requireDoctorPagePermission('prescriptions'), (_req, res) => res.redirect('/medico/receita'));
app.get('/medico/clinica', requireDoctorPagePermission('clinic'), (_req, res) => res.render('clinic-management'));
app.get('/medico/agenda', requireDoctorPagePermission('agenda'), (_req, res) => res.render('doctor-agenda'));
app.get('/medico/convenios', requireDoctorPagePermission('convenios'), (_req, res) => res.render('doctor-insurance'));
app.get('/medico/estoque', requireDoctorPagePermission('estoque'), (_req, res) => res.render('doctor-stock'));
app.get('/medico/portfolio', requireDoctorPagePermission('portfolio'), (_req, res) => res.render('doctor-portfolio-editor'));
app.get('/medico/perfil', requireDoctorPagePermission('perfil'), (_req, res) => res.render('doctor-profile'));
app.get('/portfolio/:slug', (req, res) => res.render('public-portfolio', { slug: req.params.slug }));
app.get('/medico/teleconsulta/:consultationId', (req, res) => res.render('doctor-teleconsultation', { consultationId: req.params.consultationId }));
app.get('/admin', requireDoctorPagePermission('team'), (_req, res) => res.render('admin-dashboard'));
app.get('/recepcao/login', (_req, res) => res.render('receptionist-login'));
app.get('/recepcao', requireReceptionistPagePermission('reception'), (_req, res) => res.render('receptionist-dashboard'));
app.get('/paciente/login', (_req, res) => res.render('patient-login'));
app.get('/paciente/portal', requirePatientPagePermission, (_req, res) => res.render('patient-portal'));
app.get('/paciente/assinar/:token', (_req, res) => res.render('patient-sign'));
app.get('/paciente/cadastro/:token', (_req, res) => res.render('patient-registration', { token: _req.params.token }));
app.use('/paciente/teleconsulta', teleconsultationPageLimiter);
app.use('/paciente/teleconsulta', noStore);
app.get('/paciente/teleconsulta/:token', (req, res) => res.render('patient-teleconsultation', { token: req.params.token }));

app.get('/api/health', requireDoctor, (_req, res) => res.status(200).json({ status: 'ok' }));

// Compatibilidade com callback OAuth antigo usado em algumas configuracoes do Google Cloud.
app.get('/api/calendar/callback', (req, res) => {
  const query = new URLSearchParams(req.query || {}).toString();
  const target = query ? `/api/auth/google/callback?${query}` : '/api/auth/google/callback';
  return res.redirect(target);
});

// Rate limiting aplicado nos endpoints de autenticação e APIs públicas
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth/login-receptionist', loginLimiter);
app.use('/api/patient-auth/login', loginLimiter);
app.use('/api/auth/clinics-for-receptionist', publicApiLimiter);
app.use('/api/patient/document', publicApiLimiter);
app.use('/api/patient/sign', publicApiLimiter);
app.use('/api/patient/progress', publicApiLimiter);
app.use('/api/patient/teleconsultation', publicApiLimiter);
app.use('/api/public/portfolio', publicApiLimiter);
app.use('/assinatura', signaturePageLimiter);

// Evita cache de URLs com token de acesso sensível.
app.use('/assinatura', noStore);
app.use('/api/patient', noStore);

// Limite global para todas as APIs.
app.use('/api', apiLimiter);

app.use('/api/auth', authRoutes);
// Sem requireDoctorApiPermission aqui de proposito — patientRoutes.js e
// consultationRoutes.js ja fazem a propria checagem por rota (medico OU
// recepcionista + permissao granular por pagina). Um gate aqui na frente,
// travado so pra medico, bloquearia a recepcao antes mesmo de chegar la.
app.use('/api/patients', patientRoutes);
app.use('/api/patient-auth', patientAuthRoutes);
app.use('/', patientRegistrationRoutes);
app.use('/api/surgeries', requireDoctorApiPermission('procedures'), surgeryRoutes);
app.use('/api/consultations', consultationRoutes);
app.use('/api/insurance', insuranceRoutes);
app.use('/api/teleconsultation', requireDoctorApiPermission('agenda'), teleconsultationRoutes);
app.use('/api/patient/teleconsultation', patientTeleconsultationRoutes);
app.use('/api/templates', requireDoctorApiPermission('templates'), templateRoutes);
app.use('/api/documents', requireDoctorApiPermission('documents'), documentRoutes);
app.use('/api/certificates', certificateRoutes);
app.use('/api/lacuna', lacunaSignatureRoutes);
app.use('/api/reception', receptionRoutes);
app.use('/', tabletRoutes);
app.use('/api/procedure-types', requireDoctorApiPermission('procedures'), procedureTypeRoutes);
app.use('/api/prescriptions', requireDoctorApiPermission('prescriptions'), prescriptionRoutes);
app.use('/api/clinics',       clinicRoutes);
app.use('/api/cashier',       cashierRoutes);
app.use('/api/finance',       financeReportsRoutes);
// stockRoutes.js tambem ja faz a propria checagem por rota (medico OU
// recepcionista + permissao granular da pagina 'estoque').
app.use('/api/stock',         stockRoutes);
app.use('/api/portfolio',     portfolioRoutes);
app.use('/api/public/portfolio', publicPortfolioRoutes);
app.use('/', portalRoutes);

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'Erro interno no servidor' });
});

const port = Number(process.env.PORT || 3000);
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: security.allowedOrigins.length > 0 ? security.allowedOrigins : true,
    credentials: true,
  },
  transports: ['websocket', 'polling'],
});
socketService.init(io);

httpServer.listen(port, async () => {
  try {
    await runMigrations();
  } catch (err) {
    console.warn('[migrate] Primeira tentativa falhou, tentando novamente em 3s:', err.message);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    try {
      await runMigrations();
    } catch (err2) {
      console.error('[migrate] Segunda tentativa tambem falhou — servidor segue no ar, mas confira a conexao com o banco:', err2.message);
    }
  }
  console.log(`Servidor executando em http://localhost:${port}`);
  if (security.forceHttps) {
    console.log('[SEGURANÇA] HTTPS obrigatório habilitado (FORCE_HTTPS=true).');
  }
  if (security.allowedOrigins.length > 0) {
    console.log(`[SEGURANÇA] Origens permitidas (HTTP/WebSocket): ${security.allowedOrigins.join(', ')}`);
  }
  if (!security.isProduction) {
    console.log('Medico inicial: medico@demo.com / 123456');
  }
});
