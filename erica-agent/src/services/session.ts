import { supabaseErica } from './supabase';
import type { SessaoErica, CotaSelecionada, BolaoConfirmado, DadosCliente, Bolao } from '../types';

// Cache em memória para cotas pré-selecionadas por sessão
// (não precisa persistir no banco — é transiente dentro de uma conversa)
const cotasPreSelecionadasCache = new Map<string, Record<string, CotaSelecionada>>();

// Cache em memória para loterias já listadas e último bilhete mostrado
// (colunas ainda não existem no banco — mantidas em RAM por enquanto)
const loteriasListadasCache = new Map<string, string[]>();
const ultimoBilheteMostradoCache = new Map<string, string | null>();

// Cache do mapa posição→código da última lista enviada (ex: {"1":"MEGA-ABC","6":"MEGA-XYZ"})
// Permite detectar server-side qual bolão o cliente escolheu pelo número
const mapaListaCache = new Map<string, Record<string, string>>();

const SESSAO_PADRAO: Omit<SessaoErica, 'session_id' | 'ultima_atividade'> = {
  fase: 'abertura',
  cota_selecionada: null,
  cotas_pre_selecionadas: {},
  boloes_confirmados: [],
  boloes_oferecidos: [],
  boloes_disponiveis: [],
  loterias_listadas: [],
  ultimo_bilhete_mostrado: null,
  dados_cliente: null,
  pedidos_ids: []
};

export async function getSessao(sessionId: string): Promise<SessaoErica> {
  const { data } = await supabaseErica
    .from('erica_sessoes')
    .select('*')
    .eq('session_id', sessionId)
    .maybeSingle();

  if (!data) {
    return {
      session_id: sessionId,
      ...SESSAO_PADRAO,
      ultima_atividade: new Date().toISOString()
    };
  }

  return {
    session_id: data.session_id,
    fase: data.fase || 'abertura',
    cota_selecionada: data.cota_selecionada || null,
    // Mescla cache em memória (não está no banco)
    cotas_pre_selecionadas: cotasPreSelecionadasCache.get(data.session_id) || {},
    boloes_confirmados: data.boloes_confirmados || [],
    boloes_oferecidos: data.boloes_oferecidos || [],
    boloes_disponiveis: data.boloes_disponiveis || [],
    loterias_listadas: loteriasListadasCache.get(data.session_id) || [],
    ultimo_bilhete_mostrado: ultimoBilheteMostradoCache.get(data.session_id) || null,
    dados_cliente: data.dados_cliente || null,
    pedidos_ids: data.pedidos_ids || [],
    ultima_atividade: data.ultima_atividade
  };
}

export async function saveSessao(sessao: SessaoErica): Promise<void> {
  // Não inclui cotas_pre_selecionadas — coluna não existe no banco, é mantida em memória
  const { error } = await supabaseErica.from('erica_sessoes').upsert({
    session_id: sessao.session_id,
    fase: sessao.fase,
    cota_selecionada: sessao.cota_selecionada,
    boloes_confirmados: sessao.boloes_confirmados,
    boloes_oferecidos: sessao.boloes_oferecidos,
    boloes_disponiveis: sessao.boloes_disponiveis,
    // loterias_listadas e ultimo_bilhete_mostrado ficam em cache — colunas não existem no banco
    dados_cliente: sessao.dados_cliente,
    pedidos_ids: sessao.pedidos_ids,
    ultima_atividade: new Date().toISOString()
  }, { onConflict: 'session_id' });

  if (error) {
    console.error('[SESSION] Erro ao salvar sessão:', error.message);
  }
}

export async function salvarBoloesDisponiveis(sessionId: string, boloes: Bolao[]): Promise<void> {
  const sessao = await getSessao(sessionId);
  sessao.boloes_disponiveis = boloes;
  await saveSessao(sessao);
}

export async function atualizarFase(sessionId: string, fase: SessaoErica['fase']): Promise<void> {
  const sessao = await getSessao(sessionId);
  sessao.fase = fase;
  await saveSessao(sessao);
}

export async function salvarCotaSelecionada(sessionId: string, cota: CotaSelecionada): Promise<void> {
  const sessao = await getSessao(sessionId);
  sessao.cota_selecionada = cota;
  await saveSessao(sessao);
}

