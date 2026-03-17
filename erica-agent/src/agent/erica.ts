import { openai, MODEL } from '../services/openai';
import { getChatHistory, saveChatMessage, getClienteByTelefone, getUltimaLoteria, getAcumuladosPorLoteria, verificarReservasPendentes } from '../services/supabase';

// Mapeia nome do bolão (ex: "Mega-Sena") para chave do acumulado (ex: "MEGA-SENA")
function buscarAcumulado(nomeBolao: string, acumulados: Record<string, number>): number | null {
  const mapa: Record<string, string[]> = {
    'Mega Sena':  ['MEGA-SENA'],
    'Lotofacil':  ['LOTOFÁCIL', 'LOTOFACIL'],
    'Dupla Sena': ['DUPLASENA', 'DUPLA SENA'],
    'Quina':      ['QUINA'],
    'Lotomania':  ['LOTOMANIA'],
    'Timemania':  ['TIMEMANIA'],
    'Super Sete': ['SUPER SETE'],
    'Dia de Sorte': ['DIA DE SORTE'],
    'Milionaria': ['+MILIONÁRIA', 'MILIONÁRIA'],
  };
  const chaves = mapa[nomeBolao] || [nomeBolao.toUpperCase()];
  for (const chave of chaves) {
    if (acumulados[chave] && acumulados[chave] > 0) return acumulados[chave];
  }
  return null;
}
import { getSessao, saveSessao, atualizarFase, confirmarBolao, marcarBolaoOferecido, marcarLoteiraListada, salvarBoloesDisponiveis, salvarDadosCliente, limparCarrinho, irParaFechamento, salvarUltimoBilhete, salvarMapaLista, getMapaLista, getLoteriasListadas, resetarSessao } from '../services/session';
import { extrairDados, mesclarDados, statusColeta } from '../services/coleta-dados';
import { sendText } from '../services/whatsapp';
import { toolBuscarBoloes } from '../tools/boloes';
import { toolBuscarEscolherCota } from '../tools/cotas';
import { toolEnviarImagem } from '../tools/imagens';
import { toolFazerReservas, toolProcessarComprovante } from '../tools/reservas';
import { toolSolicitarHumano } from '../tools/humano';
import { buildSystemPrompt } from './prompts';
import { TOOLS } from './tools';
import type { MessageContext } from '../types';

// Detecta pedido de múltiplas cotas: "3 cotas da mega", "2 da lotofacil", "quero 3 mega e 2 lotofacil"
function detectarPedidoMultiplasCotas(texto: string): { loteria: string; quantidade: number }[] {
  const resultados: { loteria: string; quantidade: number }[] = [];
  const lower = texto.toLowerCase();

  // Mapa de variações de nome para nome canônico
  const loterias: Record<string, string> = {
    'mega': 'Mega-Sena', 'mega sena': 'Mega-Sena', 'mega-sena': 'Mega-Sena',
    'lotofacil': 'Lotofacil', 'lotofácil': 'Lotofacil', 'lotofaci': 'Lotofacil',
    'quina': 'Quina',
    'dupla': 'Dupla Sena', 'dupla sena': 'Dupla Sena',
    'lotomania': 'Lotomania',
    'timemania': 'Timemania',
    'dia de sorte': 'Dia de Sorte', 'dia sorte': 'Dia de Sorte',
    'super sete': 'Super Sete', 'supersete': 'Super Sete',
    'milionaria': 'Milionaria', 'milionária': 'Milionaria',
  };

  // Padrão: número + (cota(s)/bolão/boloes)? + (da/de/do)? + nome loteria
  // Ex: "3 cotas da mega", "2 da lotofacil", "3 mega"
  const regex = /(\d+)\s*(?:cotas?\s+(?:da|de|do)\s+|bolões?\s+(?:da|de|do)\s+|(?:da|de|do)\s+)?([a-záéíóúãõçü\s-]+?)(?:\s+e\s+\d|\s+e\s+$|,|$)/gi;
  let match;
  while ((match = regex.exec(lower + ' ')) !== null) {
    const qtd = parseInt(match[1], 10);
    const nomeCandidato = match[2].trim();

    // Só detecta multi-cotas se o nome da loteria estiver explícito na mensagem
    // (evita que números soltos como "7" sejam interpretados como "7 cotas")
    if (!nomeCandidato) continue;
    for (const [chave, canonico] of Object.entries(loterias)) {
      if (nomeCandidato.includes(chave)) {
        if (qtd >= 2 && !resultados.some(r => r.loteria === canonico)) {
          resultados.push({ loteria: canonico, quantidade: qtd });
        }
        break;
      }
    }
  }

  return resultados;
}

// Palavras que SÃO confirmação de compra
const PALAVRAS_CONFIRMACAO = [
  'sim', 'quero', 'pode', 'fico', 'fica', 'confirmo', 'confirmado',
  'compra', 'comprar', 'reserva', 'reservar', 'fecha', 'fechar',
  'bora', 'vai', 'tô dentro', 'to dentro', 'sim quero', 'pode sim',
  'garante', 'garantir', 'fechado', 'topo', 'aceito'
];

function fraseEConfirmacao(frase: string): boolean {
  const lower = frase.toLowerCase().trim();
  return PALAVRAS_CONFIRMACAO.some(p => lower.includes(p));
}

