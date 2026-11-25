# Clinic Check

Sistema web para gestão de clínicas e consultórios, com foco em atendimento médico, acompanhamento de pacientes, procedimentos, documentos clínicos, teleconsulta e rotinas administrativas.

## Visão geral

O projeto reúne:

- **Painel médico e da clínica** para pacientes, prontuários, consultas, procedimentos, documentos, prescrições, agenda, convênios, estoque e relatórios.
- **Painel de recepção** com agenda e permissões operacionais, incluindo acesso compartilhado ao caixa quando autorizado.
- **Portal do paciente** para cadastro, histórico, consulta de documentos, consentimento e teleconsulta.
- **Fluxos digitais** para assinatura de documentos, integração com certificados e registro de evidências.
- **Gestão administrativa** de equipe, permissões e dados da clínica.

## Tecnologias

- Node.js e Express (backend, CommonJS)
- EJS, JavaScript e CSS (interface)
- PostgreSQL hospedado no Supabase
- Socket.IO para eventos em tempo real
- Render como opção de hospedagem, configurada em `render.yaml`

Consulte o [relatório completo do projeto](docs/relatorio-projeto.md) para arquitetura, funcionalidades, dados, integrações, configuração, implantação e pontos de atenção.

## Executar localmente

Pré-requisitos: Node.js compatível com as dependências do projeto e acesso a uma instância PostgreSQL/Supabase configurada.

1. Copie `.env.example` para `.env` e preencha as configurações necessárias. Não compartilhe nem versione o arquivo `.env`.
2. Instale as dependências:

   ```bash
   npm install
   ```

3. Inicie o servidor:

   ```bash
   npm run dev
   ```

4. Acesse `http://localhost:3000/medico/login`.

O schema inicial e as instruções de banco estão em [`supabase/schema.sql`](supabase/schema.sql) e [`supabase/deploy.md`](supabase/deploy.md). A disponibilidade de cada integração depende de credenciais e configuração próprias; consulte os documentos em [`docs/`](docs/).

## Scripts disponíveis

| Comando | Finalidade |
| --- | --- |
| `npm start` | Inicia o servidor |
| `npm run dev` | Inicia o servidor com Nodemon |
| `npm run compliance:export-audit` | Exporta registros de auditoria |
| `npm run compliance:verify-chain` | Verifica a cadeia de hashes da auditoria |
| `npm run compliance:monthly-report` | Gera relatório operacional mensal |
| `npm run test:lacuna` | Testa a conexão configurada com Lacuna Rest PKI |

O `package.json` não define atualmente um script geral de testes automatizados.

## Documentação

- [Relatório completo do projeto](docs/relatorio-projeto.md)
- [Evidências e controles de compliance](docs/compliance-evidencias.md)
- [Integração de certificados PSC](docs/integracao-certificados-psc.md)
- [Integração Lacuna Rest PKI](docs/lacuna-restpki-integration.md)
- [Orientações de deploy Supabase](supabase/deploy.md)

## Aviso de produção

Este software trata dados pessoais e informações de saúde. A presença de recursos técnicos de auditoria, consentimento ou assinatura não constitui certificação jurídica, clínica ou de segurança. Antes de usar com dados reais, revise controles de acesso, banco, armazenamento, backups, integrações, textos legais e obrigações regulatórias com profissionais responsáveis. Não use credenciais de demonstração em produção.
