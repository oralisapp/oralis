/** Aceita apenas caminhos internos como destino de retorno, evitando redirecionamento aberto. */
export function safeReturn(path: string | null, fallback = '/app/visao-geral'): string {
  return path && path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/\\') ? path : fallback;
}
