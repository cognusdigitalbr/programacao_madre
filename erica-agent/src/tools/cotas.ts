import { supabaseErica } from '../services/supabase';
import { salvarCotaSelecionada, salvarCotaPreSelecionada } from '../services/session';
import type { CotaSelecionada } from '../types';

// Busca e seleciona cota direto no Supabase — sem depender do N8N
// codigoBolao: código único do bolão (ex: "MegaSena-090326-0902") — garante identificação sem ambiguidade
export async function toolBuscarEscolherCota(
  sessionId: string,
  codigoBolao: string,
  loteria: string,
  total_cotas: number,
  data_sorteio: string,
  valor_cota: number
): Promise<{ sucesso: boolean; cotas_disponiveis: number; cota?: CotaSelecionada }> {
  try {
    // Busca o bolão pelo código único — elimina ambiguidade de múltiplos bolões com mesma loteria/cotas
    const { data: boloes, error: errBolao } = await supabaseErica
      .from('boloes')
      .select('id, codigo')
      .eq('codigo', codigoBolao)
      .eq('status', 'ativo')
      .limit(1);

    if (errBolao || !boloes?.length) {
      console.error('[COTAS] Bolão não encontrado pelo código:', codigoBolao, errBolao?.message);
      return { sucesso: false, cotas_disponiveis: 0 };
    }

    const bolao = boloes[0];

    // Busca cotas disponíveis para este bolão
    const { data: cotas, error: errCotas } = await supabaseErica
      .from('cotas')
      .select('*')
      .eq('bolao_id', bolao.id)
      .eq('proprietario', 'erica')
      .eq('vendida', false)
      .eq('reservada', false);

    if (errCotas || !cotas?.length) {
      console.log(`[COTAS] Nenhuma cota disponível para ${loteria}`);
      return { sucesso: false, cotas_disponiveis: 0 };
    }

    const primeira = cotas[0];
    const cotaSelecionada: CotaSelecionada = {
      cota_id: primeira.id,
      bolao_id: bolao.id,
      numero: primeira.numero,
      loteria,
      total_cotas,
      data_sorteio,
      valor_cota
    };

    // Salva no mapa por código do bolão (permite múltiplos bilhetes sem sobrescrever)
    await salvarCotaPreSelecionada(sessionId, codigoBolao, cotaSelecionada);
    // Mantém cota_selecionada por compatibilidade
    await salvarCotaSelecionada(sessionId, cotaSelecionada);
    console.log(`[COTAS] Cota ${primeira.numero} pré-selecionada para ${loteria} (${codigoBolao}) — ${cotas.length} disponíveis`);
    return { sucesso: true, cotas_disponiveis: cotas.length, cota: cotaSelecionada };
  } catch (err: any) {
    console.error('[COTAS] Erro:', err.message);
    return { sucesso: false, cotas_disponiveis: 0 };
  }
}
