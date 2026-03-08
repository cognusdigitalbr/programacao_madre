import { supabaseErica } from '../services/supabase';
import type { Bolao } from '../types';

// Busca bolões disponíveis direto no Supabase — sem depender do N8N
export async function toolBuscarBoloes(dataSorteio: string): Promise<Bolao[]> {
  try {
    const { data, error } = await supabaseErica
      .from('boloes')
      .select('*, loterias(nome)')
      .eq('data_sorteio', dataSorteio)
      .eq('status', 'ativo')
      .order('created_at', { ascending: true });

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

    console.log(`[BOLOES] ${boloes.length} bolões encontrados para ${dataSorteio}`);
    return boloes;
  } catch (err: any) {
    console.error('[BOLOES] Erro:', err.message);
    return [];
  }
}
