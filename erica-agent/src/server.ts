import express from 'express';
import * as dotenv from 'dotenv';
dotenv.config();

import { runErica } from './agent/erica';
import { getLead_IA, upsertLead } from './services/supabase';
import { resetarSessao } from './services/session';
import { clearChatHistory } from './services/supabase';
import { downloadMedia } from './services/whatsapp';
import { transcribeAudio, extractImageText, extractBilheteNumbers } from './services/openai';
import { toolBuscarBoloes } from './tools/boloes';
import type { MessageContext } from './types';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse');

const app = express();
app.use(express.json({ limit: '10mb' }));

// Libera CORS para o painel admin (Lovable e outros frontends)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
    return;
  }
  next();
});

const PORT = process.env.PORT || 3000;

// ─── WEBHOOK PRINCIPAL ────────────────────────────────────────────────────────

app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // responde imediatamente para Evolution API

  try {
    const body = req.body;

    // Log completo para debug
    console.log('[WEBHOOK] Recebido:', JSON.stringify(body).slice(0, 500));

    // Filtra apenas mensagens recebidas (não enviadas pelo bot)
    if (body?.data?.key?.fromMe) return;
    if (body?.event !== 'messages.upsert') {
      console.log('[WEBHOOK] Evento ignorado:', body?.event);
      return;
    }

    const data = body.data;
    const key = data?.key;
    const message = data?.message;

    if (!key || !message) return;

    // Suporte a LID (novo modo de endereçamento do WhatsApp)
    let remoteJid: string = key.remoteJid;
    if (remoteJid?.includes('@lid') && key.remoteJidAlt) {
      remoteJid = key.remoteJidAlt;
    }
    if (!remoteJid || remoteJid.includes('@lid')) return;

    // Extrai telefone
    const phone = remoteJid.split('@')[0];
    const name: string = data?.pushName || phone;

    // Extrai texto da mensagem
    let text = '';
    let mediaType: MessageContext['mediaType'] = 'text';

    // Extrai contexto de reply (quando o cliente arrasta uma mensagem para responder)
    // Presente em extendedTextMessage e imageMessage quando é uma resposta
    function extrairContextoReply(contextInfo: any): string {
      if (!contextInfo) return '';
      const quoted = contextInfo.quotedMessage;
      if (!quoted) return '';
      // Pega o texto da mensagem citada (pode ser texto simples ou extendedText)
      const textoQuotado = quoted.conversation
        || quoted.extendedTextMessage?.text
        || quoted.imageMessage?.caption
        || '';
      if (!textoQuotado) return '';
      return `[RESPONDENDO À MENSAGEM: "${textoQuotado}"] `;
    }

    if (message.conversation) {
      text = message.conversation;
    } else if (message.extendedTextMessage?.text) {
      // Inclui contexto do reply se houver
      const prefixoReply = extrairContextoReply(message.extendedTextMessage.contextInfo);
      text = prefixoReply + message.extendedTextMessage.text;
    } else if (message.audioMessage) {
      mediaType = 'audio';
      console.log(`[SERVER] Áudio recebido — transcrevendo...`);
      const media = await downloadMedia(data);
      if (media) {
        text = await transcribeAudio(media.base64, media.mimetype);
        if (!text) text = '[áudio não transcrito]';
        console.log(`[SERVER] Transcrição: "${text}"`);
      } else {
        text = '[áudio]';
      }
    } else if (message.imageMessage) {
      mediaType = 'image';
      const caption = message.imageMessage.caption || '';
      // Inclui contexto do reply se o cliente arrastou uma mensagem para responder com imagem
      const prefixoReply = extrairContextoReply(message.imageMessage.contextInfo);
      console.log(`[SERVER] Imagem recebida${prefixoReply ? ' (reply)' : ''} — extraindo texto...`);

      // webhookBase64: true — Evolution API já envia base64 direto no payload
      const base64Direto: string | undefined = data.message?.base64 || data.base64;
      const mimetypeDireto: string = data.message?.mimetype || message.imageMessage?.mimetype || 'image/jpeg';

      let mediaBase64: string | null = null;
      let mediaMimetype: string = mimetypeDireto;

      if (base64Direto) {
        console.log(`[SERVER] Base64 recebido direto no payload (webhookBase64)`);
        mediaBase64 = base64Direto;
      } else {
        // Fallback: tenta download via API
        const dataParaDownload = { ...data, key: { ...data.key, remoteJid } };
        const media = await downloadMedia(dataParaDownload);
        if (media) {
          mediaBase64 = media.base64;
          mediaMimetype = media.mimetype;
        }
      }

      if (mediaBase64) {
        const extraido = await extractImageText(mediaBase64, mediaMimetype);
        // Monta o texto com contexto do reply (se houver) + conteúdo da imagem
        const conteudoImagem = extraido || caption || '[imagem sem texto legível]';
        text = prefixoReply + conteudoImagem;
      } else {
        const conteudoImagem = caption || '[imagem não processada — cliente deve reenviar o comprovante como texto ou nova imagem]';
        text = prefixoReply + conteudoImagem;
        console.log(`[SERVER] Imagem não processada — sem base64 disponível`);
      }
    } else if (message.documentMessage) {
      const nomeArquivo = message.documentMessage.fileName || '';
      const mimetypeDoc = message.documentMessage.mimetype || '';
      const captionDoc = message.documentMessage.caption || '';
      mediaType = 'document';
      console.log(`[SERVER] Documento recebido: ${nomeArquivo} (${mimetypeDoc})`);

      // Tenta extrair texto do PDF para processar como comprovante
      const ehPdf = mimetypeDoc.includes('pdf') || nomeArquivo.toLowerCase().endsWith('.pdf');
      if (ehPdf) {
        try {
          // Tenta base64 direto no payload primeiro (webhookBase64), depois baixa
          const base64Direto: string | undefined = data.message?.base64 || data.base64;
          let pdfBase64: string | null = base64Direto || null;

          if (!pdfBase64) {
            const media = await downloadMedia(data);
            pdfBase64 = media?.base64 || null;
          } else {
            console.log(`[SERVER] PDF base64 recebido direto no payload`);
          }

          if (pdfBase64) {
            const buffer = Buffer.from(pdfBase64, 'base64');
            const resultado = await pdfParse(buffer);
            const textoPdf = resultado.text?.trim();
            if (textoPdf && textoPdf.length > 20) {
              text = textoPdf;
              console.log(`[SERVER] PDF extraído: ${textoPdf.length} chars`);
            } else {
              text = `[documento PDF sem texto legível: ${nomeArquivo}]`;
            }
          } else {
            text = `[documento PDF não baixado: ${nomeArquivo}]`;
          }
        } catch (errPdf: any) {
          console.error(`[SERVER] Erro ao ler PDF: ${errPdf.message}`);
          text = `[documento PDF com erro: ${nomeArquivo}]`;
        }
      } else {
        // Documento não-PDF (ex: Word, Excel) — não conseguimos processar
        text = `[documento recebido: ${nomeArquivo || 'arquivo'}${captionDoc ? ' — ' + captionDoc : ''}]`;
      }
    }

    if (!text) return;

    const sessionId = remoteJid;

    // Verifica se IA está pausada
    const statusIA = await getLead_IA(phone);
    if (statusIA === 'pause') {
      console.log(`[SERVER] IA pausada para ${phone}`);
      return;
    }

    // Upsert lead
    await upsertLead(phone, name);

    // Comando para resetar conversa (limpa sessão + histórico)
    if (text.toLowerCase().includes('!resetar') || text.toLowerCase().includes('#reset')) {
      await Promise.all([
        resetarSessao(sessionId),
        clearChatHistory(sessionId)
      ]);
      console.log(`[SERVER] Sessão e histórico resetados para ${phone}`);
      return;
    }

    const ctx: MessageContext = {
      phone,
      remoteJid,
      name,
      text,
      sessionId,
      mediaType
    };

    await runErica(ctx);

  } catch (err: any) {
    console.error('[SERVER] Erro no webhook:', err.message);
  }
});

