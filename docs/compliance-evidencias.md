# Compliance de Consentimento Cirúrgico

Este documento descreve controles implementados no sistema e pontos que exigem validação externa.

## Controles técnicos implementados
- Hash SHA-256 do conteúdo HTML do consentimento (`content_hash`).
- Hash SHA-256 do PDF gerado e do PDF no momento da assinatura (`pdf_hash_generated`, `pdf_hash_signed`).
- Auditoria encadeada por hash em eventos (`prev_event_hash`, `event_hash`).
- Log append-only em `signature_audit_logs` com trigger que bloqueia `UPDATE` e `DELETE`.
- Registro de IP e User-Agent na assinatura.
- Captura de versão de política LGPD e versão de termos jurídicos no momento da assinatura.
- Suporte a carimbo de tempo de terceiro via integração (`TSA_ENDPOINT`).
- Suporte a assinatura qualificada via integração externa (`QUALIFIED_SIGNATURE_ENDPOINT`).

## Variáveis de ambiente opcionais
- `TSA_ENDPOINT`
- `TSA_API_KEY`
- `QUALIFIED_SIGNATURE_ENDPOINT`
- `QUALIFIED_SIGNATURE_API_KEY`
- `REQUIRE_QUALIFIED_SIGNATURE=true` para bloquear assinatura sem provedor qualificado.
- `CRITICAL_PROCEDURE_TYPES` para classificar automaticamente procedimentos críticos.
- `COMPLIANCE_ALERT_WEBHOOK` para alertas automáticos de quebra de cadeia.

## Classificação Crítico x Não Crítico
- Implementado no código via `backend/src/services/compliancePolicyService.js`.
- Critério: compara `procedure_type` e `title` com termos críticos configuráveis.
- Efeito: procedimento crítico exige assinatura qualificada automaticamente.

## Checklist Aplicado
- [x] Hash do HTML e hash do PDF (geração e assinatura).
- [x] Trilha de auditoria encadeada por hash.
- [x] Log append-only com bloqueio de UPDATE/DELETE.
- [x] Captura de versão LGPD e versão do termo jurídico.
- [x] Exigência de assinatura qualificada para procedimento crítico.
- [x] Scripts operacionais de compliance:
	- `npm run compliance:export-audit`
	- `npm run compliance:verify-chain`
	- `npm run compliance:monthly-report`

## Checklist Operacional (Ponto 2 e 3)

### 2) Assinatura avançada/qualificada (ICP-Brasil)
- [ ] Contratar provedor ICP-Brasil com API.
- [ ] Configurar `QUALIFIED_SIGNATURE_ENDPOINT` e `QUALIFIED_SIGNATURE_API_KEY`.
- [ ] Definir `REQUIRE_QUALIFIED_SIGNATURE=true` em produção para fluxos críticos.
- [ ] Homologar retorno de protocolo/transação no banco.

### 3) Imutabilidade, WORM, backup e monitoramento
- [ ] Agendar export diário de auditoria para bucket com Object Lock (modo Compliance).
- [ ] Definir retenção jurídica mínima (ex.: 20 anos) com assessoria jurídica.
- [ ] Ativar backup diário automático com cópia offsite imutável.
- [ ] Executar teste de restauração mensal e registrar evidência documental.
- [ ] Separar papéis de acesso no banco (aplicação, auditoria, administração).
- [ ] Executar job diário `compliance:verify-chain` com alerta automático.
- [ ] Gerar relatório mensal via `compliance:monthly-report` e assinar internamente.

## Ponto jurídico obrigatório (fora do código)
- O texto de consentimento, riscos e política LGPD deve ser revisado e aprovado por advogado especialista em saúde.
- Definir oficialmente as versões jurídicas usadas em produção (ex.: `2026-04`).

## WORM e retenção
- O banco está append-only para `signature_audit_logs`, mas retenção e backup imutável devem ser configurados na infraestrutura.
- Recomenda-se política de backup com cópias invioláveis e retenção mínima definida pela assessoria jurídica.
