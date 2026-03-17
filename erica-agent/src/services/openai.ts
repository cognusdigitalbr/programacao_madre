import OpenAI from 'openai';
import * as dotenv from 'dotenv';
import { Readable } from 'stream';
dotenv.config();

export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!
});

export const MODEL = 'gpt-4o';

// Transcreve áudio (base64) usando Whisper
export async function transcribeAudio(base64: string, mimetype: string): Promise<string> {
  try {
    const buffer = Buffer.from(base64, 'base64');
    const ext = mimetype.includes('ogg') ? 'ogg' : mimetype.includes('mp4') ? 'mp4' : 'ogg';

    // OpenAI Whisper precisa de um File-like object
    const file = new File([buffer], `audio.${ext}`, { type: mimetype || 'audio/ogg' });

    const transcription = await openai.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      language: 'pt'
    });

    console.log(`[WHISPER] Transcrito: "${transcription.text}"`);
    return transcription.text;
  } catch (err: any) {
    console.error('[WHISPER] Erro:', err.message);
    return '';
  }
}

// Extrai dezenas de um bilhete de loteria (base64) usando GPT-4o Vision
export async function extractBilheteNumbers(base64: string, mimetype: string): Promise<{
  loteria: string;
  concurso: string | null;
  total_cotas: number | null;
  valor_cota: number | null;
  jogos: string[][];
} | null> {
  try {
    const mediaType = mimetype.includes('png') ? 'image/png' : 'image/jpeg';
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:${mediaType};base64,${base64}` }
            },
            {
              type: 'text',
              text: `Analise este bilhete de loteria e extraia TODOS os jogos visíveis.
Retorne APENAS o JSON puro, sem markdown, sem explicações, no formato exato:
{
  "loteria": "Mega-Sena",
  "concurso": "2959",
  "total_cotas": 12,
  "valor_cota": 17.50,
  "jogos": [
    ["09","11","19","21","24","26","28"],
    ["03","07","16","28","35","54","57"],
    ["02","16","29","37","40","41","59"],
    ["15","29","30","37","44","58","60"],
    ["01","17","27","32","41","43","54"]
  ]
}
Regras obrigatórias:
- Extraia TODOS os jogos do bilhete, sem excluir nenhum (pode haver de 1 a 10 jogos)
- Cada jogo está identificado por uma letra (A, B, C, D, E...) ou número
- Cada dezena deve ser string com 2 dígitos (ex: "09" não "9")
- Ordene as dezenas de cada jogo em ordem crescente
- NUNCA misture números de jogos diferentes
- loteria: nome exato (Mega-Sena, Lotofácil, Quina, Dupla Sena, etc.)
- concurso: número do concurso como string, ou null
- total_cotas: número inteiro de cotas do bolão, ou null
- valor_cota: valor numérico em reais de cada cota (ex: 17.50), ou null se não encontrar`
            }
          ]
        }
      ],
      max_tokens: 2000
    });

    const texto = response.choices[0].message.content || '';
    console.log(`[BILHETE] Resposta Vision: "${texto.slice(0, 400)}"`);

    // Extrai o JSON da resposta (remove possível markdown ```json ... ```)
    const jsonMatch = texto.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn('[BILHETE] JSON não encontrado na resposta');
      return null;
    }

    const resultado = JSON.parse(jsonMatch[0]);
    console.log(`[BILHETE] Extraídos ${resultado.jogos?.length || 0} jogos de ${resultado.loteria}`);
    return resultado;
  } catch (err: any) {
    console.error('[BILHETE] Erro:', err.message);
    return null;
  }
}

// Extrai texto de uma imagem (base64) usando GPT-4o Vision
export async function extractImageText(base64: string, mimetype: string): Promise<string> {
  try {
    const mediaType = mimetype.includes('png') ? 'image/png' : 'image/jpeg';
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:${mediaType};base64,${base64}` }
            },
            {
              type: 'text',
              text: 'Extraia todo o texto visível nesta imagem. Se for um comprovante PIX, identifique e destaque:\nNOME DO RECEBEDOR: [nome]\nCNPJ DO RECEBEDOR: [XX.XXX.XXX/XXXX-XX]\nDATA: [data]\nRetorne o texto completo da imagem sem omitir nada. NÃO destaque nem mencione o valor pago.'
            }
          ]
        }
      ],
      max_tokens: 1500
    });

    const texto = response.choices[0].message.content || '';
    console.log(`[VISION] Texto extraído: "${texto.slice(0, 100)}"`);
    return texto;
  } catch (err: any) {
    console.error('[VISION] Erro:', err.message);
    return '';
  }
}
