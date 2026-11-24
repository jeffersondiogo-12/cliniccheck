const { Pool } = require('pg');
const dns = require('dns');

dns.setDefaultResultOrder('ipv4first');

if (!process.env.SUPABASE_DB_URL) {
  throw new Error('SUPABASE_DB_URL nao configurada no ambiente');
}

const pool = new Pool({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
});

// ESSENCIAL: sem este listener, um erro de fundo num client OCIOSO do pool
// (ex: ECONNRESET da Supabase/pgbouncer derrubando uma conexão parada)
// vira uma excecao nao tratada e derruba o processo Node inteiro. Com o
// listener, o pool so descarta o client com problema e segue funcionando.
pool.on('error', (err) => {
  console.error('[db] Erro inesperado numa conexao ociosa do pool (nao derrubou o servidor):', err.message);
});

function isTransientConnectionError(err) {
  return err && (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'EPIPE' || err.code === '57P01');
}

async function query(text, params = []) {
  try {
    return await pool.query(text, params);
  } catch (err) {
    // Reset/timeout de conexao pooled costuma ser transitorio — uma unica
    // nova tentativa evita propagar um erro passageiro pra quem chamou.
    if (isTransientConnectionError(err)) {
      console.warn('[db] Conexao resetada, tentando novamente uma vez:', err.message);
      return await pool.query(text, params);
    }
    throw err;
  }
}

module.exports = { query, pool };
