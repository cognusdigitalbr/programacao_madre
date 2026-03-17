import {
  getClienteByTelefone,
  criarCliente,
  supabaseErica,
  criarPedido,
  criarPedidoCota,
  marcarCotaVendida
} from '../services/supabase';
import { getSessao, adicionarPedidoId, atualizarFase, salvarDadosCliente } from '../services/session';

const PIX_CHAVE = 'lotericamadre@gmail.com';
const PIX_NOME = 'Lotérica da Madre';

export function validarCPF(cpf: string): boolean {
  const limpo = cpf.replace(/\D/g, '');
  if (limpo.length !== 11 || /^(\d)\1{10}$/.test(limpo)) return false;

  let soma = 0;
  for (let i = 0; i < 9; i++) soma += parseInt(limpo[i]) * (10 - i);
  let resto = (soma * 10) % 11;
  if (resto === 10 || resto === 11) resto = 0;
  if (resto !== parseInt(limpo[9])) return false;

  soma = 0;
  for (let i = 0; i < 10; i++) soma += parseInt(limpo[i]) * (11 - i);
  resto = (soma * 10) % 11;
  if (resto === 10 || resto === 11) resto = 0;
  return resto === parseInt(limpo[10]);
}

export async function toolFazerReservas(
  sessionId: string,
  nome: string,
  cpf: string,
  telefone: string
): Promise<{ sucesso: boolean; mensagem: string; pix?: string }> {
  try {
    // 1. Valida CPF
    if (!validarCPF(cpf)) {
      // Salva nome e telefone na sessão para não pedir de novo — só o CPF está errado
      await salvarDadosCliente(sessionId, { nome, cpf: '', telefone });
      return { sucesso: false, mensagem: 'CPF inválido. Por favor, me mande apenas o CPF correto.' };
    }

    // 2. Busca sessão — tudo vem do Supabase
    const sessao = await getSessao(sessionId);

    if (!sessao.boloes_confirmados.length) {
      return { sucesso: false, mensagem: 'Nenhum bolão confirmado na sessão.' };
    }

    // 3. Verifica/cria cliente
    let cliente = await getClienteByTelefone(telefone);
    if (!cliente) {
      cliente = await criarCliente(nome, telefone, cpf);
    }

    if (!cliente) {
      return { sucesso: false, mensagem: 'Erro ao registrar cliente.' };
    }

    // 4. Cria pedido + pedido_cotas para cada bolão confirmado
    const pedidosIds: string[] = [];

    for (const bolao of sessao.boloes_confirmados) {
      // Usa bolao_id salvo na sessão — busca direta, sem ambiguidade
      if (!bolao.bolao_id) {
        console.error(`[RESERVA] bolao_id ausente para: ${bolao.loteria}`);
        continue;
      }

      const pedido = await criarPedido(bolao.bolao_id, cliente.id);
      if (!pedido) continue;

      await criarPedidoCota(pedido.id, bolao.cota_id, bolao.cota_numero);
      await marcarCotaVendida(bolao.cota_id);

      pedidosIds.push(pedido.id);
      await adicionarPedidoId(sessionId, pedido.id);
    }

    // 5. Atualiza fase
    await atualizarFase(sessionId, 'aguardando_pagamento');

    const totalValor = sessao.boloes_confirmados.reduce((s, b) => s + Number(b.valor_cota), 0);
    const totalFormatado = totalValor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

    // Lista das cotas reservadas — garante que a IA transmite exatamente o que foi reservado
    const listaCotas = sessao.boloes_confirmados
      .map(b => `• ${b.loteria} — R$ ${Number(b.valor_cota).toFixed(2).replace('.', ',')}`)
      .join('\n');

    console.log(`[RESERVA] Cotas reservadas:\n${listaCotas}\nTotal: ${totalFormatado}`);

    const pixMsg = `✅ *Suas cotas estão reservadas!*\n\n${listaCotas}\n\n💰 *Total: ${totalFormatado}*\n\n💳 *Pagamento via PIX:*\n🔑 Chave: ${PIX_CHAVE}\n👤 ${PIX_NOME}\n\nMe manda o comprovante quando pagar! 😊`;

    console.log(`[RESERVA] ${pedidosIds.length} pedido(s) criado(s) para ${nome}`);
    return { sucesso: true, mensagem: pixMsg, pix: PIX_CHAVE };
  } catch (err: any) {
    console.error('[RESERVA] Erro:', err.message);
    return { sucesso: false, mensagem: 'Erro ao processar reserva. Tenta novamente.' };
  }
}

