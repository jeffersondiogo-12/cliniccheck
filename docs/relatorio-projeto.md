# Relatório técnico do projeto Clinic Check

## 1. Objetivo e escopo

O Clinic Check é uma aplicação web para apoiar a operação de clínicas e consultórios. O código reúne ferramentas para profissionais de saúde e recepção, gestão de pacientes e prontuários, consultas presenciais e remotas, documentos e procedimentos, além de rotinas administrativas e financeiras.

Este relatório descreve o que está representado nos arquivos do repositório e nos documentos existentes. Ele não substitui validação funcional em ambiente configurado, revisão de segurança, parecer jurídico ou avaliação clínica. Integrações que dependem de credenciais externas podem estar implementadas no código sem estarem habilitadas em determinada implantação.

## 2. Resumo executivo

- **Backend:** aplicação Node.js/Express em CommonJS, concentrada em `backend/src/`.
- **Interface:** páginas renderizadas por EJS e recursos estáticos JavaScript/CSS em `frontend/`.
- **Persistência:** PostgreSQL/Supabase; schema SQL, migrações e conexão do servidor ficam em `supabase/` e `backend/src/config/`.
- **Perfis de uso:** médico, recepcionista e paciente, com gestão de clínica e permissões de equipe.
- **Recursos funcionais:** pacientes e prontuários, consultas, procedimentos/cirurgias, teleconsulta, documentos e prescrições, agenda, caixa/financeiro, convênios, estoque, certificados e portfólio público.
- **Operação:** configuração por variáveis de ambiente, inicialização por `npm start` ou `npm run dev`, e uma definição de serviço web para Render em `render.yaml`.
- **Limite de verificação:** não há script geral de testes configurado em `package.json`; os scripts existentes cobrem tarefas operacionais específicas.

## 3. Organização do repositório

| Caminho | Responsabilidade |
| --- | --- |
| `backend/src/server.js` | Inicialização do Express, middlewares, páginas e montagem das APIs |
| `backend/src/config/` | Configuração de banco, migrações e políticas de segurança |
| `backend/src/middleware/auth.js` | Autenticação e autorização por perfil/permissão |
| `backend/src/routes/` | Endpoints de autenticação, clínica, pacientes, consultas, caixa e demais módulos |
| `backend/src/services/` | Regras de negócio, integrações externas e serviços de domínio |
| `frontend/views/` | Páginas EJS para profissionais, recepção e pacientes |
| `frontend/public/` | CSS, JavaScript e recursos de marca |
| `supabase/schema.sql` | Schema PostgreSQL principal e estruturas correlatas |
| `supabase/migration_*.sql` | Migrações SQL versionadas para áreas específicas |
| `scripts/` | Verificação de conexão e tarefas operacionais/compliance |
| `docs/` | Documentação técnica e operacional |
| `storage/` | Diretórios usados para documentos, imagens e chaves em execução local |

## 4. Arquitetura e fluxo

1. O navegador acessa páginas servidas pelo Express e renderizadas com EJS; os arquivos estáticos são publicados sob `/public`.
2. Os módulos JavaScript do navegador chamam endpoints REST montados sob `/api`.
3. O backend valida autenticação, perfil e permissões e executa as regras de negócio.
4. A persistência usa PostgreSQL/Supabase. A configuração referencia tanto o driver `pg` como o cliente `@supabase/supabase-js`.
5. Integrações externas — e-mail, Google Calendar, vídeo JaaS, classificação CID/ICD e assinatura — dependem de variáveis de ambiente e contas/provedores próprios.
6. Socket.IO está configurado no servidor HTTP para eventos em tempo real, inclusive fluxos associados à teleconsulta.

O servidor aplica Helmet, limites de requisição e controles de HTTPS configuráveis. A política CSP do Helmet está desativada no código de inicialização para compatibilidade com scripts inline das views; essa decisão deve ser reavaliada antes de endurecer a implantação.

## 5. Funcionalidades por domínio

### 5.1 Identidade, clínica e equipe

- Login de médico, recepcionista e paciente.
- Cadastro e gestão de profissionais/recepcionistas e perfil.
- Gestão da clínica, membros e escopos de atendimento.
- Permissões de acesso a páginas e operações, aplicadas por middleware.
- Integração opcional com Google para autorização e estado de conexão do calendário.

### 5.2 Pacientes e cuidado clínico

