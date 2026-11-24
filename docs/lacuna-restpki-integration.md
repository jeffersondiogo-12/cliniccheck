# Integração Lacuna Software Rest PKI

Este projeto está integrado com a plataforma **Lacuna Software Rest PKI** para assinatura digital profissional de documentos médicos (receitas, atestados, prontuários) com validade jurídica ICP-Brasil.

## Configuração Inicial

### 1. Obtenha o Token de Acesso
- Acesse [https://pki.rest/](https://pki.rest/)
- Registre sua conta (recomenda-se usar email corporativo)
- Gere um token de acesso na seção "Tokens"
- **Importante**: Guarde o token em lugar seguro

### 2. Configure no Projeto
Adicione ao arquivo `.env` na raiz do projeto:

```bash
LACUNA_RESTPKI_ENDPOINT=https://pki.rest/
LACUNA_RESTPKI_TOKEN=seu_token_aqui
```

### 3. Teste a Conexão
```bash
npm run test:lacuna
```

Resultado esperado:
```
✅ Sucesso! Conexão estabelecida com Lacuna Rest PKI
📦 Versão: X.X.X
✨ Seu sistema está pronto para assinar documentos médicos!
```

## Rotas Disponíveis

Todas requerem autenticação de médico (JWT token via header `Authorization: Bearer <token>`).

### 1. Health Check
```
GET /api/lacuna/health
Resposta: { status: 'ok', version: 'X.X.X' }
```

### 2. Iniciar Assinatura
```
POST /api/lacuna/initiate
Corpo:
{
  "pdfPath": "/caminho/para/documento.pdf",
  "signerName": "Dr. Fulano (opcional)",
  "signerEmail": "fulano@example.com (opcional)"
}

Resposta:
{
  "transferFile": "...",
  "toSignHash": "...",
  "digestAlgorithm": "SHA256"
}
```

### 3. Completar Assinatura
```
POST /api/lacuna/complete
Corpo:
{
  "transferFile": "...",
  "signature": "..." (hash assinado pelo certificado do médico)
}

Resposta:
{
  "signedPdfPath": "/caminho/para/documento_assinado.pdf",
  "signerCertificate": "...",
  "signatureInfo": { ... }
}
```

### 4. Verificar Assinatura
```
POST /api/lacuna/verify
Corpo:
{
  "pdfPath": "/caminho/para/documento.pdf"
}

Resposta:
{
  "isValid": true,
  "signerNames": ["Dr. Fulano"],
  "signingTimes": ["2026-04-29T10:30:00Z"],
  "certificateCount": 1
}
```

### 5. Hash de PDF (para assinatura remota)
```
POST /api/lacuna/hash
Corpo:
{
  "pdfPath": "/caminho/para/documento.pdf"
}

Resposta:
{
  "pdfHash": "abc123...",
  "algorithm": "SHA256",
  "pdfSize": 45000
}
```

## Fluxo de Assinatura no Sistema Clínico

### Fluxo Típico:
1. **Geração do documento** → Frontend gera PDF
2. **Médico autoriza** → Clica "Assinar com Certificado"
3. **Backend inicia** → `POST /api/lacuna/initiate`
4. **Médico assina** → Usa seu certificado (em nuvem ou token)
5. **Backend completa** → `POST /api/lacuna/complete`
6. **Documento validado** → Armazenado com prova criptográfica

## Integração no Portal de Assinatura

O fluxo de assinatura do paciente (`/assinatura/:token`) pode ser estendido para:

```javascript
// Exemplo de integração no portalRoutes.js

// 1. Após a assinatura do paciente (facial + confirmações):
const pdfBuffer = await generateDocumentPDF(documentId);
const pdfPath = '/tmp/doc.pdf';
fs.writeFileSync(pdfPath, pdfBuffer);

// 2. Inicia assinatura do médico via Lacuna:
const signatureStart = await lacunaService.initiatePdfSignature({
  pdfPath,
  signerName: doctor.name,
  signerEmail: doctor.email
});

// 3. Armazena `transferFile` na sessão/banco
await saveDoctorSignatureSession(documentId, signatureStart.transferFile);

// 4. Frontend apresenta QR Code ou PIN para médico assinar no celular
// (fluxo remoto da Lacuna)

// 5. Backend recebe callback e completa:
const signed = await lacunaService.completePdfSignature({
  transferFile: session.transferFile,
  signature: signatureFromDoctor
});

// 6. Salva PDF assinado na trilha de auditoria
```

## Segurança e Conformidade

✅ **O que é garantido:**
- Assinatura com certificado ICP-Brasil (validade jurídica plena)
- Hash do PDF armazenado na auditoria
- Timestamp oficial de Lacuna
- Não-repúdio (médico não pode negar assinatura)
- Compatibilidade com softwares de validação de assinatura

⚠️ **O que você deve complementar:**
- Backup imutável dos PDFs assinados (Object Lock/WORM)
- Retenção jurídica (mínimo 20 anos)
- Acesso restrito ao banco e armazenamento
- Monitoramento de acesso e alterações
- Testes de restauração mensais com evidência

## Custo

- **Desenvolvimento/Teste**: Acesso gratuito ao Sandbox da Lacuna
- **Produção**: Baseado em número de assinaturas/certificados (consulte Lacuna para preço)
- **Esta implementação**: Código aberto, sem royalties

## Troubleshooting

### ❌ "LACUNA_RESTPKI_TOKEN não configurado"
```
Solução: Adicione o token ao arquivo .env na raiz do projeto
```

### ❌ "Token inválido"
```
Solução: Copie novamente o token do painel Lacuna (sem espaços)
```

### ❌ "PDF não encontrado"
```
Solução: Use caminho absoluto para o arquivo PDF
```

### ❌ "Conexão recusada"
```
Solução: Verifique conectividade com https://pki.rest/
Ou tente usar um proxy se estiver atrás de firewall corporativo
```

## Próximas Etapas Recomendadas

1. Testar fluxo completo de assinatura no Sandbox
2. Configurar armazenamento imutável para PDFs assinados
3. Criar webhooks para notificações de assinatura
4. Implementar auditoria de tentativas de verificação
5. Treinar médicos sobre o fluxo mobile de assinatura

## Referências

- **Lacuna Software**: https://pki.rest/
- **Documentação**: https://docs.lacunasoftware.com/
- **ICP-Brasil**: https://www.gov.br/cidadania/pt-br/acesso-a-informacao/lgpd
- **Resolução CFM 2296/2021**: Telemedicina

## Suporte

Para dúvidas sobre a integração, consulte:
- Documentação Lacuna: https://docs.lacunasoftware.com/
- Suporte Lacuna: https://pki.rest/support
- Issues do projeto: (criar issue no repositório)
