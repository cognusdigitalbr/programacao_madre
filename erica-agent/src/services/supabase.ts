import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

const URL = process.env.SUPABASE_URL!;
const KEY = process.env.SUPABASE_SERVICE_KEY!;

// Schema public
export const supabase = createClient(URL, KEY);

// Schema erica
export const supabaseErica = createClient(URL, KEY, { db: { schema: 'erica' } });

// ─── HISTÓRICO DE CHAT ────────────────────────────────────────────────────────

export async function getChatHistory(sessionId: string, limit = 30) {
  const { data } = await supabase
    .from('n8n_chat_histories')
    .select('*')
    .eq('session_id', sessionId)
    .order('id', { ascending: true })
    .limit(limit);
  return data || [];
}

export async function saveChatMessage(sessionId: string, type: 'human' | 'ai', content: string) {
  const { data, error } = await supabase.from('n8n_chat_histories').insert({
    session_id: sessionId,
    message: { type, content, additional_kwargs: {}, response_metadata: {} }
  }).select();
  if (error) console.error('[CHAT] Erro ao salvar mensagem:', JSON.stringify(error));
  else console.log('[CHAT] Salvo ok:', sessionId, type, data?.[0]?.id);
}

export async function clearChatHistory(sessionId: string) {
  await supabase.from('n8n_chat_histories').delete().eq('session_id', sessionId);
}

// ─── LEADS ────────────────────────────────────────────────────────────────────

export async function getLead(telefone: string) {
  const { data } = await supabase
    .from('leads_madre')
    .select('*')
    .eq('whatsapp', telefone)
    .maybeSingle();
  return data;
}

export async function upsertLead(telefone: string, nomewpp: string) {
  const existing = await getLead(telefone);
  if (!existing) {
    await supabase.from('leads_madre').insert({ whatsapp: telefone, nomewpp });
  }
}

export async function getLead_IA(telefone: string): Promise<string> {
  const lead = await getLead(telefone);
  return lead?.atendimento_ia || 'ativa';
}

export async function pausarIA(telefone: string) {
  await supabase.from('leads_madre').update({ atendimento_ia: 'pause' }).eq('whatsapp', telefone);
}

export async function reativarIA(telefone: string) {
  await supabase.from('leads_madre').update({ atendimento_ia: 'reativada' }).eq('whatsapp', telefone);
}

// ─── CLIENTES ─────────────────────────────────────────────────────────────────

export async function getClienteByTelefone(telefone: string) {
  const { data } = await supabaseErica
    .from('clientes')
    .select('*')
    .eq('telefone', telefone)
    .maybeSingle();
  return data;
}

export async function getClienteByCpf(cpf: string) {
  const cpfLimpo = cpf.replace(/\D/g, '');
  const { data } = await supabaseErica
    .from('clientes')
    .select('*')
    .eq('cpf', cpfLimpo)
    .maybeSingle();
  return data;
}

export async function criarCliente(nome: string, telefone: string, cpf: string) {
  const cpfLimpo = cpf.replace(/\D/g, '');
  const existente = await getClienteByCpf(cpfLimpo);
  if (existente) return existente;

  const { data } = await supabaseErica
    .from('clientes')
    .insert({ nome, telefone, cpf: cpfLimpo })
    .select()
    .single();
  return data;
}

export async function getUltimaLoteria(clienteId: string): Promise<string | null> {
  const { data } = await supabaseErica
    .from('pedidos')
    .select('bolao_id, boloes(codigo)')
    .eq('cliente_id', clienteId)
    .eq('status', 'finalizado')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data?.boloes) return null;
  const codigo = (data.boloes as any).codigo as string;
  // Extrai nome da loteria do codigo (ex: "MegaSena-161225-2955" → "Mega-Sena")
  const parte = codigo.split('-')[0];
  return parte || null;
}

// ─── BOLÕES ───────────────────────────────────────────────────────────────────

export async function getResultados() {
  const { data } = await supabase
    .from('resultados_loterias')
    .select('*')
    .order('valor_acumulado', { ascending: false });
  return data || [];
}