- Cadastro, edição e consulta de pacientes.
- Portal do paciente e fluxo de cadastro por link.
- Prontuários e histórico clínico, incluindo alergias, condições, medicamentos e evolução.
- Consultas, registros clínicos de acompanhamento e cirurgias/procedimentos.
- Prescrições, atestados e associação de CID-10/CID-11.
- Convênios e dados de perfil clínico.

### 5.3 Agenda e teleconsulta

- Agenda de consultas e integração opcional com Google Calendar.
- Sessões de teleconsulta com páginas distintas para profissional e paciente.
- Integração prevista com Jitsi as a Service (JaaS/8x8), usando credenciais de servidor.
- Fluxo de acesso, consentimento, entrada/início/finalização e registro de eventos descritos em `LGPD_TELEMEDICINA.md`.
- Os documentos do projeto informam gravação de vídeo desativada por padrão; qualquer alteração requer validação funcional, consentimento e política de retenção.

### 5.4 Procedimentos e documentos

- Tipos e categorias de procedimento, templates e documentos associados a cirurgias.
- Geração/gestão de documentos PDF e DOCX.
- Portal para o paciente ler o documento e concluir o fluxo de assinatura.
- Registro de hashes, versões de termos e eventos de auditoria conforme estruturas existentes no schema.
- Integração opcional com Lacuna Rest PKI, PSC/OAuth e autoridade de carimbo de tempo (TSA).
- Leitura de certificados e suporte a certificados vinculados ao profissional, conforme configuração do provedor.

### 5.5 Operação e administração

- Painéis de médico, recepção e administração.
- Cadastro de procedimentos, controle de estoque e movimentações.
- Caixa com sessões de abertura/fechamento, lançamentos e pagamentos.
- Despesas e relatórios financeiros.
- Portfólio profissional público e editor do portfólio.
- Telas para perfil, convênios e configurações da clínica.

## 6. API e páginas

As APIs são montadas pelo `backend/src/server.js`; os prefixos abaixo são as áreas principais, não uma especificação completa de todos os métodos e parâmetros.

| Prefixo | Área |
| --- | --- |
| `/api/auth` | Autenticação, equipe, permissões e OAuth Google |
| `/api/patients`, `/api/patient-auth` | Pacientes, prontuários e autenticação do paciente |
| `/api/consultations`, `/api/surgeries` | Consultas e procedimentos/cirurgias |
| `/api/teleconsultation`, `/api/patient/teleconsultation` | Sessões de vídeo para profissional e paciente |
| `/api/documents`, `/api/templates`, `/api/certificates`, `/api/lacuna` | Documentos, modelos, certificados e assinatura |
| `/api/reception`, `/api/procedure-types`, `/api/prescriptions` | Recepção, tipos de procedimento e prescrições |
| `/api/clinics`, `/api/cashier`, `/api/finance`, `/api/stock` | Clínica, caixa, financeiro e estoque |
| `/api/portfolio`, `/api/public/portfolio` | Gestão e consulta pública de portfólio |
| `/api/patient-registration`, `/api/patient/tablet` | Cadastro por convite e fluxos de tablet |

As páginas incluem login e dashboards de médico, paciente e recepção; pacientes/prontuários; agenda e teleconsulta; procedimentos; documentos e modelos; prescrição; caixa/financeiro; estoque; convênios; clínica/equipe; cadastro/assinatura do paciente e portfólio público. A lista das views em `frontend/views/` é a referência para nomes e telas implementadas.

## 7. Dados e persistência

O schema principal em `supabase/schema.sql` cobre, entre outras, estas entidades:

- **Identidade e organização:** `doctors`, `receptionists`, `clinics`, `clinic_members`, `receptionist_doctor_scope`, `app_pages`, `clinic_member_permissions`.
- **Paciente e atendimento:** `patients`, `consultations`, `medical_records`, `patient_clinical_followups`, `surgeries`.
- **Documentos e assinatura:** `document_templates`, `surgery_documents`, `signature_audit_logs`, `doctor_certificates`.
- **Clínica e catálogo:** `procedure_types`, `procedure_type_categories`, `cid10_custom`, `cid10_reference`.
- **Financeiro e estoque:** `cash_sessions`, `cash_transactions`, `cash_movements`, `expenses`.
- **Prescrição:** `prescriptions`, `medical_certificates`, `medical_certificate_cids`.

O repositório também contém migrações SQL incrementais (incluindo caixa e relatórios financeiros). Confira `backend/src/config/migrate.js` e `supabase/deploy.md` antes de aplicar alterações em um banco existente. Faça backup e teste migrações primeiro em ambiente não produtivo.

