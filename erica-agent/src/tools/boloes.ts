import { supabaseErica } from '../services/supabase';
import type { Bolao } from '../types';

// Busca bolões disponíveis direto no Supabase — sem depender do N8N
// Retorna apenas bolões com status 'ativo' E que tenham pelo menos 1 cota da Érica disponível
export async function toolBuscarBoloes(): Promise<Bolao[]> {
  try {
    // Hoje no fuso de Brasília — filtra bolões com data_sorteio >= hoje
    const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

    // 1. Busca IDs dos bolões que têm pelo menos 1 cota disponível para a Érica
    const { data: cotasDisp, error: errCotas } = await supabaseErica
      .from('cotas')
      .select('bolao_id')
      .eq('proprietario', 'erica')
      .eq('vendida', false)
      .eq('reservada', false);

    if (errCotas) {
      console.error('[BOLOES] Erro ao buscar cotas:', errCotas.message);
      return [];
    }

    // IDs únicos de bolões com cota disponível
    const bolaoIdsComCota = [...new Set((cotasDisp || []).map((c: any) => c.bolao_id))];

    if (bolaoIdsComCota.length === 0) {
      console.log('[BOLOES] Nenhuma cota da Érica disponível no momento');
      return [];
    }

    // Hora atual em Brasília — vendas encerram às 17h no dia do sorteio
    const horaAtual = parseInt(new Intl.DateTimeFormat('pt-BR', { hour: 'numeric', hour12: false, timeZone: 'America/Sao_Paulo' }).format(new Date()), 10);
    const vendaEncerrada = horaAtual >= 17;

    // Antes das 17h: inclui bolões do dia (>= hoje) | A partir das 17h: exclui o dia (> hoje)
    const filtroData = vendaEncerrada ? 'gt' : 'gte';
    console.log(`[BOLOES] Hora Brasília: ${horaAtual}h — filtro data_sorteio ${filtroData} ${hoje}`);

    const { data, error } = await supabaseErica
      .from('boloes')
      .select('*, loterias(nome)')
      .eq('status', 'ativo')
      [filtroData]('data_sorteio', hoje)
      .in('id', bolaoIdsComCota)
      .order('data_sorteio', { ascending: true })
      .order('valor_cota', { ascending: true });

    if (error) {
      console.error('[BOLOES] Erro Supabase:', error.message);
      return [];
    }

    const boloes: Bolao[] = (data || []).map((b: any) => ({
      nome: b.loterias?.nome || b.codigo.split('-')[0],
      cotas: b.total_cotas,
      valor: `R$ ${b.valor_cota.toFixed(2).replace('.', ',')}`,
      valor_numero: b.valor_cota,
      data_sorteio: b.data_sorteio,
      codigo: b.codigo,
      quantidade_jogos: Array.isArray(b.jogos) ? b.jogos.length : 0,
      jogos: Array.isArray(b.jogos) ? b.jogos : [],
      status: b.status
    }));

    console.log(`[BOLOES] ${boloes.length} bolões com cotas disponíveis (de ${bolaoIdsComCota.length} com cota, filtrado por data >= ${hoje})`);
    return boloes;
  } catch (err: any) {
    console.error('[BOLOES] Erro:', err.message);
    return [];
  }
}