async function executeTool(
  name: string,
  args: any,
  ctx: MessageContext,
  acumulados: Record<string, number> = {},
  bilhetesEnviadosNessaTurno: Set<string> = new Set(),
  confirmacaoFeitaNesseTurno: { feita: boolean } = { feita: false }
): Promise<string> {
  const { sessionId, remoteJid } = ctx;
  console.log(`[TOOL] ▶ ${name}`, JSON.stringify(args));

  try {
    let result: any;

    switch (name) {
      case 'buscar_boloes': {
        const boloes = await toolBuscarBoloes();
        // Zero RAM: salva lista de bolões no Supabase
        await salvarBoloesDisponiveis(sessionId, boloes);

        // Enriquece cada bolão com o valor acumulado da loteria (para o LLM apresentar ao cliente)
        const boloesEnriquecidos = boloes.map((b: any) => {
          const acumulado = buscarAcumulado(b.nome, acumulados);
          return { ...b, valor_acumulado: acumulado };
        });

        result = { sucesso: true, total: boloes.length, boloes: boloesEnriquecidos };
        break;
      }

      case 'listar_jogos_loteria': {
        const { loteria } = args;

        // Busca lista fresca do banco — garante bolões e cotas atualizados
        const boloesFrescos = await toolBuscarBoloes();
        if (boloesFrescos.length > 0) {
          await salvarBoloesDisponiveis(sessionId, boloesFrescos);
          console.log(`[LISTA] Lista atualizada do banco: ${boloesFrescos.length} bolões`);
        }

        const sessaoLista = await getSessao(sessionId);
        const boloes = boloesFrescos.length > 0 ? boloesFrescos : (sessaoLista.boloes_disponiveis || []);

        // Filtra bolões da loteria pedida — respeita as 3 regras (já aplicadas em buscar_boloes):
        // 1. status=ativo  2. Érica tem cota  3. data_sorteio >= hoje
        const booloesDaLoteria = boloes.filter(b =>
          b.nome.toLowerCase().includes(loteria.toLowerCase().split('-')[0].toLowerCase().trim())
        );

        if (booloesDaLoteria.length === 0) {
          result = { sucesso: false, mensagem: `Nenhum bolão disponível de ${loteria} no momento.` };
          break;
        }

        if (booloesDaLoteria.length === 1) {
          // Só 1 bolão — marca como listada e instrui a mostrar direto
          await marcarLoteiraListada(sessionId, loteria);
          result = {
            sucesso: true,
            total: 1,
            mensagem: `Apenas 1 bolão de ${booloesDaLoteria[0].nome} disponível. Chame mostrar_bilhete com codigo="${booloesDaLoteria[0].codigo}" diretamente.`,
            boloes: booloesDaLoteria.map((b, i) => ({ numero: i + 1, codigo: b.codigo, valor: b.valor, cotas: b.cotas, data_sorteio: b.data_sorteio }))
          };
          break;
        }

        // Múltiplos bolões — servidor envia lista formatada completa
        const linhas = booloesDaLoteria.map((b, i) =>
          `*Bolão ${i + 1}* — ${b.valor} por cota`
        ).join('\n');
        const msgLista = `Temos ${booloesDaLoteria.length} bolões da ${booloesDaLoteria[0].nome} disponíveis:\n\n${linhas}\n\nQual deles te interessa? Posso mostrar o bilhete! 📄`;

        await sendText(remoteJid, msgLista);
        await marcarLoteiraListada(sessionId, loteria);
        console.log(`[LISTA] ${booloesDaLoteria.length} bolões de ${loteria} enviados pelo servidor`);

        // Mapeia posição → codigo para ser usado na detecção server-side da escolha por número
        const mapaNumCodigo: Record<string, string> = {};
        booloesDaLoteria.forEach((b, i) => { mapaNumCodigo[String(i + 1)] = b.codigo; });

        // Persiste o mapa em cache — próximo turno o servidor resolve "bolão 6" → código correto
        salvarMapaLista(sessionId, mapaNumCodigo);
        console.log(`[LISTA] Mapa salvo: ${JSON.stringify(mapaNumCodigo)}`);

        result = {
          sucesso: true,
          lista_enviada: true,
          instrucao: `Lista enviada pelo sistema. NÃO repita a lista. Aguarde o cliente escolher um número.`,
          mapa: mapaNumCodigo
        };
        break;
      }

      case 'mostrar_bilhete': {
        const { codigo, loteria, total_cotas, data_sorteio } = args;

        // Ação 3: se a loteria ainda não foi listada e há múltiplos bolões → envia lista automática
        // Impede a IA de pular a etapa de listagem (bug com a Talita: mandou bilhete sem listar)
        const loterasJaListadas = getLoteriasListadas(sessionId);
        const loteriaNomeBase = loteria.toLowerCase().split('-')[0].trim();
        const foiListada = loterasJaListadas.some(l =>
          l.toLowerCase().includes(loteriaNomeBase) || loteriaNomeBase.includes(l.toLowerCase())
        );

        if (!foiListada) {
          const boloesFrescosAuto = await toolBuscarBoloes();
          const boloesDaLoteria = boloesFrescosAuto.filter(b =>
            b.nome.toLowerCase().includes(loteriaNomeBase)
          );
          if (boloesDaLoteria.length > 1) {
            const linhas = boloesDaLoteria.map((b, i) => `*Bolão ${i + 1}* — ${b.valor} por cota`).join('\n');
            const msgAutoLista = `Temos ${boloesDaLoteria.length} bolões da ${boloesDaLoteria[0].nome} disponíveis:\n\n${linhas}\n\nQual deles te interessa? Posso mostrar o bilhete! 📄`;
            await sendText(remoteJid, msgAutoLista);
            await marcarLoteiraListada(sessionId, loteria);
            await salvarBoloesDisponiveis(sessionId, boloesFrescosAuto);
            const mapaAuto: Record<string, string> = {};
            boloesDaLoteria.forEach((b, i) => { mapaAuto[String(i + 1)] = b.codigo; });
            salvarMapaLista(sessionId, mapaAuto);
            console.log(`[MOSTRAR] ${loteria} não listada — lista enviada automaticamente (${boloesDaLoteria.length} bolões)`);
            result = { sucesso: true, lista_enviada: true, instrucao: 'Lista enviada automaticamente. Aguarde o cliente escolher um número.', mapa: mapaAuto };
            break;
          }
          // 1 bolão só → continua normalmente, só marca como listada
          await marcarLoteiraListada(sessionId, loteria);
        }

        // Lê bolões da sessão no Supabase
        const sessaoAtual = await getSessao(sessionId);
        const boloes = sessaoAtual.boloes_disponiveis || [];

        // Identifica o bolão pelo código único — evita confusão entre bolões com mesma loteria/cotas
        const bolao = boloes.find(b => b.codigo === codigo)
          || boloes.find(b =>
              b.nome.toLowerCase().includes(loteria.toLowerCase().split('-')[0].toLowerCase().trim()) &&
              b.cotas === total_cotas
            );

        if (!bolao) {
          result = { sucesso: false, mensagem: `Bolão ${codigo} não encontrado na sessão.` };
          break;
        }

        // Deduplicação por turno — evita que a IA envie o mesmo bilhete duas vezes na mesma mensagem
        // (não bloqueia entre turnos: se o cliente pedir de novo em nova mensagem, funciona normalmente)
        if (bilhetesEnviadosNessaTurno.has(bolao.codigo)) {
          console.log(`[MOSTRAR] Bilhete ${bolao.codigo} já enviado neste turno — ignorando duplicata silenciosamente`);
          result = { sucesso: true, mensagem: `Bilhete do ${bolao.nome} já foi enviado neste turno.` };
          break;
        }
        bilhetesEnviadosNessaTurno.add(bolao.codigo);

        const valorCota = bolao.valor_numero || 0;

        // Servidor busca e escolhe cota usando bolao_id direto — sem ambiguidade
        const cotaResult = await toolBuscarEscolherCota(
          sessionId, bolao.codigo, loteria, total_cotas, data_sorteio, valorCota
        );

        if (!cotaResult.sucesso) {
          result = { sucesso: false, mensagem: 'Não há cotas disponíveis para este bolão no momento.' };
          break;
        }

        // Servidor envia a imagem com todos os parâmetros corretos
        const imgResult = await toolEnviarImagem(sessionId, remoteJid, loteria, total_cotas, data_sorteio);

        // Marca bolão como oferecido usando o código único
        await marcarBolaoOferecido(sessionId, bolao.codigo);

        // Salva o último bilhete mostrado no cache em memória
        salvarUltimoBilhete(sessionId, bolao.codigo);
        console.log(`[MOSTRAR] Último bilhete registrado: ${bolao.codigo}`);

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
        const { codigo, loteria, total_cotas, valor_cota, data_sorteio, frase_cliente } = args;
        const sessao = await getSessao(sessionId);

        // CHECAGEM 1 — frase do cliente contém palavra de confirmação?
        const frase = frase_cliente || '';
        if (!fraseEConfirmacao(frase)) {
          console.warn(`[CONFIRMAR] Bloqueado — frase sem confirmação: "${frase}"`);
          result = { sucesso: false, mensagem: `"${frase}" não é confirmação de compra. Pergunte ao cliente: "Quer garantir a sua cota? 🍀"` };
          break;
        }

        // CHECAGEM 2 — o bolão sendo confirmado é o último que foi mostrado?
        if (sessao.ultimo_bilhete_mostrado && sessao.ultimo_bilhete_mostrado !== codigo) {
          console.warn(`[CONFIRMAR] Bloqueado — código divergente. Mostrado: ${sessao.ultimo_bilhete_mostrado} | Tentou confirmar: ${codigo}`);
          result = { sucesso: false, mensagem: `O último bilhete mostrado foi ${sessao.ultimo_bilhete_mostrado}, não ${codigo}. Mostre o bilhete correto antes de confirmar.` };
          break;
        }

        // CHECAGEM 3 — já houve confirmação neste turno?
        if (confirmacaoFeitaNesseTurno.feita) {
          console.warn(`[CONFIRMAR] Bloqueado — segunda confirmação no mesmo turno para ${codigo}`);
          result = { sucesso: false, mensagem: 'Apenas uma confirmação por mensagem é permitida. Aguarde o cliente responder antes de confirmar outro bolão.' };
          break;
        }
        confirmacaoFeitaNesseTurno.feita = true;

        // Busca a cota pelo código específico do bolão — garante que confirma exatamente o que o cliente escolheu
        let cotaCorreta = sessao.cotas_pre_selecionadas?.[codigo] || null;

        if (!cotaCorreta) {
          // Cache em memória foi perdido (ex: deploy/restart entre mensagens) — re-seleciona cota do Supabase
          console.warn(`[CONFIRMAR] Cache vazio para ${codigo} — re-selecionando cota do Supabase...`);
          const bolaoParaConfirmar = sessao.boloes_disponiveis.find(b => b.codigo === codigo);
          if (!bolaoParaConfirmar) {
            result = { sucesso: false, mensagem: `Bolão ${codigo} não encontrado na sessão. Verifique o código.` };
            break;
          }
          const cotaFallback = await toolBuscarEscolherCota(sessionId, codigo, loteria, total_cotas, data_sorteio, bolaoParaConfirmar.valor_numero);
          if (!cotaFallback.sucesso || !cotaFallback.cota) {
            result = { sucesso: false, mensagem: `Não há cotas disponíveis para ${codigo} no momento.` };
            break;
          }
          cotaCorreta = cotaFallback.cota;
          // Marca como oferecido para que upsell/downsell não re-ofereça
          await marcarBolaoOferecido(sessionId, codigo);
          console.log(`[CONFIRMAR] Cota re-selecionada via fallback para ${codigo}`);
        }

        // Verifica se bolão já foi confirmado para evitar duplicata
        const jaConfirmado = sessao.boloes_confirmados.some(b => b.bolao_id === cotaCorreta.bolao_id);
        if (jaConfirmado) {
          result = { sucesso: false, mensagem: `Este bolão já foi confirmado anteriormente.` };
          console.warn(`[CONFIRMAR] Bolão ${codigo} já confirmado — ignorando duplicata`);
          break;
        }

        console.log(`[CONFIRMAR] Usando cota ${cotaCorreta.numero} do bolão ${codigo} (${loteria})`);

        await confirmarBolao(sessionId, {
          loteria,
          total_cotas,
          valor_cota,
          data_sorteio,
          cota_numero: cotaCorreta.numero,
          cota_id: cotaCorreta.cota_id,
          bolao_id: cotaCorreta.bolao_id
        });

        // Auto-detecta próxima fase: upsell, downsell ou fechamento
        const sessaoPos = await getSessao(sessionId);
        const { boloes_disponiveis, boloes_confirmados, boloes_oferecidos } = sessaoPos;
        const confirmedBolaoIds = boloes_confirmados.map(b => b.bolao_id);

        // boloes_disponiveis já vem ordenado: data_sorteio ASC, valor_cota ASC
        // Upsell 1: mesma loteria, mesmo valor — ex: Mega D → Mega D+1 (mesmo preço)
        const upsellMesmoValor = boloes_disponiveis.find(b =>
          b.nome.toLowerCase() === loteria.toLowerCase() &&
          b.valor_numero === valor_cota &&
          !boloes_oferecidos.includes(b.codigo)
        );

        // Upsell 2: mesma loteria, valor maior — se não achou mesmo valor
        const upsellMaiorValor = boloes_disponiveis.find(b =>
          b.nome.toLowerCase() === loteria.toLowerCase() &&
          b.valor_numero > valor_cota &&
          !boloes_oferecidos.includes(b.codigo)
        );

        const upsellDisp = upsellMesmoValor || upsellMaiorValor;

        if (upsellDisp) {
          await atualizarFase(sessionId, 'upsell');
          result = {
            sucesso: true,
            mensagem: `${loteria} confirmada!`,
            proximo: 'upsell_disponivel',
            upsell: { nome: upsellDisp.nome, cotas: upsellDisp.cotas, valor: upsellDisp.valor, codigo: upsellDisp.codigo, data_sorteio: upsellDisp.data_sorteio }
          };
        } else {
          // Downsell: outra loteria ainda não confirmada, menor valor disponível (lista já ordenada por valor ASC)
          const loteriasConfirmadas = boloes_confirmados.map(b => b.loteria.toLowerCase());
          const downsellDisp = boloes_disponiveis.find(b =>
            b.nome.toLowerCase() !== loteria.toLowerCase() &&
            !loteriasConfirmadas.includes(b.nome.toLowerCase())
          );

          if (downsellDisp) {
            await atualizarFase(sessionId, 'downsell');
            result = {
              sucesso: true,
              mensagem: `${loteria} confirmada!`,
              proximo: 'downsell_disponivel',
              downsell: { nome: downsellDisp.nome, cotas: downsellDisp.cotas, valor: downsellDisp.valor, codigo: downsellDisp.codigo, data_sorteio: downsellDisp.data_sorteio }
            };
          } else {
            await atualizarFase(sessionId, 'fechamento');
            result = { sucesso: true, mensagem: `${loteria} confirmada!`, proximo: 'ir_para_revisao' };
          }
        }
        break;
      }

      case 'ir_para_fechamento': {
        await irParaFechamento(sessionId);
        console.log(`[FECHAMENTO] Fase definida para fechamento pela IA`);
        result = { sucesso: true, mensagem: 'Iniciando fechamento. O servidor enviará a revisão do carrinho.' };
        break;
      }

      case 'limpar_carrinho': {
        await limparCarrinho(sessionId);
        console.log(`[CARRINHO] Carrinho esvaziado — ${args.motivo}`);
        result = { sucesso: true, mensagem: 'Carrinho esvaziado! Pode escolher novos bolões.' };
        break;
      }

      case 'fazer_reserva': {
        // Bloqueado — o servidor gerencia a reserva via coleta-dados.ts
        // A IA não tem permissão para chamar fazer_reserva diretamente
        console.warn('[TOOL] fazer_reserva chamada pela IA — bloqueada. O servidor gerencia isso.');
        result = { sucesso: false, mensagem: 'Aguardando dados do cliente pelo servidor.' };
        break;
      }

      case 'processar_comprovante': {
        result = await toolProcessarComprovante(args.texto, sessionId);
        break;
      }

      case 'solicitar_humano': {
        result = await toolSolicitarHumano(sessionId, ctx.phone, ctx.name, args.motivo);
        break;
      }

      default:
        result = { error: `Tool desconhecida: ${name}` };
    }

    console.log(`[TOOL] ◀ ${name}`, JSON.stringify(result).slice(0, 600));
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
    let [sessao, history, clienteDb, acumulados] = await Promise.all([
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

    // 2a. Se sessão está em aguardando_pagamento → verifica se reserva ainda é válida
    if (sessao.fase === 'aguardando_pagamento') {
      const reservas = await verificarReservasPendentes(sessao.pedidos_ids || []);

      if (!reservas.valido) {
        // Sorteio já passou ou pedidos foram pagos/cancelados → reset silencioso
        await resetarSessao(ctx.sessionId);
        sessao = await getSessao(ctx.sessionId);
        console.log(`[SESSAO] Reservas expiradas/inexistentes — sessão resetada para abertura`);
      } else {
        // Reserva válida — verifica se o cliente está enviando comprovante ou só mensagem
        const pareceComprovante = /cnpj|pix|transferên|banco|recebedor|pagador|sicoob|caixa|itaú|bradesco|nubank|inter|c6|santander|original|pagamento em análise/i.test(ctx.text);
        if (!pareceComprovante) {
          // Mensagem normal → servidor lembra do PIX pendente
          const nomeCliente = clienteDb?.nome || ctx.name || '';
          const total = reservas.itens.reduce((s, i) => s + i.valor, 0);
          const totalFmt = total.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
          const msgPix = `${nomeCliente ? `Oi *${nomeCliente}*! ` : ''}Você tem uma reserva pendente no valor de *${totalFmt}*. 😊\n\nJá fez o PIX? Me manda o comprovante quando pagar!`;
          await saveChatMessage(ctx.sessionId, 'human', ctx.text);
          await sendText(ctx.remoteJid, msgPix);
          await saveChatMessage(ctx.sessionId, 'ai', msgPix);
          console.log(`[SESSAO] Lembrete PIX enviado — reserva válida (${reservas.itens.length} item(s))`);
          return;
        }
        // Parece comprovante → deixa fluir para a IA processar
      }
    }

    // 2b. Detecção server-side de intenção de fechar / limpar carrinho (não depende da IA)
    const textoLower = ctx.text.toLowerCase().trim();

    // --- Situação A: cliente quer parar de comprar ---
    const frasesFechar = [
      'finalizar', 'pode fechar', 'quero fechar', 'vamos fechar', 'fechar pedido',
      'só isso', 'so isso', 'é isso', 'e isso', 'por hoje é isso', 'por hoje e isso',
      'chega', 'basta', 'mais nada', 'nao quero mais', 'não quero mais',
      'tá bom', 'ta bom', 'tá bom assim', 'ta bom assim', 'tá ótimo', 'ta otimo',
      'pode encerrar', 'encerrar', 'é suficiente', 'e suficiente', 'por enquanto é isso'
    ];

    // --- Situação B: cliente confirma revisão que a IA enviou ---
    // Verifica se a última mensagem da IA perguntou "Posso fechar?"
    const ultimaMsgIA = history.filter((h: any) => h.message.type === 'ai').slice(-1)[0]?.message?.content || '';
    // Ação 4: detecta confirmação de revisão — ampliado para cobrir mais variantes
    const ultimaMsgEraRevisao =
      ultimaMsgIA.toLowerCase().includes('posso fechar') ||
      ultimaMsgIA.toLowerCase().includes('então ficamos') ||
      ultimaMsgIA.toLowerCase().includes('entao ficamos') ||
      ultimaMsgIA.toLowerCase().includes('ficamos com') ||
      ultimaMsgIA.toLowerCase().includes('total:') ||
      ultimaMsgIA.toLowerCase().includes('vamos revisar') ||
      ultimaMsgIA.toLowerCase().includes('posso finalizar');

    const frasesConfirmacao = ['pode', 'sim', 'podemos', 'claro', 'vai', 'bora', 'ok', 'tá', 'ta', 'fecha', 'fechar'];
    const frasesNegativas = ['não', 'nao', 'nunca', 'jamais'];
    const confirmouRevisao = ultimaMsgEraRevisao &&
      !frasesNegativas.some(f => textoLower.includes(f)) &&
      frasesConfirmacao.some(f => textoLower.includes(f));

    // Ação 1: detecta confirmação de compra — última IA perguntou "Quer garantir?" + cliente confirmou
    const ultimaMsgEraGarantir =
      ultimaMsgIA.toLowerCase().includes('quer garantir') ||
      ultimaMsgIA.toLowerCase().includes('garantir a sua cota') ||
      ultimaMsgIA.toLowerCase().includes('garantir sua cota');

    // "quero ver", "pode ver", "me mostra", "quero olhar" = navegação, NÃO confirmação
    const contemPalavraNavegacao =
      textoLower.includes('ver') ||
      textoLower.includes('veja') ||
      textoLower.includes('mostra') ||
      textoLower.includes('olhar') ||
      textoLower.includes('outro') ||
      textoLower.includes('próximo') ||
      textoLower.includes('proximo');

    const clienteConfirmouCompra =
      sessao.fase === 'venda' &&
      !!sessao.ultimo_bilhete_mostrado &&
      ultimaMsgEraGarantir &&
      fraseEConfirmacao(textoLower) &&
      !contemPalavraNavegacao &&
      !frasesNegativas.some(f => textoLower.includes(f));

    const emFaseVenda = sessao.fase === 'upsell' || sessao.fase === 'downsell' || sessao.fase === 'venda';
    const temItensCarrinho = sessao.boloes_confirmados.length > 0;

    // Ação 2: detecta recusa de upsell/downsell — cliente disse "não" durante oferta
    const frasesRecusaUpsell = ['não', 'nao', 'esse não', 'esse nao', 'também não', 'tambem nao', 'dispenso'];
    const recusouUpsell = (sessao.fase === 'upsell' || sessao.fase === 'downsell') &&
      temItensCarrinho &&
      frasesRecusaUpsell.some(f => textoLower.includes(f)) &&
      !fraseEConfirmacao(textoLower);

    const querFechar = emFaseVenda && temItensCarrinho && (
      frasesFechar.some(f => textoLower.includes(f)) || confirmouRevisao || recusouUpsell
    );

    if (querFechar) {
      await irParaFechamento(ctx.sessionId);
      sessao = await getSessao(ctx.sessionId);
      console.log(`[FECHAMENTO] Detectado server-side: "${ctx.text.slice(0, 40)}" | situacaoB=${confirmouRevisao}`);
    }

    // Frases que indicam "esvaziar carrinho"
    const frasesLimpar = ['esvaziar', 'limpar carrinho', 'limpa o carrinho', 'cancela tudo',
      'cancelar tudo', 'começar de novo', 'comecar de novo', 'zerar', 'tira tudo', 'remove tudo'];
    const querLimpar = frasesLimpar.some(f => textoLower.includes(f));

    if (querLimpar && sessao.boloes_confirmados.length > 0) {
      await limparCarrinho(ctx.sessionId);
      sessao = await getSessao(ctx.sessionId);
      await saveChatMessage(ctx.sessionId, 'human', ctx.text);
      await sendText(ctx.remoteJid, 'Carrinho esvaziado! 🗑️ Pode escolher novos bolões. O que você quer ver? 😊');
      await saveChatMessage(ctx.sessionId, 'ai', 'Carrinho esvaziado! 🗑️ Pode escolher novos bolões. O que você quer ver? 😊');
      console.log(`[CARRINHO] Esvaziado server-side: "${ctx.text.slice(0, 40)}"`);
      return;
    }

    // 3. Coleta progressiva de dados na fase de fechamento (servidor — não depende da IA)
    if (sessao.fase === 'fechamento') {
      // Guard: cliente perguntando sobre loteria durante o fechamento
      // → carrinho travado, não adiciona mais itens — orienta a finalizar primeiro
      const nomesLoteriasGuard = ['mega', 'lotofacil', 'lotofácil', 'quina', 'dupla', 'lotomania', 'timemania', 'dia de sorte', 'super sete', 'milionaria', 'milionária'];
      const perguntaLoteria = nomesLoteriasGuard.some(n => textoLower.includes(n));
      if (perguntaLoteria) {
        await saveChatMessage(ctx.sessionId, 'human', ctx.text);
        const proxDado = !sessao.dados_cliente?.nome ? 'Nome Completo' : !sessao.dados_cliente?.telefone ? 'WhatsApp' : 'CPF';
        const msgTravado = `Para adicionar mais bolões, vamos finalizar este pedido primeiro! 😊 Me passa seu *${proxDado}* para eu reservar os bolões que você já escolheu.`;
        await sendText(ctx.remoteJid, msgTravado);
        await saveChatMessage(ctx.sessionId, 'ai', msgTravado);
        console.log(`[FECHAMENTO] Carrinho travado — cliente perguntou sobre loteria: "${ctx.text.slice(0, 40)}"`);
        return;
      }

      const extraidos = extrairDados(ctx.text);
      const dadosMesclados = mesclarDados(sessao.dados_cliente, extraidos);

      // Salva imediatamente qualquer campo novo detectado — persistência incremental
      const temNovo = extraidos.nome || extraidos.telefone || extraidos.cpf ||
        (sessao.dados_cliente?.telefone && extraidos.telefone && extraidos.telefone !== sessao.dados_cliente.telefone);
      if (temNovo) {
        await salvarDadosCliente(ctx.sessionId, dadosMesclados);
        sessao.dados_cliente = dadosMesclados;
        console.log(`[COLETA] nome="${dadosMesclados.nome}" tel="${dadosMesclados.telefone}" cpf="${dadosMesclados.cpf}"`);
      }

      // Verifica status após salvar
      const status = statusColeta(dadosMesclados);

      // ──────────────────────────────────────────────────────────────────
      // COLETA PROGRESSIVA: Se nome ou telefone foi salvo neste turno e
      // ainda falta campo → servidor confirma o que foi salvo + pede o próximo.
      // Assim o cliente sabe que o dado foi gravado e não precisa repetir
      // mesmo que a próxima etapa falhe.
      // ──────────────────────────────────────────────────────────────────
      const nomeNovoSalvo  = !!extraidos.nome;
      const telNovoSalvo   = !!extraidos.telefone && !sessao.dados_cliente?.telefone ||
                             (!!extraidos.telefone && extraidos.telefone !== (sessao.dados_cliente?.telefone ?? ''));

      if ((nomeNovoSalvo || telNovoSalvo) && !extraidos.cpf && !status.completo) {
        const confirmacoes: string[] = [];
        if (nomeNovoSalvo) confirmacoes.push(`✅ Nome: *${dadosMesclados.nome}*`);
        if (telNovoSalvo)  confirmacoes.push(`✅ WhatsApp: *${dadosMesclados.telefone}*`);

        let proxDado = '';
        if (!dadosMesclados.nome)      proxDado = `seu *nome completo*`;
        else if (!dadosMesclados.telefone) proxDado = `seu *WhatsApp* com DDD (ex: *43991415354*)`;
        else                               proxDado = `seu *CPF*`;

        const msgConfirma = `${confirmacoes.join('\n')}\n\nMe passa agora ${proxDado}. 😊`;
        await saveChatMessage(ctx.sessionId, 'human', ctx.text);
        await sendText(ctx.remoteJid, msgConfirma);
        await saveChatMessage(ctx.sessionId, 'ai', msgConfirma);
        console.log(`[COLETA] Confirmação progressiva: ${confirmacoes.join(', ')} → falta: ${proxDado}`);
        return;
      }

      // CPF recebido: valida e age
      if (dadosMesclados.nome && dadosMesclados.telefone && dadosMesclados.cpf) {
        if (status.cpfValido) {
          // CPF válido — reserva direto, sem passar pela IA
          console.log(`[COLETA] Dados completos e CPF válido — reservando diretamente`);
          const resultReserva = await toolFazerReservas(ctx.sessionId, dadosMesclados.nome, dadosMesclados.cpf, dadosMesclados.telefone);
          await saveChatMessage(ctx.sessionId, 'human', ctx.text);
          if (resultReserva.sucesso) {
            await atualizarFase(ctx.sessionId, 'aguardando_pagamento');
            const sessaoPos = await getSessao(ctx.sessionId);
            sessaoPos.boloes_confirmados = [];
            sessaoPos.dados_cliente = null;
            await saveSessao(sessaoPos);
            console.log(`[COLETA] Sessão limpa após reserva bem-sucedida`);
            await sendText(ctx.remoteJid, resultReserva.mensagem);
            await saveChatMessage(ctx.sessionId, 'ai', resultReserva.mensagem);
          } else {
            // Reserva falhou — servidor informa, não passa para IA
            const msgFalha = resultReserva.mensagem || 'Tive um problema ao processar a reserva. Pode tentar de novo em instantes? 😊';
            await sendText(ctx.remoteJid, msgFalha);
            await saveChatMessage(ctx.sessionId, 'ai', msgFalha);
            console.log(`[COLETA] Reserva falhou: ${msgFalha.slice(0, 80)}`);
          }
          return;
        } else {
          // CPF inválido — limpa só o CPF (nome e telefone ficam salvos)
          await salvarDadosCliente(ctx.sessionId, { ...dadosMesclados, cpf: '' });
          sessao.dados_cliente = { ...dadosMesclados, cpf: '' };
          console.log(`[COLETA] CPF inválido "${dadosMesclados.cpf}" — nome e telefone mantidos`);
          await saveChatMessage(ctx.sessionId, 'human', ctx.text);
          const msgCpfInv = `Esse CPF não é válido. Pode verificar e me mandar de novo?\n\n_(Seu nome e WhatsApp já estão salvos, só preciso do CPF correto)_ 😊`;
          await sendText(ctx.remoteJid, msgCpfInv);
          await saveChatMessage(ctx.sessionId, 'ai', msgCpfInv);
          return;
        }
      }

      // Feedback quando nenhum dado foi capturado e coleta ainda está incompleta
      if (!extraidos.nome && !extraidos.telefone && !extraidos.cpf && !status.completo) {
        const soNums = ctx.text.replace(/[\s.\-()]/g, '');
        const pareceNumero = /^\d{5,}$/.test(soNums);
        const palavrasComLetras = ctx.text.split(/\s+/).filter(p => /[a-zA-ZÀ-ÿ]/.test(p) && p.length >= 2);
        let msgFeedback = '';

        if (pareceNumero && !dadosMesclados.telefone) {
          msgFeedback = `Não reconheci esse número como WhatsApp. Me manda com DDD, assim: *43991415354* 😊`;
        } else if (pareceNumero && dadosMesclados.telefone && !dadosMesclados.cpf) {
          msgFeedback = `Esse número não parece um CPF válido. Pode verificar e tentar de novo? 😊`;
        } else if (palavrasComLetras.length === 1 && !dadosMesclados.nome) {
          msgFeedback = `Preciso do seu *nome completo* (nome e sobrenome). Pode me passar? 😊`;
        } else {
          // Catch-all: repete o próximo campo na ordem fixa nome → telefone → CPF
          if (!dadosMesclados.nome)          msgFeedback = `Me passa seu *nome completo* para eu finalizar o pedido. 😊`;
          else if (!dadosMesclados.telefone) msgFeedback = `Me passa seu *WhatsApp com DDD* (ex: *43991415354*). 😊`;
          else                               msgFeedback = `Me passa seu *CPF* para concluir a reserva. 😊`;
        }

        await saveChatMessage(ctx.sessionId, 'human', ctx.text);
        await sendText(ctx.remoteJid, msgFeedback);
        await saveChatMessage(ctx.sessionId, 'ai', msgFeedback);
        console.log(`[COLETA] Feedback: "${msgFeedback.slice(0, 60)}"`);
        return;
      }

      // CATCH-ALL: chegou até aqui com coleta incompleta — servidor SEMPRE responde,
      // nunca deixa passar para a IA durante a fase de fechamento
      if (!status.completo) {
        let msgProximo = '';
        if (!dadosMesclados.nome)          msgProximo = `Me passa seu *nome completo* para eu finalizar o pedido. 😊`;
        else if (!dadosMesclados.telefone) msgProximo = `Me passa seu *WhatsApp com DDD* (ex: *43991415354*). 😊`;
        else                               msgProximo = `Me passa seu *CPF* para concluir a reserva. 😊`;

        await saveChatMessage(ctx.sessionId, 'human', ctx.text);
        await sendText(ctx.remoteJid, msgProximo);
        await saveChatMessage(ctx.sessionId, 'ai', msgProximo);
        console.log(`[COLETA] Catch-all — próximo campo: ${!dadosMesclados.nome ? 'nome' : !dadosMesclados.telefone ? 'telefone' : 'CPF'}`);
        return;
      }

      // Recarrega sessão atualizada para o prompt (só chega aqui se coleta completa)
      sessao = await getSessao(ctx.sessionId);
    }

    // 3b. Fechamento detectado server-side — age conforme a situação
    if (querFechar && sessao.fase === 'fechamento') {
      await saveChatMessage(ctx.sessionId, 'human', ctx.text);

      if (!confirmouRevisao && sessao.boloes_confirmados.length > 0) {
        // Situação A: cliente quer parar → servidor envia revisão e encerra o turno
        const totalFech = sessao.boloes_confirmados.reduce((s, b) => s + Number(b.valor_cota), 0);
        const listaFech = sessao.boloes_confirmados
          .map(b => `• ${b.loteria} — R$ ${Number(b.valor_cota).toFixed(2).replace('.', ',')}`)
          .join('\n');
        const totalFmt = totalFech.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
        const msgRevisao = `Então ficamos com:\n\n${listaFech}\n\n💰 *Total: ${totalFmt}*\n\nPosso fechar? 😊`;

        await sendText(ctx.remoteJid, msgRevisao);
        await saveChatMessage(ctx.sessionId, 'ai', msgRevisao);
        console.log(`[FECHAMENTO] Revisão enviada server-side (Sit.A): ${sessao.boloes_confirmados.length} item(s)`);
        return;
      }

      // Situação B: cliente confirmou revisão da IA → passa para a IA pedir os dados
      // Injeta instrução antes de chamar a OpenAI (abaixo, no passo 4b)
      console.log(`[FECHAMENTO] Cliente confirmou revisão (Sit.B) — IA pedirá os dados`);
    }

    // Situação C: fase=fechamento vinda de turno anterior + cliente confirmou revisão
    // O servidor pede o nome diretamente — não passa pela IA (que confundia com "pedido fechado")
    if (confirmouRevisao && sessao.fase === 'fechamento' && !sessao.dados_cliente?.nome) {
      await saveChatMessage(ctx.sessionId, 'human', ctx.text);
      const msgNome = 'Ótimo! Para finalizar sua reserva, preciso de alguns dados. Qual é o seu *Nome Completo*? 😊';
      await sendText(ctx.remoteJid, msgNome);
      await saveChatMessage(ctx.sessionId, 'ai', msgNome);
      console.log(`[FECHAMENTO] Sit.C — servidor pediu nome após confirmação da revisão`);
      return;
    }

    // 4. Monta mensagens
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

    // 4b. Situação B confirmada — injeta instrução para a IA pedir os dados
    if (confirmouRevisao && sessao.fase === 'fechamento') {
      messages.push({
        role: 'system',
        content: `⚠️ FECHAMENTO CONFIRMADO. O cliente confirmou a revisão do carrinho. NÃO repita a revisão. Peça agora os dados necessários: Nome Completo, WhatsApp e CPF. Um dado por vez, de forma natural.`
      });
    }

    // Ação 1: confirmação de compra detectada server-side → injeta código correto obrigatoriamente
    if (clienteConfirmouCompra) {
      messages.push({
        role: 'system',
        content: `⚠️ SERVIDOR DETECTOU CONFIRMAÇÃO DE COMPRA. O cliente confirmou a cota do último bilhete mostrado. codigo_interno="${sessao.ultimo_bilhete_mostrado}". Sua ÚNICA ação agora é chamar confirmar_compra com codigo="${sessao.ultimo_bilhete_mostrado}" e frase_cliente="${ctx.text}". NÃO escreva nenhum texto antes disso. Instrução obrigatória do servidor — não pode ser ignorada.`
      });
      console.log(`[CONFIRMAÇÃO] Injeção server-side: código ${sessao.ultimo_bilhete_mostrado}`);
    }

    // 4c. Detecta seleção de número da lista (ex: "6", "o 6", "bolão 6", "quero o 6")
    // Se o cliente digitou um número que existe no mapa da última lista enviada,
    // injeta o código correto para a IA não precisar adivinhar
    const mapaLista = getMapaLista(ctx.sessionId);
    if (mapaLista && Object.keys(mapaLista).length > 0) {
      const matchNum = textoLower.match(/\b(\d+)\b/);
      if (matchNum && mapaLista[matchNum[1]]) {
        const codigoSelecionado = mapaLista[matchNum[1]];
        messages.push({
          role: 'system',
          content: `⚠️ CLIENTE ESCOLHEU DA LISTA: o número "${matchNum[1]}" corresponde ao bolão codigo_interno="${codigoSelecionado}". Chame mostrar_bilhete com codigo="${codigoSelecionado}" IMEDIATAMENTE. Não pergunte nada, não repita a lista.`
        });
        console.log(`[LISTA] Seleção detectada: posição ${matchNum[1]} → código ${codigoSelecionado}`);
      }
    }

    // 4d. Detecta menção de loteria sem chamar listar_jogos_loteria
    // Garante que a IA sempre chame a tool mesmo que queira responder em texto
    const mapaLoterias: Record<string, string> = {
      'mega': 'Mega-Sena', 'mega sena': 'Mega-Sena', 'megasena': 'Mega-Sena',
      'lotofacil': 'Lotofacil', 'lotofácil': 'Lotofacil',
      'quina': 'Quina',
      'dupla': 'Dupla Sena', 'dupla sena': 'Dupla Sena',
      'lotomania': 'Lotomania',
      'timemania': 'Timemania',
      'dia de sorte': 'Dia de Sorte',
      'super sete': 'Super Sete', 'supersete': 'Super Sete',
      'milionaria': 'Milionaria', 'milionária': 'Milionaria',
    };
    const fasePermiteListar = sessao.fase === 'venda' || sessao.fase === 'abertura' || sessao.fase === 'upsell' || sessao.fase === 'downsell';
    if (fasePermiteListar && !clienteConfirmouCompra) {
      for (const [chave, canonico] of Object.entries(mapaLoterias)) {
        if (textoLower.includes(chave)) {
          // Só injeta se a mensagem não é sobre outra coisa (ex: confirmação, fechar)
          const eNavegacao = !frasesFechar.some(f => textoLower.includes(f));
          if (eNavegacao) {
            messages.push({
              role: 'system',
              content: `⚠️ CLIENTE MENCIONOU LOTERIA: "${canonico}". Sua ÚNICA ação obrigatória é chamar listar_jogos_loteria com loteria="${canonico}". PROIBIDO responder em texto sem chamar esta tool primeiro.`
            });
            console.log(`[LOTERIA] Injeção server-side: cliente mencionou ${canonico}`);
            break;
          }
        }
      }
    }

    // 4e. Detecta pedido de múltiplas cotas — injeta instrução antes da OpenAI
    const pedidosMultiplos = detectarPedidoMultiplasCotas(ctx.text);
    if (pedidosMultiplos.length > 0) {
      const instrucoes = pedidosMultiplos.map(p =>
        `"${p.quantidade} cotas de ${p.loteria}" = o cliente quer escolher ${p.quantidade} bolões DIFERENTES de ${p.loteria}. PASSO OBRIGATÓRIO: chame listar_jogos_loteria com loteria="${p.loteria}" e pergunte quais ${p.quantidade} bolões da lista ele quer. Não confirme nada ainda.`
      ).join(' | ');
      messages.push({
        role: 'system',
        content: `⚠️ PEDIDO DE MÚLTIPLAS COTAS DETECTADO: ${instrucoes}`
      });
      console.log(`[MULTI-COTAS] Detectado: ${JSON.stringify(pedidosMultiplos)}`);
    }

    // 5. Chama OpenAI
    let response = await openai.chat.completions.create({
      model: MODEL,
      messages,
      tools: TOOLS,
      tool_choice: 'auto'
    });

    // 6. Tool calling loop
    let faseAnterior = sessao.fase;
    // Rastreia bilhetes enviados neste turno — impede duplicata na mesma mensagem
    const bilhetesEnviadosNessaTurno = new Set<string>();
    // Impede múltiplas confirmações no mesmo turno
    const confirmacaoFeitaNesseTurno = { feita: false };

    while (response.choices[0].finish_reason === 'tool_calls') {
      const assistantMsg = response.choices[0].message;
      messages.push(assistantMsg);

      const toolResults: any[] = [];
      for (const toolCall of assistantMsg.tool_calls!) {
        const tc = toolCall as any;
        const result = await executeTool(
          tc.function.name,
          JSON.parse(tc.function.arguments),
          ctx,
          acumulados,
          bilhetesEnviadosNessaTurno,
          confirmacaoFeitaNesseTurno
        );
        toolResults.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result
        });
      }

      messages.push(...toolResults);

      // Se o servidor enviou lista de bolões — retorna sem chamar OpenAI (evita double-send)
      const listaEnviada = toolResults.some(tr => {
        try { return JSON.parse(tr.content).lista_enviada === true; } catch { return false; }
      });
      if (listaEnviada) {
        await saveChatMessage(ctx.sessionId, 'ai', '[lista enviada pelo servidor]');
        console.log('[LISTA] Encerrando turno — lista já enviada pelo servidor, IA não responde');
        return;
      }

      // Se processar_comprovante foi chamada — servidor envia a resposta diretamente
      // A IA não gera nenhum texto — evita comentários sobre valor, divergências, etc.
      const comprovanteCall = assistantMsg.tool_calls?.find((tc: any) => tc.function.name === 'processar_comprovante');
      if (comprovanteCall) {
        const comprovanteResult = toolResults.find(tr => tr.tool_call_id === comprovanteCall.id);
        if (comprovanteResult) {
          try {
            const parsed = JSON.parse(comprovanteResult.content);
            const msgComprovante = parsed.sucesso
              ? 'Pagamento em análise. Por favor aguarde a confirmação! 🙏'
              : parsed.mensagem;
            await sendText(ctx.remoteJid, msgComprovante);
            await saveChatMessage(ctx.sessionId, 'ai', msgComprovante);
            console.log(`[COMPROVANTE] Resposta enviada pelo servidor: sucesso=${parsed.sucesso}`);
            if (parsed.sucesso) {
              // Comprovante aprovado → reseta sessão para que próxima mensagem seja nova conversa
              await resetarSessao(ctx.sessionId);
              console.log(`[COMPROVANTE] Sessão resetada — cliente pronto para nova compra`);
            }
            return;
          } catch {}
        }
      }

      // Verifica se a fase mudou para upsell/downsell após os tools
      const sessaoAtualizada = await getSessao(ctx.sessionId);
      if (sessaoAtualizada.fase !== faseAnterior &&
          (sessaoAtualizada.fase === 'upsell' || sessaoAtualizada.fase === 'downsell')) {

        // Extrai o bolão de upsell/downsell do resultado do confirmar_compra
        // para injetar o código exato no prompt — a IA não precisa adivinhar
        let bolaoProximo: any = null;
        for (const tr of toolResults) {
          try {
            const parsed = JSON.parse(tr.content);
            if (parsed.upsell) bolaoProximo = parsed.upsell;
            else if (parsed.downsell) bolaoProximo = parsed.downsell;
          } catch {}
        }

        let instrucao = '';
        if (sessaoAtualizada.fase === 'upsell' && bolaoProximo) {
          instrucao = `⚠️ FASE → UPSELL. PRÓXIMO PASSO OBRIGATÓRIO: ofereça o upsell em texto agora: "${bolaoProximo.nome} por ${bolaoProximo.valor}. Quer ver o bilhete? 📄". SE aceitar → mostrar_bilhete com codigo_interno="${bolaoProximo.codigo}". SE recusar → passe para downsell ou revisão. PROIBIDO enviar revisão ("Então ficamos com...") ANTES de o cliente recusar esta oferta.`;
        } else if (sessaoAtualizada.fase === 'downsell' && bolaoProximo) {
          instrucao = `⚠️ FASE → DOWNSELL. PRÓXIMO PASSO OBRIGATÓRIO: ofereça o downsell em texto agora: "Que tal garantir também um bolão de ${bolaoProximo.nome} por ${bolaoProximo.valor}? 🍀". SE aceitar → mostrar_bilhete com codigo_interno="${bolaoProximo.codigo}". SE recusar → ENTÃO envie a revisão e pergunte "Posso fechar?". PROIBIDO enviar revisão ("Então ficamos com...") ANTES de o cliente recusar esta oferta.`;
        } else {
          instrucao = sessaoAtualizada.fase === 'upsell'
            ? '⚠️ FASE → UPSELL. Ofereça o próximo bolão da mesma loteria ANTES de qualquer revisão. Revisão só após recusa.'
            : '⚠️ FASE → DOWNSELL. Ofereça um bolão de outra loteria disponível ANTES de qualquer revisão. Revisão só após recusa.';
        }

        messages.push({ role: 'system', content: instrucao });
        console.log(`[ERICA] Fase injetada no prompt: ${sessaoAtualizada.fase}`);
        faseAnterior = sessaoAtualizada.fase;
      }

      // Injeta o estado atualizado do carrinho após qualquer tool call que confirme bolões
      // Isso garante que a IA sempre use os valores reais do banco — nunca recalcule
      if (sessaoAtualizada.boloes_confirmados.length > 0) {
        const totalAtual = sessaoAtualizada.boloes_confirmados.reduce((s, b) => s + Number(b.valor_cota), 0);
        const listaAtual = sessaoAtualizada.boloes_confirmados.map(b =>
          `${b.loteria} R$${Number(b.valor_cota).toFixed(2).replace('.', ',')}`
        ).join(', ');
        messages.push({
          role: 'system',
          content: `📊 CARRINHO ATUAL: ${listaAtual}. Total = R$ ${totalAtual.toFixed(2).replace('.', ',')}. USE ESTES VALORES na revisão — não recalcule nem invente valores.`
        });
      }

      // Quando fase muda para fechamento — servidor envia a revisão do carrinho diretamente
      // A IA não escreve essa mensagem — vem 100% do banco, sem risco de alucinação
      if (sessaoAtualizada.fase === 'fechamento' && sessaoAtualizada.fase !== faseAnterior) {
        const totalFechamento = sessaoAtualizada.boloes_confirmados.reduce((s, b) => s + Number(b.valor_cota), 0);
        const listaFechamento = sessaoAtualizada.boloes_confirmados
          .map(b => `• ${b.loteria} — R$ ${Number(b.valor_cota).toFixed(2).replace('.', ',')}`)
          .join('\n');
        const totalFormatado = totalFechamento.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
        const msgRevisao = `Então ficamos com:\n\n${listaFechamento}\n\n💰 *Total: ${totalFormatado}*\n\nPosso fechar? 😊`;

        // Limpa dados_cliente ao entrar no fechamento — garante coleta fresca nesta transação
        sessaoAtualizada.dados_cliente = null;
        await saveSessao(sessaoAtualizada);

        await sendText(ctx.remoteJid, msgRevisao);
        await saveChatMessage(ctx.sessionId, 'ai', msgRevisao);
        console.log(`[FECHAMENTO] Revisão enviada pelo servidor: ${sessaoAtualizada.boloes_confirmados.length} item(s) | dados_cliente limpos`);

        // Instrui a IA: revisão já foi enviada, só aguarda confirmação do cliente
        messages.push({
          role: 'system',
          content: `⚠️ FASE → FECHAMENTO. A revisão do carrinho JÁ FOI ENVIADA pelo sistema com os valores exatos do banco. NÃO repita a revisão. Aguarde o cliente confirmar ("sim", "pode", "fecha", etc.) para pedir nome, WhatsApp e CPF.`
        });
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
