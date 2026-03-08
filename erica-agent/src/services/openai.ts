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
              text: 'Extraia todo o texto visível nesta imagem. Se for um comprovante PIX, identifique e destaque:\nNOME DO RECEBEDOR: [nome]\nCNPJ DO RECEBEDOR: [XX.XXX.XXX/XXXX-XX]\nVALOR: [R$ X,XX]\nDATA: [data]\nRetorne o texto completo da imagem sem omitir nada.'
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
