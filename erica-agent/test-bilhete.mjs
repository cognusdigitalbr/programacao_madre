/**
 * Teste do endpoint /api/extrair-bilhete
 * Uso: node test-bilhete.mjs [caminho-da-imagem]
 * Exemplo: node test-bilhete.mjs C:/Users/REMAKKER/Downloads/mega-senha2501-1.png
 */

import fs from 'fs';
import path from 'path';

const imagemPath = process.argv[2] || 'C:/Users/REMAKKER/Downloads/mega-senha2501-1.png';
const endpoint = process.argv[3] || 'http://localhost:3000/api/extrair-bilhete';
const loteríaEsperada = process.argv[4] || null;

console.log(`\n📸 Testando extração de bilhete`);
console.log(`   Imagem: ${imagemPath}`);
console.log(`   Endpoint: ${endpoint}\n`);

try {
  // Lê a imagem e converte para base64
  const imageBuffer = fs.readFileSync(imagemPath);
  const base64 = imageBuffer.toString('base64');
  const ext = path.extname(imagemPath).toLowerCase();
  const mimetype = ext === '.png' ? 'image/png' : 'image/jpeg';

  console.log(`   Tamanho: ${(imageBuffer.length / 1024).toFixed(1)} KB`);
  console.log(`   Tipo: ${mimetype}\n`);

  // Chama o endpoint
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base64, mimetype, ...(loteríaEsperada ? { loteria_esperada: loteríaEsperada } : {}) })
  });

  const resultado = await response.json();

  if (resultado.divergente) {
    console.warn('\n⚠️  DIVERGÊNCIA DETECTADA!');
    console.warn(`   Loteria esperada: ${resultado.loteria_esperada}`);
    console.warn(`   Loteria do bilhete: ${resultado.loteria_bilhete}`);
    console.warn(`   Mensagem: ${resultado.mensagem}`);
    process.exit(1);
  }

  if (!resultado.sucesso) {
    console.error('❌ Falhou:', resultado.mensagem);
    process.exit(1);
  }

  console.log('✅ Sucesso!\n');
  console.log(`🎰 Loteria: ${resultado.loteria}`);
  console.log(`🔢 Concurso: ${resultado.concurso || 'não identificado'}`);
  console.log(`🎫 Total de Cotas: ${resultado.total_cotas || 'não identificado'}`);
  console.log(`🎯 Jogos extraídos: ${resultado.jogos.length}\n`);

  resultado.jogos.forEach((jogo, i) => {
    const letra = String.fromCharCode(65 + i); // A, B, C...
    console.log(`   Jogo ${letra}: ${jogo.join(' - ')}`);
  });

  console.log('\n📋 JSON completo:');
  console.log(JSON.stringify(resultado, null, 2));

} catch (err) {
  console.error('❌ Erro:', err.message);
  if (err.code === 'ECONNREFUSED') {
    console.log('\n💡 O servidor não está rodando localmente.');
    console.log('   Para testar na VPS, use:');
    console.log('   node test-bilhete.mjs [imagem] https://api.dev.lotericamadreia.com/api/extrair-bilhete');
  }
  process.exit(1);
}