// ─── EXTRAIR DEZENAS DO BILHETE (para o painel admin) ─────────────────────────

app.post('/api/extrair-bilhete', async (req, res) => {
  try {
    const { base64, mimetype, loteria_esperada } = req.body;

    if (!base64) {
      res.status(400).json({ sucesso: false, mensagem: 'base64 é obrigatório' });
      return;
    }

    console.log('[BILHETE] Processando imagem...');
    const resultado = await extractBilheteNumbers(base64, mimetype || 'image/jpeg');

    if (!resultado) {
      res.status(422).json({ sucesso: false, mensagem: 'Não foi possível extrair os jogos da imagem.' });
      return;
    }

    // Trava de divergência: verifica se o bilhete é da loteria selecionada
    if (loteria_esperada) {
      const loteríaBilhete = resultado.loteria.toLowerCase().replace(/[-\s]/g, '');
      const loteríaEsperada = loteria_esperada.toLowerCase().replace(/[-\s]/g, '');

      if (!loteríaBilhete.includes(loteríaEsperada) && !loteríaEsperada.includes(loteríaBilhete)) {
        console.warn(`[BILHETE] Divergência: esperado "${loteria_esperada}", bilhete é "${resultado.loteria}"`);
        res.json({
          sucesso: false,
          divergente: true,
          loteria_bilhete: resultado.loteria,
          loteria_esperada,
          mensagem: `⚠️ Bilhete divergente! Você selecionou ${loteria_esperada} mas o bilhete enviado é de ${resultado.loteria}. Verifique e reenvie.`
        });
        return;
      }
    }

    console.log(`[BILHETE] OK — ${resultado.loteria}, ${resultado.jogos.length} jogos, valor cota: R$${resultado.valor_cota}`);
    res.json({ sucesso: true, divergente: false, ...resultado });
  } catch (err: any) {
    console.error('[BILHETE] Erro no endpoint:', err.message);
    res.status(500).json({ sucesso: false, mensagem: 'Erro interno ao processar imagem.' });
  }
});

// ─── BOLÕES DISPONÍVEIS (para monitoramento e painel) ─────────────────────────

app.get('/api/boloes-disponiveis', async (req, res) => {
  try {
    const boloes = await toolBuscarBoloes();
    // Agrupa por data de sorteio para facilitar leitura
    const porData: Record<string, any[]> = {};
    for (const b of boloes) {
      if (!porData[b.data_sorteio]) porData[b.data_sorteio] = [];
      porData[b.data_sorteio].push({ nome: b.nome, cotas: b.cotas, valor: b.valor, codigo: b.codigo });
    }
    res.json({ sucesso: true, total: boloes.length, por_data: porData });
  } catch (err: any) {
    res.status(500).json({ sucesso: false, mensagem: err.message });
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ status: 'ok', agent: 'Érica — Lotérica da Madre', model: 'gpt-4o' });
});

// ─── START ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[SERVER] Érica rodando na porta ${PORT}`);
  console.log(`[SERVER] Modelo: gpt-4o`);
  console.log(`[SERVER] Webhook: POST /webhook`);
});