O guia de deploy informa que documentos e imagens ainda podem ser armazenados no disco local em `storage/`. Em hospedagem com disco efêmero, réplicas ou reinicializações, esse armazenamento não deve ser considerado persistente; configure storage privado externo e política de backup antes de guardar dados reais.

## 8. Segurança, privacidade e conformidade

### Controles observáveis no código/documentação

- JWT e middleware para separar perfis e aplicar permissões.
- Helmet, limitação de requisições e opção de forçar HTTPS.
- Configuração de origens permitidas e suporte a proxy.
- Controle `no-store` em páginas e endpoints que tratam tokens/sessões sensíveis.
- Senhas protegidas com `bcryptjs` (dependência do projeto).
- Serviços e estrutura para auditoria encadeada, hashes de conteúdo/documento e eventos de assinatura.
- Variáveis separadas para credenciais e configuração externa; `.env` é listado no `.gitignore`.

### Verificações obrigatórias antes de produção

1. **RLS e acesso ao banco:** o schema contém comandos que desabilitam Row Level Security em tabelas centrais. Trate o backend como única fronteira de acesso, mantenha credenciais do banco fora do navegador e revise privilégios, políticas e exposição das chaves Supabase. Não presuma isolamento por RLS.
2. **Armazenamento:** migre documentos, imagens faciais e quaisquer artefatos clínicos para armazenamento privado, com autorização, criptografia, retenção e backup testado. Não publique arquivos da pasta `storage/`.
3. **Chaves e credenciais:** use segredos fortes e exclusivos para `JWT_SECRET`, tokens de terceiros e criptografia; mantenha-os no gerenciador de segredos do ambiente. Nunca inclua `.env`, chaves privadas, PDFs ou dados reais em commits.
4. **Assinaturas e validade:** integração com provedor ou registro de hashes não equivale, isoladamente, a parecer de validade jurídica. Homologue fluxo, certificado, carimbo de tempo, retenção e textos com responsáveis jurídicos.
5. **Dados de saúde/LGPD:** valide base legal, minimização, consentimentos, direitos dos titulares, contratos com operadores, retenção e resposta a incidentes com o encarregado e assessoria competente.
6. **CSP:** o CSP do Helmet está desativado na inicialização; avalie uma política compatível com as views em vez de manter a proteção desabilitada sem revisão.
7. **Dados de demonstração:** a inicialização registra credenciais de demonstração apenas fora de produção; confirme configuração `NODE_ENV` e remova contas/dados demonstrativos de qualquer ambiente real.
8. **Auditoria:** scripts de exportação/verificação existem, mas agendamento, exportação imutável, alertas, cópias externas e testes de restauração requerem configuração operacional.

Este relatório é descritivo e não declara que a aplicação esteja certificada ou em conformidade legal/regulatória.

## 9. Configuração e integrações

Use `.env.example` como referência para o conjunto de configuração. Não copie valores reais para documentação.