// Salva cota no cache em memória — permite o cliente ver vários bilhetes antes de confirmar qualquer um
export async function salvarCotaPreSelecionada(sessionId: string, codigoBolao: string, cota: CotaSelecionada): Promise<void> {
  const mapa = cotasPreSelecionadasCache.get(sessionId) || {};
  mapa[codigoBolao] = cota;
  cotasPreSelecionadasCache.set(sessionId, mapa);
  console.log(`[SESSION] Cota pré-selecionada salva em cache: ${codigoBolao} | Total no mapa: ${Object.keys(mapa).length}`);
}

// Limpa o cache de cotas pré-selecionadas (chamado ao resetar sessão)
export function limparCotasPreSelecionadas(sessionId: string): void {
  cotasPreSelecionadasCache.delete(sessionId);
  loteriasListadasCache.delete(sessionId);
  ultimoBilheteMostradoCache.delete(sessionId);
  mapaListaCache.delete(sessionId);
}

// Salva o mapa posição→código da lista enviada — usado para detectar escolha por número
export function salvarMapaLista(sessionId: string, mapa: Record<string, string>): void {
  mapaListaCache.set(sessionId, mapa);
}

// Retorna o mapa posição→código (ou null se não houver lista ativa)
export function getMapaLista(sessionId: string): Record<string, string> | null {
  return mapaListaCache.get(sessionId) || null;
}

// Salva o último bilhete mostrado no cache em memória
export function salvarUltimoBilhete(sessionId: string, codigo: string): void {
  ultimoBilheteMostradoCache.set(sessionId, codigo);
}

// Retorna loterias já listadas nesta sessão
export function getLoteriasListadas(sessionId: string): string[] {
  return loteriasListadasCache.get(sessionId) || [];
}

export async function confirmarBolao(sessionId: string, bolao: BolaoConfirmado): Promise<void> {
  const sessao = await getSessao(sessionId);
  sessao.boloes_confirmados.push(bolao);
  await saveSessao(sessao);
}

export async function marcarLoteiraListada(sessionId: string, loteria: string): Promise<void> {
  const lista = loteriasListadasCache.get(sessionId) || [];
  const nome = loteria.toLowerCase();
  if (!lista.map(l => l.toLowerCase()).includes(nome)) {
    lista.push(loteria);
    loteriasListadasCache.set(sessionId, lista);
  }
}

export async function marcarBolaoOferecido(sessionId: string, loteria: string): Promise<void> {
  const sessao = await getSessao(sessionId);
  if (!sessao.boloes_oferecidos.includes(loteria)) {
    sessao.boloes_oferecidos.push(loteria);
  }
  await saveSessao(sessao);
}

export async function salvarDadosCliente(sessionId: string, dados: DadosCliente): Promise<void> {
  const sessao = await getSessao(sessionId);
  sessao.dados_cliente = dados;
  await saveSessao(sessao);
}

export async function adicionarPedidoId(sessionId: string, pedidoId: string): Promise<void> {
  const sessao = await getSessao(sessionId);
  sessao.pedidos_ids.push(pedidoId);
  await saveSessao(sessao);
}

// Transiciona para fase fechamento — dispara revisão do carrinho e coleta de dados
export async function irParaFechamento(sessionId: string): Promise<void> {
  const sessao = await getSessao(sessionId);
  sessao.fase = 'fechamento';
  sessao.dados_cliente = null; // coleta sempre fresca
  await saveSessao(sessao);
}

// Esvazia o carrinho mantendo a sessão ativa (histórico, boloes_disponiveis, fase volta a venda)
export async function limparCarrinho(sessionId: string): Promise<void> {
  const sessao = await getSessao(sessionId);
  sessao.boloes_confirmados = [];
  sessao.boloes_oferecidos = [];
  sessao.loterias_listadas = [];
  sessao.ultimo_bilhete_mostrado = null;
  sessao.dados_cliente = null;
  sessao.fase = 'venda';
  limparCotasPreSelecionadas(sessionId);
  await saveSessao(sessao);
}

export async function resetarSessao(sessionId: string): Promise<void> {
  await supabaseErica.from('erica_sessoes').delete().eq('session_id', sessionId);
  limparCotasPreSelecionadas(sessionId);
}
