# Integração de Certificado ICP-Brasil (CFM/PSC) e TSA

Este projeto já está preparado para consumir certificado em nuvem do médico (modelo PSC), sem armazenar arquivo A1/A3 no banco.

## O que foi implementado
- Tabela `doctor_certificates` para vínculo por médico.
- OAuth2 para conexão do certificado do médico.
- Criptografia de `access_token` e `refresh_token` no banco.
- Uso automático do token do médico ao solicitar assinatura qualificada.
- Fallback para `QUALIFIED_SIGNATURE_API_KEY` quando não houver token vinculado.
- Integração TSA já existente e suporte a mock com `TSA_MOCK_MODE=true`.

## Rotas novas
- `GET /api/certificates/me` (autenticado médico): status da conexão.
- `GET /api/certificates/connect?provider=VIDAAS_CFM` (autenticado médico): retorna URL OAuth2 do provedor.
- `GET /api/certificates/callback` (redirect do provedor): salva tokens e conclui vínculo.

## Variáveis de ambiente
- `PSC_PROVIDER_NAME`
- `PSC_OAUTH_AUTHORIZE_URL`
- `PSC_OAUTH_TOKEN_URL`
- `PSC_CLIENT_ID`
- `PSC_CLIENT_SECRET`
- `PSC_REDIRECT_URI` (deve apontar para `/api/certificates/callback`)
- `PSC_OAUTH_SCOPE`
- `CERT_TOKEN_ENCRYPTION_KEY`
- `QUALIFIED_SIGNATURE_ENDPOINT`
- `QUALIFIED_SIGNATURE_API_KEY` (fallback opcional)
- `QUALIFIED_SIGNATURE_PROFILE`
- `TSA_ENDPOINT`
- `TSA_API_KEY`
- `TSA_MOCK_MODE=true` para ambiente de teste gratuito

## Fluxo de uso
1. Médico autenticado chama `GET /api/certificates/connect`.
2. Frontend redireciona para `connectUrl` recebida.
3. Provedor retorna em `GET /api/certificates/callback?code=...&state=...`.
4. Tokens ficam salvos em `doctor_certificates`.
5. Na assinatura de documento crítico, o backend usa o token do médico para assinatura qualificada.

## Observação importante
Para ambiente gratuito, use sandbox do provedor PSC e TSA mock quando permitido. Em produção jurídica, utilize endpoint oficial real de TSA e PSC ICP-Brasil.