| Grupo | Exemplos de variáveis | Finalidade |
| --- | --- | --- |
| Servidor e segurança | `PORT`, `NODE_ENV`, `JWT_SECRET`, `APP_BASE_URL`, `FORCE_HTTPS`, `TRUST_PROXY`, `ALLOWED_ORIGINS` | Porta, ambiente, sessão e política HTTP |
| Supabase/PostgreSQL | `SUPABASE_DB_URL`, `DB_SSL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Banco e cliente Supabase |
| E-mail | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Envio de mensagens e links |
| Assinatura/TSA | `LACUNA_RESTPKI_ENDPOINT`, `LACUNA_RESTPKI_TOKEN`, `TSA_ENDPOINT`, `TSA_API_KEY`, `TSA_MOCK_MODE`, `QUALIFIED_SIGNATURE_ENDPOINT`, `QUALIFIED_SIGNATURE_API_KEY`, `QUALIFIED_SIGNATURE_PROFILE`, `REQUIRE_QUALIFIED_SIGNATURE` | Assinatura e carimbo de tempo |
| Certificado PSC | `PSC_PROVIDER_NAME`, `PSC_OAUTH_AUTHORIZE_URL`, `PSC_OAUTH_TOKEN_URL`, `PSC_CLIENT_ID`, `PSC_CLIENT_SECRET`, `PSC_REDIRECT_URI`, `PSC_OAUTH_SCOPE`, `CERT_TOKEN_ENCRYPTION_KEY` | OAuth e tokens de certificados |
| Auditoria | `AUDIT_EXPORT_DAYS`, `AUDIT_EXPORT_DIR`, `COMPLIANCE_ALERT_WEBHOOK`, `COMPLIANCE_REPORT_DIR` | Exportações, relatórios e alertas |
| Google Calendar | `GOOGLE_CALENDAR_ENABLED`, `GOOGLE_CALENDAR_CLIENT_ID`, `GOOGLE_CALENDAR_CLIENT_SECRET`, `GOOGLE_CALENDAR_REDIRECT_URI` | OAuth e sincronização de agenda |
| JaaS/vídeo | `JAAS_APP_ID`, `JAAS_KEY_ID`, `JAAS_PRIVATE_KEY_PATH` | Tokens e conexão do serviço de vídeo |
| Catálogo ICD | `ICD_API_BASE_URL`, `ICD_TOKEN_URL`, `ICD_SCOPE`, `ICD11_RELEASE_ID`, `ICD11_LINEARIZATION`, `ICD_CLIENT_ID` | Integração de classificação internacional, conforme configuração de deploy |

O arquivo `render.yaml` define um serviço Node no Render, região Oregon, plano Free, comando de instalação `npm install`, inicialização `node backend/src/server.js` e health check em `/api/health`. Os segredos devem ser cadastrados como variáveis protegidas no provedor de hospedagem.

### Ponto de atenção no health check Render

O `render.yaml` aponta para `/api/health`, mas o `server.js` monta essa rota com o middleware `requireDoctor`. Verifique se o health checker do provedor consegue acessá-la sem autenticação; caso contrário, ele pode considerar o serviço indisponível. Recomenda-se validar em ambiente de staging e disponibilizar um health check mínimo não autenticado, sem expor dados internos.

## 10. Execução e operação

### Desenvolvimento local

1. Instale uma versão suportada do Node.js.
2. Copie `.env.example` para `.env` e preencha banco, segredo JWT e demais dependências necessárias.
3. Execute `npm install`.
4. Execute `npm run dev` para desenvolvimento ou `npm start` para iniciar o servidor.
5. Acesse `http://localhost:3000/medico/login`.

O banco deve estar acessível e inicializado antes de validar fluxos persistentes. Para criação/atualização inicial, veja `supabase/deploy.md`, `supabase/schema.sql` e o mecanismo de migrações do backend.

### Scripts operacionais

| Script | Uso |
| --- | --- |
| `npm run compliance:export-audit` | Exportação de eventos de auditoria |
| `npm run compliance:verify-chain` | Verificação da integridade da cadeia de auditoria |
| `npm run compliance:monthly-report` | Geração de relatório mensal |
| `npm run test:lacuna` | Teste de conexão com Rest PKI |

`npm run test:lacuna` valida conectividade/configuração da integração, não o comportamento integral do produto. O `package.json` não configura runner geral de testes ou suíte automatizada.

## 11. Limitações e próximos passos recomendados

1. Configurar e validar um health check público e mínimo para a implantação.
2. Criar uma suíte de testes automatizados para autenticação, permissões, pacientes, assinatura, caixa e teleconsulta.
3. Revisar autorização por tenant/clínica e o uso de RLS/credenciais Supabase com uma matriz de papéis.
4. Mover documentos e imagens para storage privado persistente; definir backup, restauração e retenção.
5. Provisionar segredos em staging/produção e testar OAuth, e-mail, vídeo, TSA e certificado com os respectivos ambientes.
6. Endurecer a política CSP e validar headers/origens em ambiente de produção.
7. Definir governança de migrações de banco e pipeline de implantação com validação prévia.
8. Revisar textos de consentimento, privacidade, retenção e assinatura com assessoria clínica/jurídica.
9. Estabelecer monitoramento, alertas e rotina operacional para auditoria e incidentes.
10. Definir e publicar licença do projeto, que não é identificada na raiz atualmente.

## 12. Referências internas

- [README do projeto](../README.md)
- [Schema do Supabase](../supabase/schema.sql)
- [Guia de deploy Supabase](../supabase/deploy.md)
- [Controles e evidências de compliance](compliance-evidencias.md)
- [Integração de certificados PSC](integracao-certificados-psc.md)
- [Integração Lacuna Rest PKI](lacuna-restpki-integration.md)
- [Orientações de teleconsulta/LGPD](../LGPD_TELEMEDICINA.md)
- [Módulo financeiro e caixa](../FINANCEIRO_CAIXA_README.md)
