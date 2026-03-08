export interface MessageContext {
  phone: string;       // ex: 5543991415354
  remoteJid: string;   // ex: 5543991415354@s.whatsapp.net
  name: string;        // nome do WhatsApp
  text: string;        // mensagem do cliente
  sessionId: string;   // remoteJid (chave da sessão)
  mediaType?: 'text' | 'image' | 'audio' | 'document';
  mediaUrl?: string;
}

export interface Bolao {
  nome: string;
  cotas: number;
  valor: string;
  valor_numero: number;
  data_sorteio: string;
  codigo: string;
  quantidade_jogos: number;
  jogos: string[][];   // dezenas de cada jogo ex: [["01","09","36"], ["02","10","28"]]
  status: string;
}

export interface CotaSelecionada {
  cota_id: string;
  bolao_id: string;
  numero: number;
  loteria: string;
  total_cotas: number;
  data_sorteio: string;
  valor_cota: number;
}

export interface BolaoConfirmado {
  loteria: string;
  total_cotas: number;
  valor_cota: number;
  data_sorteio: string;
  cota_numero: number;
  cota_id: string;
  bolao_id: string;
}

export interface DadosCliente {
  nome: string;
  cpf: string;
  telefone: string;
}

export interface SessaoErica {
  session_id: string;
  fase: 'abertura' | 'venda' | 'upsell' | 'downsell' | 'fechamento' | 'aguardando_pagamento';
  cota_selecionada: CotaSelecionada | null;
  boloes_confirmados: BolaoConfirmado[];
  boloes_oferecidos: string[];
  boloes_disponiveis: Bolao[];
  dados_cliente: DadosCliente | null;
  pedidos_ids: string[];
  ultima_atividade: string;
}