// Retorna o acumulado mais recente por loteria (mapa nome → valor)
export async function getAcumuladosPorLoteria(): Promise<Record<string, number>> {
  const { data } = await supabase
    .from('resultados_loterias')
    .select('loteria, valor_acumulado, created_at')
    .order('created_at', { ascending: false });

  if (!data) return {};

  const mapa: Record<string, number> = {};
  for (const r of data) {
    // Pega só o primeiro (mais recente) de cada loteria
    if (!(r.loteria in mapa)) {
      mapa[r.loteria] = r.valor_acumulado || 0;
    }
  }
  return mapa;
}

// ─── COTAS ────────────────────────────────────────────────────────────────────

export async function getCotaDisponivel(bolaoId: string) {
  const { data } = await supabaseErica
    .from('cotas')
    .select('*')
    .eq('bolao_id', bolaoId)
    .eq('proprietario', 'erica')
    .eq('vendida', false)
    .eq('reservada', false)
    .limit(1)
    .maybeSingle();
  return data;
}

export async function getCotasDisponiveis(bolaoId: string) {
  const { data } = await supabaseErica
    .from('cotas')
    .select('*')
    .eq('bolao_id', bolaoId)
    .eq('proprietario', 'erica')
    .eq('vendida', false)
    .eq('reservada', false);
  return data || [];
}

export async function reservarCota(cotaId: string) {
  await supabaseErica.from('cotas').update({ reservada: true }).eq('id', cotaId);
}

export async function liberarCota(cotaId: string) {
  await supabaseErica.from('cotas').update({ reservada: false }).eq('id', cotaId);
}

export async function marcarCotaVendida(cotaId: string) {
  await supabaseErica.from('cotas').update({ vendida: true, reservada: false }).eq('id', cotaId);
}

// ─── PEDIDOS ──────────────────────────────────────────────────────────────────

export async function criarPedido(bolaoId: string, clienteId: string) {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts = `${String(now.getFullYear()).slice(2)}${pad(now.getMonth()+1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  const codigo = `PED-${ts}${rand}`;

  const { data } = await supabaseErica
    .from('pedidos')
    .insert({ bolao_id: bolaoId, cliente_id: clienteId, codigo, status: 'aguardando_pagamento' })
    .select()
    .single();
  return data;
}

export async function criarPedidoCota(pedidoId: string, cotaId: string, numeroCota: number) {
  await supabaseErica.from('pedido_cotas').insert({
    pedido_id: pedidoId,
    cota_id: cotaId,
    numero_cota: numeroCota
  });
}

export async function atualizarStatusPedido(pedidoId: string, status: string) {
  await supabaseErica.from('pedidos').update({ status }).eq('id', pedidoId);
}

// Verifica se há pedidos pendentes com sorteio ainda no futuro
// Retorna: valido=true se ainda tem reserva ativa, itens com o resumo do que está pendente
export async function verificarReservasPendentes(pedidosIds: string[]): Promise<{
  valido: boolean;
  itens: Array<{ loteria: string; data_sorteio: string; valor: number }>;
}> {
  if (!pedidosIds?.length) return { valido: false, itens: [] };

  const hoje = new Date().toISOString().split('T')[0]; // YYYY-MM-DD no fuso local

  const { data } = await supabaseErica
    .from('pedidos')
    .select('id, status, boloes(codigo, data_sorteio, valor_cota)')
    .in('id', pedidosIds)
    .eq('status', 'aguardando_pagamento');

  if (!data || data.length === 0) return { valido: false, itens: [] };

  // Só reservas cujo sorteio ainda não aconteceu
  const validos = data.filter(p => {
    const dataSorteio = (p.boloes as any)?.data_sorteio;
    return dataSorteio && dataSorteio >= hoje;
  });

  const itens = validos.map(p => ({
    loteria: (p.boloes as any)?.codigo?.split('-')[0] || 'Bolão',
    data_sorteio: (p.boloes as any)?.data_sorteio || '',
    valor: Number((p.boloes as any)?.valor_cota || 0),
  }));

  return { valido: validos.length > 0, itens };
}

export async function getBolaoById(bolaoId: string) {
  const { data } = await supabaseErica
    .from('boloes')
    .select('*')
    .eq('id', bolaoId)
    .maybeSingle();
  return data;
}