const CNPJ_MADRE = '10519294000116';

export async function toolProcessarComprovante(texto: string, sessionId: string): Promise<{ sucesso: boolean; cnpj?: string; mensagem: string }> {
  try {
    console.log(`[COMPROVANTE] Texto recebido: "${texto.slice(0, 400)}"`);

    const textoLower = texto.toLowerCase();

    // Tenta extrair CNPJ completo (com ou sem formatação)
    const match = texto.match(/\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/);
    let cnpjValidado = false;
    let cnpjExibir = '';

    if (match) {
      const cnpj = match[0].replace(/\D/g, '');
      console.log(`[COMPROVANTE] CNPJ extraído: ${cnpj}`);
      if (cnpj === CNPJ_MADRE) {
        cnpjValidado = true;
        cnpjExibir = match[0];
      } else {
        console.warn(`[COMPROVANTE] CNPJ incorreto: esperado ${CNPJ_MADRE}, recebido ${cnpj}`);
      }
    }

    // Fallback: CNPJ pode estar mascarado pelo OCR (ex: "**.**9.294/0001-**")
    // Aceita se a razão social "madre" estiver presente + fragmentos únicos do CNPJ
    if (!cnpjValidado) {
      const temMadre = textoLower.includes('madre') || textoLower.includes('loterica da madre') || textoLower.includes('lotérica da madre');
      const temFragmento = texto.includes('9.294/0001') || texto.includes('9294/0001') || texto.includes('519294') || texto.includes('10519294');
      if (temMadre && temFragmento) {
        console.log(`[COMPROVANTE] CNPJ mascarado pelo OCR — validado por razão social + fragmento`);
        cnpjValidado = true;
        cnpjExibir = CNPJ_MADRE;
      }
    }

    if (!cnpjValidado) {
      // Se tem "madre" mas não achou CNPJ nem fragmento — provavelmente OCR cortou demais
      if (textoLower.includes('madre')) {
        console.warn('[COMPROVANTE] Madre presente mas CNPJ não identificável — pedindo reenvio');
        return { sucesso: false, mensagem: 'Não consegui ler o CNPJ do comprovante. Pode tirar uma foto mais nítida do QR code ou dos dados do recebedor?' };
      }
      console.warn('[COMPROVANTE] CNPJ e razão social não encontrados');
      return { sucesso: false, mensagem: 'Não consegui identificar o CNPJ no comprovante. Pode reenviar a imagem?' };
    }

    // Valida razão social — precisa conter "madre" no texto
    if (!textoLower.includes('madre')) {
      console.warn('[COMPROVANTE] Razão social "Madre" não encontrada no texto');
      return { sucesso: false, mensagem: 'O comprovante não é da Lotérica da Madre. Verifique o destinatário e reenvie.' };
    }

    console.log(`[COMPROVANTE] Validado — CNPJ: ${cnpjExibir}`);

    // Atualiza pedidos da sessão para status a_endossar
    const sessao = await getSessao(sessionId);
    if (sessao.pedidos_ids?.length) {
      const { error } = await supabaseErica
        .from('pedidos')
        .update({ status: 'a_endossar' })
        .in('id', sessao.pedidos_ids);

      if (error) {
        console.error('[COMPROVANTE] Erro ao atualizar status pedidos:', error.message);
      } else {
        console.log(`[COMPROVANTE] ${sessao.pedidos_ids.length} pedido(s) → a_endossar`);
      }
    }

    return { sucesso: true, cnpj: cnpjExibir, mensagem: 'Comprovante recebido e validado! ✅' };
  } catch (err: any) {
    console.error('[COMPROVANTE] Erro:', err.message);
    return { sucesso: false, mensagem: 'Erro ao processar comprovante.' };
  }
}
