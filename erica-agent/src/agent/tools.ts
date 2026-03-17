export const TOOLS: any[] = [
  {
    type: 'function',
    function: {
      name: 'buscar_boloes',
      description: 'Busca todos os bolões disponíveis (hoje e próximos dias). Use no início da conversa e sempre que precisar listar opções. Não requer parâmetros.',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'listar_jogos_loteria',
      description: 'Envia ao cliente a lista COMPLETA de todos os bolões disponíveis de uma loteria específica. OBRIGATÓRIO chamar quando o cliente pedir para ver ou escolher uma loteria (ex: "pode ver a mega?", "quero ver a quina", "tem lotofácil?"). NUNCA liste bolões em texto livre — sempre chame esta tool para garantir que todos os bolões apareçam.',
      parameters: {
        type: 'object',
        properties: {
          loteria: { type: 'string', description: 'Nome da loteria exatamente como retornado por buscar_boloes. Ex: "Mega-Sena", "Quina", "Lotofacil", "Dupla Sena"' }
        },
        required: ['loteria']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mostrar_bilhete',
      description: 'Busca uma cota disponível e envia a imagem do bilhete ao cliente. Chame SEMPRE que o cliente quiser ver um bolão. O sistema gerencia a cota automaticamente.',
      parameters: {
        type: 'object',
        properties: {
          codigo: { type: 'string', description: 'Código único do bolão exatamente como retornado por buscar_boloes (ex: MegaSena-090326-0902). OBRIGATÓRIO para identificar o bolão correto.' },
          loteria: { type: 'string', description: 'Nome da loteria exatamente como retornado por buscar_boloes' },
          total_cotas: { type: 'number', description: 'Total de cotas do bolão retornado por buscar_boloes' },
          data_sorteio: { type: 'string', description: 'Data do sorteio YYYY-MM-DD' }
        },
        required: ['codigo', 'loteria', 'total_cotas', 'data_sorteio']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'confirmar_compra',
      description: 'Registra a compra de um bolão. REGRA ABSOLUTA: só chame após mostrar_bilhete deste bolão E o cliente usar palavra de confirmação explícita. OBRIGATÓRIO passar frase_cliente com o exato texto que o cliente enviou — o servidor valida se é confirmação real. Palavras válidas: "quero", "pode", "fico", "confirmo", "compra", "reserva", "fecha", "bora", "vai", "tô dentro". INVÁLIDAS: "gostei", "adorei", "legal", "interessante", "me mostra", "quero ver", "e o outro".',
      parameters: {
        type: 'object',
        properties: {
          codigo: { type: 'string', description: 'Código único do bolão exatamente como retornado por buscar_boloes (ex: MegaSena-090326-0902). OBRIGATÓRIO.' },
          loteria: { type: 'string', description: 'Nome da loteria confirmada' },
          total_cotas: { type: 'number', description: 'Total de cotas do bolão confirmado' },
          valor_cota: { type: 'number', description: 'Valor da cota em número (ex: 23.62)' },
          data_sorteio: { type: 'string', description: 'Data do sorteio YYYY-MM-DD' },
          frase_cliente: { type: 'string', description: 'Texto EXATO que o cliente enviou para confirmar a compra. Ex: "quero esse", "pode garantir", "sim". O servidor valida esta frase — se não contiver palavra de confirmação, a compra é bloqueada.' }
        },
        required: ['codigo', 'loteria', 'total_cotas', 'valor_cota', 'data_sorteio', 'frase_cliente']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ir_para_fechamento',
      description: 'Encerra a fase de vendas e inicia o fechamento. Chame IMEDIATAMENTE quando: (1) o cliente recusar upsell E downsell, (2) o cliente disser que não quer mais nada ("tá bom", "só isso", "chega", "pode fechar", "quero fechar"), (3) o cliente confirmar a revisão do carrinho. Após chamar esta tool o servidor envia a revisão do carrinho automaticamente — NÃO escreva a revisão você mesmo.',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'limpar_carrinho',
      description: 'Esvazia o carrinho do cliente removendo todos os bolões confirmados. Use quando o cliente pedir explicitamente para esvaziar, limpar ou cancelar o carrinho, ou quando quiser recomeçar a escolha. Não cancela nenhuma reserva no sistema (reservas só existem após o pagamento).',
      parameters: {
        type: 'object',
        properties: {
          motivo: { type: 'string', description: 'Motivo informado pelo cliente. Ex: "cliente pediu para limpar", "quer recomeçar"' }
        },
        required: ['motivo']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'processar_comprovante',
      description: 'Processa o comprovante PIX enviado pelo cliente. Use quando o cliente enviar o comprovante de pagamento.',
      parameters: {
        type: 'object',
        properties: {
          texto: { type: 'string', description: 'Texto do comprovante enviado pelo cliente' }
        },
        required: ['texto']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'solicitar_humano',
      description: 'Pausa a IA e chama um atendente humano. Use quando: (1) o cliente pedir explicitamente para falar com um atendente ou humano, (2) você estiver em loop sem conseguir resolver, (3) o cliente demonstrar frustração extrema. Após chamar esta tool, encerre a conversa com a mensagem retornada.',
      parameters: {
        type: 'object',
        properties: {
          motivo: { type: 'string', description: 'Motivo da intervenção: "cliente_solicitou", "loop_detectado" ou "cliente_frustrado"' }
        },
        required: ['motivo']
      }
    }
  }
];
