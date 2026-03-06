import { openai, MODEL } from '../services/openai';
import { getChatHistory, saveChatMessage, getClienteByTelefone, getUltimaLoteria, getAcumuladosPorLoteria } from '../services/supabase';
import { getSessao, saveSessao, atualizarFase, confirmarBolao, marcarBolaoOferecido, salvarBoloesDisponiveis } from '../services/session';
import { sendText } from '../services/whatsapp';
import { toolBuscarBoloes } from '../tools/boloes';
import { toolBuscarEscolherCota } from '../tools/cotas';
import { toolEnviarImagem } from '../tools/imagens';
import { toolFazerReservas, toolProcessarComprovante } from '../tools/reservas';
import { buildSystemPrompt } from './prompts';
import { TOOLS } from './tools';
import type { MessageContext } from '../types';

async function executeTool(
  name: string,
  args: any,
  ctx: MessageContext
): Promise<string> {
  const { sessionId, remoteJid } = ctx;
  console.log(`[TOOL] ▶ ${name}`, JSON.stringify(args));

  try {
    let result: any;

    switch (name) {
      case 'buscar_boloes': {
        const boloes = await toolBuscarBoloes(args.data_sorteio);
        // Zero RAM: salva lista de bolões no Supabase
        await salvarBoloesDisponiveis(sessionId, boloes);
        result = { sucesso: true, total: boloes.length, boloes };
        break;
      }

      case 'mostrar_bilhete': {
        const { loteria, total_cotas, data_sorteio } = args;

        // Zero RAM: lê bolões da sessão no Supabase (não de RAM)
        const sessaoAtual = await getSessao(sessionId);
        const boloes = sessaoAtual.boloes_disponiveis || [];
        const bolao = boloes.find(b =>
          b.nome.toLowerCase().includes(loteria.toLowerCase().split('-')[0].toLowerCase().trim()) &&
          b.cotas === total_cotas
        );
        const valorCota = bolao?.valor_numero || 0;

        // Servidor busca e escolhe cota — LLM nunca vê o número
        const cotaResult = await toolBuscarEscolherCota(
          sessionId, loteria, total_cotas, data_sorteio, valorCota
        );

        if (!cotaResult.sucesso) {
          result = { sucesso: false, mensagem: 'Não há cotas disponíveis para este bolão no momento.' };
          break;
        }

        // Servidor envia a imagem com todos os parâmetros corretos
        const imgResult = await toolEnviarImagem(sessionId, remoteJid, loteria, total_cotas, data_sorteio);

        // Marca bolão como oferecido usando chave "loteria:cotas" para distinguir dois bolões da mesma loteria
        await marcarBolaoOferecido(sessionId, `${loteria}:${total_cotas}`);

        // Atualiza fase para 'venda' (aguardando confirmação do cliente)
        await atualizarFase(sessionId, 'venda');

        result = {
          sucesso: imgResult.sucesso,
          cotas_disponiveis: cotaResult.cotas_disponiveis,
          mensagem: imgResult.sucesso
            ? `Bilhete enviado! Há ${cotaResult.cotas_disponiveis} cota(s) disponível(is).`
            : imgResult.mensagem
        };
        break;
      }

      case 'confirmar_compra': {
        const { loteria, total_cotas, valor_cota, data_sorteio } = args;
        const sessao = await getSessao(sessionId);

        if (!sessao.cota_selecionada) {
          result = { sucesso: false, mensagem: 'Nenhuma cota selecionada. Mostre o bilhete primeiro.' };
          break;
        }

        await confirmarBolao(sessionId, {
          loteria,
          total_cotas,
          valor_cota,
          data_sorteio,
          cota_numero: sessao.cota_selecionada.numero,
          cota_id: sessao.cota_selecionada.cota_id,
          bolao_id: sessao.cota_selecionada.bolao_id
        });

        // Auto-detecta próxima fase: upsell, downsell ou fechamento
        const sessaoPos = await getSessao(sessionId);
        const { boloes_disponiveis, boloes_confirmados, boloes_oferecidos } = sessaoPos;
        const loteriasConfirmadas = boloes_confirmados.map(b => b.loteria);

        // Verifica upsell: mesma loteria com cotas diferentes ainda não oferecida
        const upsellDisp = boloes_disponiveis.find(b =>
          b.nome.toLowerCase() === loteria.toLowerCase() &&
          !boloes_oferecidos.includes(`${b.nome}:${b.cotas}`)
        );

        if (upsellDisp) {
          await atualizarFase(sessionId, 'upsell');
          result = {
            sucesso: true,
            mensagem: `${loteria} confirmada!`,
            proximo: `upsell_disponivel`,
            upsell: { nome: upsellDisp.nome, cotas: upsellDisp.cotas, valor: upsellDisp.valor }
          };
        } else {
          // Verifica downsell: outra loteria não confirmada ainda
          const downsellDisp = boloes_disponiveis.find(b =>
            b.nome.toLowerCase() !== loteria.toLowerCase() &&
            !loteriasConfirmadas.includes(b.nome)
          );

          if (downsellDisp) {
            await atualizarFase(sessionId, 'downsell');
            result = {
              sucesso: true,
              mensagem: `${loteria} confirmada!`,
              proximo: 'downsell_disponivel',
              downsell: { nome: downsellDisp.nome, cotas: downsellDisp.cotas, valor: downsellDisp.valor }
            };
          } else {
            await atualizarFase(sessionId, 'fechamento');
            result = { sucesso: true, mensagem: `${loteria} confirmada!`, proximo: 'ir_para_revisao' };
          }
        }
        break;
      }

      case 'fazer_reserva': {
        const { nome, cpf, telefone } = args;
        result = await toolFazerReservas(sessionId, nome, cpf, telefone);
        if (result?.sucesso !== false) {
          await atualizarFase(sessionId, 'aguardando_pagamento');
        }
        break;
      }

      case 'processar_comprovante': {
        result = await toolProcessarComprovante(args.texto, sessionId);
        break;
      }

      default:
        result = { error: `Tool desconhecida: ${name}` };
    }

    console.log(`[TOOL] ◀ ${name}`, JSON.stringify(result).slice(0, 200));
    return JSON.stringify(result);
  } catch (err: any) {
    console.error(`[TOOL] ✗ ${name}`, err.message);
    return JSON.stringify({ error: err.message });
  }
}

