/**
 * Script: atualizar-resultados.ts
 * Busca os resultados mais recentes de cada loteria na API da Caixa
 * e salva na tabela resultados_loterias no Supabase.
 * Executar diariamente às 06h00 via cron na VPS.
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

// Loterias disponíveis na API da Caixa
// Nota: LOTECA removida — API retorna 404 consistentemente (não suportada)
const LOTERIAS = [
  { slug: 'megasena',       nome: 'MEGA-SENA' },
  { slug: 'lotofacil',      nome: 'LOTOFÁCIL' },
  { slug: 'quina',          nome: 'QUINA' },
  { slug: 'lotomania',      nome: 'LOTOMANIA' },
  { slug: 'duplasena',      nome: 'DUPLASENA' },
  { slug: 'timemania',      nome: 'TIMEMANIA' },
  { slug: 'supersete',      nome: 'SUPER SETE' },
  { slug: 'diadesorte',     nome: 'DIA DE SORTE' },
  { slug: 'maismilionaria', nome: '+MILIONÁRIA' },
];

// API espelho — a Caixa bloqueia requisições de servidor
const API_BASE = 'https://loteriascaixa-api.herokuapp.com/api';

// Converte data "DD/MM/YYYY" para "YYYY-MM-DD"
function converterData(data: string): string {
  const [dia, mes, ano] = data.split('/');
  return `${ano}-${mes}-${dia}`;
}

async function buscarLoteria(slug: string): Promise<any> {
  const url = `${API_BASE}/${slug}/latest`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} para ${slug}`);
  return res.json();
}

async function limparTabela(): Promise<void> {
  // Deleta todos os registros existentes antes de inserir os novos
  const { error } = await supabase
    .from('resultados_loterias')
    .delete()
    .neq('id', 0); // condição sempre verdadeira para deletar tudo
  if (error) throw new Error(`Erro ao limpar tabela: ${error.message}`);
}

async function salvarResultado(nome: string, dados: any): Promise<void> {
  const concurso = String(dados.concurso);
  const data_sorteio = converterData(dados.data);
  const acumulou = dados.acumulou === true;

  // Valor acumulado para o próximo concurso (o que mostramos ao cliente)
  const valor_acumulado = dados.valorAcumuladoProximoConcurso || dados.valorEstimadoProximoConcurso || null;

  // Números sorteados
  const numeros = dados.dezenas || [];
  const numeros_sorteados = JSON.stringify(numeros);

  // Sempre insere — tabela foi limpa no início do script
  const { error } = await supabase
    .from('resultados_loterias')
    .insert({ loteria: nome, concurso, data_sorteio, valor_acumulado, numeros_sorteados, acumulou });
  if (error) throw new Error(`Erro ao inserir ${nome}: ${error.message}`);
}

async function main() {
  const inicio = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  console.log(`\n[${inicio}] Iniciando atualização de resultados...\n`);

  // Limpa todos os registros anteriores antes de buscar os novos
  console.log('🗑️  Limpando registros anteriores...');
  await limparTabela();
  console.log('✅ Tabela limpa. Buscando dados atualizados...\n');

  let ok = 0;
  let falhas = 0;

  for (const { slug, nome } of LOTERIAS) {
    try {
      const dados = await buscarLoteria(slug);
      await salvarResultado(nome, dados);
      const valor = dados.valorAcumuladoProximoConcurso || dados.valorEstimadoProximoConcurso || 0;
      console.log(`✅ ${nome} — concurso ${dados.concurso} | próximo prêmio: R$ ${valor.toLocaleString('pt-BR')}`);
      ok++;
    } catch (err: any) {
      console.error(`❌ ${nome} — ${err.message}`);
      falhas++;
    }

    // Pausa entre requisições para não sobrecarregar a API da Caixa
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`\nConcluído: ${ok} atualizadas, ${falhas} falhas.`);
  // Sai com 0 mesmo se algumas loterias falharem individualmente (ex: API instável)
  // Assim o cron não gera alarme falso — as falhas ficam registradas no log
  process.exit(0);
}

main().catch(err => {
  console.error('Erro fatal:', err.message);
  process.exit(1);
});