export async function runErica(ctx: MessageContext): Promise<void> {
  console.log(`[ERICA] ▶ ${ctx.phone} | "${ctx.text.slice(0, 60)}"`);

  try {
    // 1. Carrega sessão e histórico do Supabase — zero RAM
    const [sessao, history, clienteDb, acumulados] = await Promise.all([
      getSessao(ctx.sessionId),
      getChatHistory(ctx.sessionId, 30),
      getClienteByTelefone(ctx.phone),
      getAcumuladosPorLoteria()
    ]);

    // 2. Verifica se é cliente recorrente
    const isCliente = !!clienteDb;
    let ultimaLoteria: string | null = null;
    if (isCliente && clienteDb.id) {
      ultimaLoteria = await getUltimaLoteria(clienteDb.id);
    }

    // 3. Monta mensagens
    const systemPrompt = buildSystemPrompt(ctx.name, ctx.phone, sessao, isCliente, ultimaLoteria, acumulados);

    const messages: any[] = [
      { role: 'system', content: systemPrompt },
      ...history.map((h: any) => ({
        role: h.message.type === 'human' ? 'user' : 'assistant',
        content: h.message.content
      })),
      { role: 'user', content: ctx.text }
    ];

    // 4. Salva mensagem do usuário
    await saveChatMessage(ctx.sessionId, 'human', ctx.text);

    // 5. Chama OpenAI
    let response = await openai.chat.completions.create({
      model: MODEL,
      messages,
      tools: TOOLS,
      tool_choice: 'auto'
    });

    // 6. Tool calling loop
    let faseAnterior = sessao.fase;

    while (response.choices[0].finish_reason === 'tool_calls') {
      const assistantMsg = response.choices[0].message;
      messages.push(assistantMsg);

      const toolResults: any[] = [];
      for (const toolCall of assistantMsg.tool_calls!) {
        const tc = toolCall as any;
        const result = await executeTool(
          tc.function.name,
          JSON.parse(tc.function.arguments),
          ctx
        );
        toolResults.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result
        });
      }

      messages.push(...toolResults);

      // Verifica se a fase mudou para upsell/downsell após os tools
      const sessaoAtualizada = await getSessao(ctx.sessionId);
      if (sessaoAtualizada.fase !== faseAnterior &&
          (sessaoAtualizada.fase === 'upsell' || sessaoAtualizada.fase === 'downsell')) {
        const instrucao = sessaoAtualizada.fase === 'upsell'
          ? '⚠️ FASE ATUALIZADA → UPSELL. O cliente confirmou um bolão. Confirme brevemente e IMEDIATAMENTE ofereça o próximo bolão da mesma loteria. PROIBIDO pedir dados do cliente agora.'
          : '⚠️ FASE ATUALIZADA → DOWNSELL. Confirme brevemente e IMEDIATAMENTE ofereça um bolão de outra loteria disponível. PROIBIDO pedir dados do cliente agora.';
        messages.push({ role: 'system', content: instrucao });
        console.log(`[ERICA] Fase injetada no prompt: ${sessaoAtualizada.fase}`);
        faseAnterior = sessaoAtualizada.fase;
      }

      response = await openai.chat.completions.create({
        model: MODEL,
        messages,
        tools: TOOLS,
        tool_choice: 'auto'
      });
    }

    // 7. Envia resposta ao cliente
    const finalText = response.choices[0].message.content || '';
    console.log(`[ERICA] ◀ ${finalText.length} chars | finish: ${response.choices[0].finish_reason}`);

    if (finalText) {
      await sendText(ctx.remoteJid, finalText);
      await saveChatMessage(ctx.sessionId, 'ai', finalText);
    }

    // 8. Atualiza ultima_atividade sem sobrescrever as mudanças feitas pelos tools
    // CRÍTICO: recarrega sessão do Supabase antes de salvar para não perder dados dos tools
    const sessaoFinal = await getSessao(ctx.sessionId);
    await saveSessao(sessaoFinal);

  } catch (err: any) {
    console.error('[ERICA] Erro fatal:', err.message);
    await sendText(ctx.remoteJid, 'Desculpa, tive um problema aqui. Pode repetir? 😊');
  }
}
